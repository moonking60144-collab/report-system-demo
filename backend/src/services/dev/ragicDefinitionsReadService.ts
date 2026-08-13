import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  findExistingDefinitionsRoot,
  findRepoRoot,
  normalizeDefinitionsPathspec,
} from "./ragicDefinitionsPaths";
import {
  createRagicDefinitionsSnapshotService,
  readCurrentRagicDefinitionsSnapshotPublication,
  type LoadedRagicDefinitionsSnapshot,
  type MaterializedRagicDefinitionsSnapshot,
} from "./ragicDefinitionsSnapshotService";
import { withDefinitionsReadLock } from "./ragicDefinitionsIoLock";
import type {
  RagicDefinitionManifest,
  RagicDefinitionGitStatus,
  RagicDefinitionsState,
  RagicDefinitionForm,
  RagicDefinitionField,
  RagicDefinitionFormula,
  RagicDefinitionWorkflow,
  RagicDefinitionFormDetail,
  RagicDefinitionFieldReference,
  RagicDefinitionSearchType,
  RagicDefinitionSearchItem,
} from "@shared-types/ragicDefinitions";

export type {
  RagicDefinitionManifest,
  RagicDefinitionGitStatus,
  RagicDefinitionsState,
  RagicDefinitionForm,
  RagicDefinitionField,
  RagicDefinitionFormula,
  RagicDefinitionWorkflow,
  RagicDefinitionFormDetail,
  RagicDefinitionFieldReference,
  RagicDefinitionSearchType,
  RagicDefinitionSearchItem,
};

const execFileAsync = promisify(execFile);

