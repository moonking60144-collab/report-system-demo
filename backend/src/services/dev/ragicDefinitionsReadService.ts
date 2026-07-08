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
  RagicDefinitionSearchItem,
};

const execFileAsync = promisify(execFile);

export interface RagicDefinitionsReadServiceOptions {
  definitionsRoot?: string;
  repoRoot?: string;
  cacheTtlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
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

function workflowScope(fileName: string): string {
  return fileName.replace(/\.js$/i, "");
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
  const formDetailCache = new Map<string, CacheEntry<RagicDefinitionFormDetail>>();

  function isFresh<T>(entry: CacheEntry<T> | null): entry is CacheEntry<T> {
    return Boolean(entry && entry.expiresAt > Date.now());
  }

  function cacheEntry<T>(value: T): CacheEntry<T> {
    return { value, expiresAt: Date.now() + cacheTtlMs };
  }

  function invalidateCache(): void {
    formFilesCache = null;
    formsCache = null;
    formDetailCache.clear();
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

  async function searchUnlocked(params: {
    q?: string;
    fieldId?: string;
    formPath?: string;
    type?: "all" | "field" | "formula";
    limit?: number;
  }) {
    const q = params.q?.trim() ?? "";
    const fieldId = params.fieldId?.trim() ?? "";
    const type = params.type ?? "all";
    const limit = Math.max(1, Math.trunc(params.limit ?? 200));
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

      if (type !== "formula") {
        for (const field of fields) {
          if (fieldId && field.fieldId !== fieldId) continue;
          if (
            !fieldId &&
            !matchesQuery(
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
            formulaKind: null,
            nuiFormula: null,
            displayFormula: null,
          });
          if (data.length > limit) break;
        }
      }

      if (data.length > limit) break;
      if (type !== "field") {
        for (const formula of formulasByKey.values()) {
          if (fieldId && formula.fieldId !== fieldId) continue;
          if (
            !fieldId &&
            !matchesQuery(
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
            formulaKind: formula.formulaKind,
            nuiFormula: formula.nuiFormula,
            displayFormula: formula.displayFormula,
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
      },
    };
  }

  async function search(params: {
    q?: string;
    fieldId?: string;
    formPath?: string;
    type?: "all" | "field" | "formula";
    limit?: number;
  }) {
    return withDefinitionsReadLock(() => searchUnlocked(params));
  }

  return {
    definitionsRoot,
    repoRoot,
    invalidateCache,
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