export interface RagicDefinitionsReadServiceOptions {
  definitionsRoot?: string;
  repoRoot?: string;
  cacheTtlMs?: number;
  snapshotRoot?: string;
  snapshotRetainCount?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface SnapshotDescriptorCacheEntry {
  manifestFingerprint: string;
  value: RagicDefinitionsState["snapshot"];
}

function isValidFormPath(formPath: string): boolean {
  const parts = formPath.split("/");
  return (
    parts.length >= 3 &&
    parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  );
}

function formDir(root: string, formPath: string): string {
  if (!isValidFormPath(formPath)) {
    throw new Error("BAD_FORM_PATH");
  }
  return join(root, "forms", ...formPath.split("/"));
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

function matchesQuery(values: Array<string | null | undefined>, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return values.some((value) => String(value ?? "").toLowerCase().includes(needle));
}

function matchesDefinitionQuery(
  values: Array<string | null | undefined>,
  q: string
): boolean {
  if (matchesQuery(values, q)) return true;
  const haystack = q.toLowerCase();
  return values.some((value) => {
    const candidate = String(value ?? "").trim().toLowerCase();
    return candidate.length >= 2 && haystack.includes(candidate);
  });
}

function workflowMatch(
  workflow: RagicDefinitionWorkflow,
  q: string,
  fieldId: string
): { sourceLine: number; excerpt: string } | null {
  const needle = (fieldId || q).trim().toLowerCase();
  if (!needle) {
    return {
      sourceLine: 1,
      excerpt: workflow.content.slice(0, 800),
    };
  }
  const content = workflow.content.toLowerCase();
  const contentIndex = content.indexOf(needle);
  const metadataMatched = matchesDefinitionQuery(
    [workflow.scope, workflow.fileName],
    needle
  );
  if (contentIndex < 0 && !metadataMatched) return null;
  const matchIndex = Math.max(0, contentIndex);
  const excerptStart = Math.max(0, matchIndex - 240);
  const excerptEnd = Math.min(workflow.content.length, matchIndex + needle.length + 560);
  return {
    sourceLine: workflow.content.slice(0, matchIndex).split(/\r?\n/).length,
    excerpt: workflow.content.slice(excerptStart, excerptEnd),
  };
}

function workflowScope(fileName: string): string {
  return fileName.replace(/\.js$/i, "");
}

function linkedSourceFormPath(currentFormPath: string, mvp: string): string | null {
  const [rawPath, rawForm] = mvp.split("|", 2);
  const namespace = currentFormPath.split("/")[0] ?? "";
  const pathParts = rawPath.split("/").filter(Boolean);
  const formId = rawForm?.split("_", 1)[0]?.trim() ?? "";
  const candidate = [namespace, ...pathParts, formId].filter(Boolean).join("/");
  return isValidFormPath(candidate) ? candidate : null;
}

export function createRagicDefinitionsReadService(
  options: RagicDefinitionsReadServiceOptions = {}
) {
  const definitionsRoot = resolve(options.definitionsRoot ?? findExistingDefinitionsRoot());
  const repoRoot = resolve(options.repoRoot ?? findRepoRoot(definitionsRoot));
  const definitionsPathspec = normalizeDefinitionsPathspec(repoRoot, definitionsRoot);
  const cacheTtlMs = Math.max(0, Math.trunc(options.cacheTtlMs ?? 5000));
  let formFilesCache: CacheEntry<string[]> | null = null;
  let formsCache: CacheEntry<RagicDefinitionForm[]> | null = null;
  let snapshotDescriptorCache: SnapshotDescriptorCacheEntry | null = null;
  let currentSnapshotLoadInFlight: Promise<LoadedRagicDefinitionsSnapshot> | null =
    null;
  const formDetailCache = new Map<string, CacheEntry<RagicDefinitionFormDetail>>();
  const snapshotService = createRagicDefinitionsSnapshotService({
    definitionsRoot,
    snapshotRoot: options.snapshotRoot,
    retainCount: options.snapshotRetainCount,
  });

  function isFresh<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
    return Boolean(entry && entry.expiresAt > Date.now());
  }

  function cacheEntry<T>(value: T): CacheEntry<T> {
    return { value, expiresAt: Date.now() + cacheTtlMs };
  }

  function invalidateCache(): void {
    formFilesCache = null;
    formsCache = null;
    snapshotDescriptorCache = null;
    formDetailCache.clear();
  }

  function getSnapshotDescriptorUnlocked(): RagicDefinitionsState["snapshot"] {
    const publication = readCurrentRagicDefinitionsSnapshotPublication(
      definitionsRoot
    );
    if (!publication) {
      snapshotDescriptorCache = null;
      return null;
    }
    if (
      snapshotDescriptorCache?.manifestFingerprint ===
      publication.manifestFingerprint
    ) {
      return snapshotDescriptorCache.value;
    }
    snapshotDescriptorCache = {
      manifestFingerprint: publication.manifestFingerprint,
      value: publication.descriptor,
    };
    return publication.descriptor;
  }

  async function getSnapshotDescriptor(): Promise<RagicDefinitionsState["snapshot"]> {
    return withDefinitionsReadLock(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const descriptor = getSnapshotDescriptorUnlocked();
          if (descriptor || attempt === 2) return descriptor;
        } catch (error) {
          snapshotDescriptorCache = null;
          if (attempt === 2) throw error;
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
      }
      return null;
    });
  }

  function withCurrentPublishedAt(
    artifact: MaterializedRagicDefinitionsSnapshot,
    publishedAt: string | null
  ): MaterializedRagicDefinitionsSnapshot {
    return {
      ...artifact,
      descriptor: {
        ...artifact.descriptor,
        publishedAt,
      },
    };
  }

  async function openCurrentSnapshot(): Promise<MaterializedRagicDefinitionsSnapshot> {
    return withCurrentSnapshot(async (artifact) => artifact);
  }

  async function loadCurrentSnapshotInternal(): Promise<LoadedRagicDefinitionsSnapshot> {
    return withDefinitionsReadLock(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const descriptor = getSnapshotDescriptorUnlocked();
          if (!descriptor) {
            if (attempt < 2) {
              await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
              continue;
            }
            throw new Error("RAGIC_DEFINITIONS_SNAPSHOT_NOT_AVAILABLE");
          }
          let loaded = await snapshotService.loadVerified(descriptor.revision);
          if (!loaded) {
            loaded = await snapshotService.materializeCurrentAsync();
          }
          snapshotDescriptorCache = null;
          const current = getSnapshotDescriptorUnlocked();
          if (loaded && current?.revision === loaded.descriptor.revision) {
            return {
              ...loaded,
              descriptor: {
                ...loaded.descriptor,
                publishedAt: current.publishedAt,
              },
            };
          }
        } catch (error) {
          snapshotDescriptorCache = null;
          if (attempt === 2) throw error;
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
      }
      throw new Error("RAGIC_DEFINITIONS_PUBLICATION_CHANGED");
    });
  }

  function loadCurrentSnapshot(): Promise<LoadedRagicDefinitionsSnapshot> {
    if (currentSnapshotLoadInFlight) return currentSnapshotLoadInFlight;
    const tracked = loadCurrentSnapshotInternal().finally(() => {
      if (currentSnapshotLoadInFlight === tracked) {
        currentSnapshotLoadInFlight = null;
      }
    });
    currentSnapshotLoadInFlight = tracked;
    return tracked;
  }

  async function withCurrentSnapshot<T>(
    consume: (artifact: MaterializedRagicDefinitionsSnapshot) => Promise<T>
  ): Promise<T> {
    return withDefinitionsReadLock(async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const descriptor = getSnapshotDescriptorUnlocked();
          if (descriptor) {
            const existing = snapshotService.open(descriptor.revision);
            if (existing) {
              return consume(
                withCurrentPublishedAt(existing, descriptor.publishedAt)
              );
            }
            const materialized = snapshotService.materializeCurrent();
            snapshotDescriptorCache = null;
            const current = getSnapshotDescriptorUnlocked();
            if (current?.revision === materialized.descriptor.revision) {
              return consume(
                withCurrentPublishedAt(materialized, current.publishedAt)
              );
            }
          }
        } catch (error) {
          snapshotDescriptorCache = null;
          if (attempt === 2) throw error;
        }
        if (attempt < 2) {
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
        }
      }
      throw new Error("RAGIC_DEFINITIONS_PUBLICATION_CHANGED");
    });
  }

  async function listSnapshots() {
    return withDefinitionsReadLock(async () => snapshotService.listVerified());
  }

  async function getSnapshotHistoryDescriptor(revision: string) {
    return withDefinitionsReadLock(async () => snapshotService.describe(revision));
  }

  async function openSnapshot(
    revision: string
  ): Promise<MaterializedRagicDefinitionsSnapshot | null> {
    return withSnapshot(revision, async (artifact) => artifact);
  }

  async function loadSnapshot(revision: string) {
    return withDefinitionsReadLock(async () =>
      snapshotService.loadVerified(revision)
    );
  }

  async function withSnapshot<T>(
    revision: string,
    consume: (artifact: MaterializedRagicDefinitionsSnapshot | null) => Promise<T>
  ): Promise<T> {
    return withDefinitionsReadLock(async () =>
      consume(snapshotService.open(revision))
    );
  }

  async function readManifest(): Promise<RagicDefinitionManifest | null> {
    const path = join(definitionsRoot, "manifest.json");
    if (!existsSync(path)) return null;
    return readJson<RagicDefinitionManifest>(path);
  }

  async function getGitStatus(): Promise<RagicDefinitionGitStatus> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["status", "--short", "--", definitionsPathspec],
        { cwd: repoRoot, timeout: 5000 }
      );
      const entries = stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean);
      return { available: true, clean: entries.length === 0, entries, error: null };
    } catch (error) {
      return {
        available: false,
        clean: false,
        entries: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function getStateUnlocked(): Promise<RagicDefinitionsState> {
    return {
      definitionsRoot,
      exists: existsSync(definitionsRoot),
      manifest: await readManifest(),
      snapshot: getSnapshotDescriptorUnlocked(),
      gitStatus: await getGitStatus(),
    };
  }

  async function getState(): Promise<RagicDefinitionsState> {
    return withDefinitionsReadLock(getStateUnlocked);
  }

  async function walkFormJsonFiles(): Promise<string[]> {
    if (cacheTtlMs > 0 && isFresh(formFilesCache)) return formFilesCache.value;
    const formsRoot = join(definitionsRoot, "forms");
    if (!existsSync(formsRoot)) return [];
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name === "form.json") {
          out.push(full);
        }
      }
    };
    await walk(formsRoot);
    const files = out.sort();
    if (cacheTtlMs > 0) formFilesCache = cacheEntry(files);
    return files;
  }

  async function readAllForms(): Promise<RagicDefinitionForm[]> {
    if (cacheTtlMs > 0 && isFresh(formsCache)) return formsCache.value;
    const forms = await Promise.all(
      (await walkFormJsonFiles()).map((file) => readJson<RagicDefinitionForm>(file))
    );
    if (cacheTtlMs > 0) formsCache = cacheEntry(forms);
    return forms;
  }

  async function listFormsUnlocked(params: { q?: string; limit?: number } = {}) {
    const q = params.q?.trim() ?? "";
    const limit = Math.max(1, Math.trunc(params.limit ?? 200));
    const allForms = await readAllForms();
    const data: RagicDefinitionForm[] = [];
    for (const form of allForms) {
      if (!matchesQuery([form.formPath, form.formName, form.nuiFile], q)) continue;
      data.push(form);
      if (data.length > limit) break;
    }
    const truncated = data.length > limit;
    return {
      data: truncated ? data.slice(0, limit) : data,
      meta: { count: Math.min(data.length, limit), limit, truncated, q },
    };
  }

  async function listForms(params: { q?: string; limit?: number } = {}) {
    return withDefinitionsReadLock(() => listFormsUnlocked(params));
  }

  async function readFormUnlocked(formPath: string): Promise<RagicDefinitionFormDetail> {
    const cached = formDetailCache.get(formPath);
    if (cacheTtlMs > 0 && cached && isFresh(cached)) return cached.value;
    const dir = formDir(definitionsRoot, formPath);
    const form = await readJson<RagicDefinitionForm>(join(dir, "form.json"));
    const fields = await readJson<RagicDefinitionField[]>(join(dir, "fields.json"));
    const formulas = await readJson<RagicDefinitionFormula[]>(join(dir, "formulas.json"));
    const workflowDir = join(dir, "workflows");
    const workflows: RagicDefinitionWorkflow[] = [];
    if (existsSync(workflowDir) && (await stat(workflowDir)).isDirectory()) {
      for (const entry of (await readdir(workflowDir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
        const content = await readFile(join(workflowDir, entry.name), "utf-8");
        workflows.push({
          scope: workflowScope(entry.name),
          fileName: entry.name,
          content,
          charCount: content.length,
        });
      }
    }
    const detail = { form, fields, formulas, workflows };
    if (cacheTtlMs > 0) formDetailCache.set(formPath, cacheEntry(detail));
    return detail;
  }

  async function readForm(formPath: string): Promise<RagicDefinitionFormDetail> {
    return withDefinitionsReadLock(() => readFormUnlocked(formPath));
  }

  async function resolveFieldReferences(
    field: RagicDefinitionField,
    detail: RagicDefinitionFormDetail
  ): Promise<RagicDefinitionFieldReference[]> {
    const references: RagicDefinitionFieldReference[] = [];
    const linkedFieldId = field.attrs.l?.trim() ?? "";
    const linkedField = linkedFieldId
      ? detail.fields.find((candidate) => candidate.fieldId === linkedFieldId) ?? null
      : null;
    if (linkedFieldId) {
      references.push({
        attribute: "l",
        fieldId: linkedFieldId,
        formPath: detail.form.formPath,
        fieldName: linkedField?.fieldName ?? null,
        kind: linkedField?.kind ?? null,
        position: linkedField?.position ?? null,
      });
    }

    const mvp = linkedField?.attrs.mvp ?? field.attrs.mvp ?? "";
    const sourceFormPath = mvp
      ? linkedSourceFormPath(detail.form.formPath, mvp)
      : null;
    let sourceDetail: RagicDefinitionFormDetail | null = null;
    if (sourceFormPath) {
      try {
        sourceDetail = sourceFormPath === detail.form.formPath
          ? detail
          : await readFormUnlocked(sourceFormPath);
      } catch {
        sourceDetail = null;
      }
    }

    for (const attribute of ["vd", "stf"] as const) {
      const referencedFieldId = field.attrs[attribute]?.trim() ?? "";
      if (!referencedFieldId) continue;
      const referencedField = sourceDetail?.fields.find(
        (candidate) => candidate.fieldId === referencedFieldId
      ) ?? null;
      references.push({
        attribute,
        fieldId: referencedFieldId,
        formPath: sourceFormPath,
        fieldName: referencedField?.fieldName ?? null,
        kind: referencedField?.kind ?? null,
        position: referencedField?.position ?? null,
      });
    }
    return references;
  }

  async function searchUnlocked(params: {
    q?: string;
    fieldId?: string;
    formPath?: string;
    type?: RagicDefinitionSearchType;
    limit?: number;
  }) {
    const q = params.q?.trim() ?? "";
    const fieldId = params.fieldId?.trim() ?? "";
    const type = params.type ?? "all";
    const limit = Math.max(1, Math.trunc(params.limit ?? 200));
    const revision = getSnapshotDescriptorUnlocked()?.revision ?? null;
    const forms = params.formPath
      ? [(await readFormUnlocked(params.formPath)).form]
      : await readAllForms();
    const data: RagicDefinitionSearchItem[] = [];

    for (const form of forms) {
      const detail = await readFormUnlocked(form.formPath);
      const fields = detail.fields;
      const formulas = detail.formulas;
      const formulasByKey = new Map(
        formulas.map((formula) => [`${formula.fieldId}:${formula.formulaKind}`, formula])
      );

      if (type === "all" || type === "field") {
        for (const field of fields) {
          if (fieldId && field.fieldId !== fieldId) continue;
          if (
            !fieldId &&
            !matchesDefinitionQuery(
              [
                form.formPath,
                form.formName,
                field.fieldId,
                field.fieldName,
                field.position,
                field.kind,
              ],
              q
            )
          ) {
            continue;
          }
          data.push({
            type: "field",
            formPath: form.formPath,
            formName: form.formName,
            sourceRelativePath: form.sourceRelativePath,
            fieldId: field.fieldId,
            fieldName: field.fieldName,
            kind: field.kind,
            position: field.position,
            sourceLine: field.sourceLine,
            attrs: field.attrs,
            fieldReferences: fieldId
              ? await resolveFieldReferences(field, detail)
              : [],
            formulaKind: null,
            nuiFormula: null,
            displayFormula: null,
            workflowScope: null,
            workflowFileName: null,
            workflowExcerpt: null,
          });
          if (data.length > limit) break;
        }
      }

      if (data.length > limit) break;
      if (type === "all" || type === "formula") {
        for (const formula of formulasByKey.values()) {
          if (fieldId && formula.fieldId !== fieldId) continue;
          if (
            !fieldId &&
            !matchesDefinitionQuery(
              [
                form.formPath,
                form.formName,
                formula.fieldId,
                formula.fieldName,
                formula.position,
                formula.formulaKind,
                formula.displayFormula,
                formula.nuiFormula,
              ],
              q
            )
          ) {
            continue;
          }
          data.push({
            type: "formula",
            formPath: form.formPath,
            formName: form.formName,
            sourceRelativePath: form.sourceRelativePath,
            fieldId: formula.fieldId,
            fieldName: formula.fieldName,
            kind: null,
            position: formula.position,
            sourceLine: formula.sourceLine,
            attrs: null,
            fieldReferences: [],
            formulaKind: formula.formulaKind,
            nuiFormula: formula.nuiFormula,
            displayFormula: formula.displayFormula,
            workflowScope: null,
            workflowFileName: null,
            workflowExcerpt: null,
          });
          if (data.length > limit) break;
        }
      }

      if (data.length > limit) break;
      if (type === "all" || type === "workflow") {
        const linkedField = fieldId
          ? fields.find((field) => field.fieldId === fieldId) ?? null
          : null;
        for (const workflow of detail.workflows) {
          const match = workflowMatch(workflow, q, fieldId);
          if (!match) continue;
          data.push({
            type: "workflow",
            formPath: form.formPath,
            formName: form.formName,
            sourceRelativePath: `forms/${form.formPath}/workflows/${workflow.fileName}`,
            fieldId: linkedField?.fieldId ?? null,
            fieldName: linkedField?.fieldName ?? null,
            kind: null,
            position: linkedField?.position ?? null,
            sourceLine: match.sourceLine,
            attrs: null,
            fieldReferences: [],
            formulaKind: null,
            nuiFormula: null,
            displayFormula: null,
            workflowScope: workflow.scope,
            workflowFileName: workflow.fileName,
            workflowExcerpt: match.excerpt,
          });
          if (data.length > limit) break;
        }
      }
      if (data.length > limit) break;
    }

    const truncated = data.length > limit;
    return {
      data: truncated ? data.slice(0, limit) : data,
      meta: {
        count: Math.min(data.length, limit),
        limit,
        truncated,
        q,
        fieldId,
        formPath: params.formPath ?? "",
        type,
        revision,
      },
    };
  }

  async function search(params: {
    q?: string;
    fieldId?: string;
    formPath?: string;
    type?: RagicDefinitionSearchType;
    limit?: number;
  }) {
    return withDefinitionsReadLock(() => searchUnlocked(params));
  }

  return {
    definitionsRoot,
    repoRoot,
    invalidateCache,
    getSnapshotDescriptorUnlocked,
    getSnapshotDescriptor,
    openCurrentSnapshot,
    loadCurrentSnapshot,
    withCurrentSnapshot,
    listSnapshots,
    getSnapshotHistoryDescriptor,
    openSnapshot,
    loadSnapshot,
    withSnapshot,
    getStateUnlocked,
    getState,
    listForms,
    readForm,
    search,
  };
}

export type RagicDefinitionsReadService = ReturnType<
  typeof createRagicDefinitionsReadService
>;

export const ragicDefinitionsReadService = createRagicDefinitionsReadService();
