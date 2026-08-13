import { randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import iconv from "iconv-lite";
import {
  createRagicFormulaPatchDryRunService,
  decodeNuiContent,
  encodeReplacementAttrValue,
  formulaAttrKey,
  isNuiFormulaInSync,
  maskSecrets,
  type RagicFormulaPatchDryRunRequest,
  type RagicFormulaPatchDryRunResult,
  type RagicFormulaPatchDryRunService,
} from "./ragicFormulaPatchDryRunService";
import { publishRagicDefinitionsSyncStatus } from "../../events/realtimeEventBus";
import { parseNuiFieldLine } from "./ragicNuiParser";
import {
  ragicDefinitionsReadService,
  type RagicDefinitionFormula,
  type RagicDefinitionsReadService,
} from "./ragicDefinitionsReadService";
import {
  formatRagicDefinitionsExportMessage,
} from "./ragicDefinitionsExportService";
import { exportRagicDefinitionsInChildProcess } from "./ragicDefinitionsExportProcess";
import { withDefinitionsWriteLock } from "./ragicDefinitionsIoLock";
import { suppressRagicDefinitionsWatchPaths } from "./ragicDefinitionsWatchService";
import { invalidateRagicFormulaSiblingsLiveNuiCache } from "./ragicFormulaSiblingsService";
import type {
  RagicFormulaPatchApplyResult,
  RagicFormulaPatchBatchTargetResult,
  RagicFormulaPatchBatchApplyResult,
  RagicFormulaPatchRollbackLatestResult,
  RagicFormulaPatchRollbackTarget,
} from "@shared-types/ragicDefinitions";

type DefinitionsWriteLock = typeof withDefinitionsWriteLock;

export type {
  RagicFormulaPatchApplyResult,
  RagicFormulaPatchBatchTargetResult,
  RagicFormulaPatchBatchApplyResult,
  RagicFormulaPatchRollbackLatestResult,
  RagicFormulaPatchRollbackTarget,
};

export interface RagicFormulaPatchApplyServiceOptions {
  definitionsService?: RagicDefinitionsReadService;
  dryRunService?: RagicFormulaPatchDryRunService;
  builderRoot?: string;
  backupRoot?: string;
  rollbackSafetyRoot?: string;
  auditFilePath?: string;
  withDefinitionsWriteLock?: DefinitionsWriteLock;
  exportDefinitions?: (params: {
    builderRoot: string;
    definitionsRoot: string;
    namespaces: string;
  }) => Promise<{ stdout: string; stderr: string }>;
}

async function defaultExportDefinitions({
  builderRoot,
  definitionsRoot,
  namespaces,
}: {
  builderRoot: string;
  definitionsRoot: string;
  namespaces: string;
}): Promise<{ stdout: string; stderr: string }> {
  const result = await exportRagicDefinitionsInChildProcess({
    builderRoot,
    outDir: definitionsRoot,
    namespaces,
    ragicNuiEncoding: process.env.RAGIC_NUI_ENCODING,
  });
  return { stdout: formatRagicDefinitionsExportMessage(result), stderr: "" };
}

export function defaultRagicFormulaPatchBackupRoot(): string {
  return resolve(process.cwd(), ".data", "ragic-nui-formula-backups");
}

export function defaultRagicFormulaPatchRollbackSafetyRoot(): string {
  return resolve(process.cwd(), ".data", "ragic-nui-formula-rollback-safety");
}

export function defaultRagicFormulaPatchAuditFilePath(): string {
  return resolve(process.cwd(), ".data", "ragic-nui-formula-patches.audit.jsonl");
}

function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function uniqueFileStamp(): string {
  return `${fileTimestamp()}__${randomUUID()}`;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "__").replace(/^_+|_+$/g, "") || "unknown";
}

function namespacesFromState(
  manifest: Awaited<ReturnType<RagicDefinitionsReadService["getState"]>>["manifest"]
): string {
  if (!manifest?.namespaceFilter) return "default";
  if (manifest.namespaceFilter.mode === "all") return "*";
  const namespaces = manifest.namespaceFilter.namespaces?.filter(Boolean) ?? [];
  return namespaces.length ? namespaces.join(",") : "default";
}

let auditIoQueue: Promise<void> = Promise.resolve();

async function runAuditIo<T>(fn: () => Promise<T>): Promise<T> {
  const task = auditIoQueue.catch(() => undefined).then(fn);
  auditIoQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

async function appendAudit(filePath: string, payload: unknown): Promise<void> {
  await runAuditIo(async () => {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
  });
}

function definitionReadErrorToBlocker(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.message === "BAD_FORM_PATH") return "formPath 格式不合法";
  if (/ENOENT/.test(error.message)) return "找不到指定 definitions 檔案";
  return null;
}

function blockedDryRunFromError(
  input: RagicFormulaPatchDryRunRequest,
  blocker: string
): RagicFormulaPatchDryRunResult {
  return {
    allowed: false,
    mode: "dry-run",
    formPath: input.formPath,
    formName: null,
    fieldId: input.fieldId,
    fieldName: null,
    position: null,
    formulaKind: input.formulaKind,
    sourceRelativePath: null,
    builderFilePath: null,
    sourceLine: null,
    oldFormula: null,
    newFormula: input.newFormula,
    oldLinePreview: null,
    newLinePreview: null,
    gitClean: null,
    warnings: [],
    blockers: [blocker],
  };
}

type RagicFormulaPatchRollbackCoreResult = Omit<
  RagicFormulaPatchRollbackLatestResult,
  "state" | "versionStatus"
>;

interface FormulaPatchAuditAppliedEntry {
  at?: string;
  status?: string;
  batch?: boolean;
  formPath?: string;
  fieldId?: string;
  formulaKind?: RagicDefinitionFormula["formulaKind"];
  builderFilePath?: string | null;
  backupFilePath?: string | null;
}

function parseAppliedAuditEntries(content: string): FormulaPatchAuditAppliedEntry[] {
  const entries: FormulaPatchAuditAppliedEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as FormulaPatchAuditAppliedEntry;
      if (
        parsed.status === "applied" &&
        parsed.formPath &&
        parsed.fieldId &&
        (parsed.formulaKind === "formula" || parsed.formulaKind === "defaultFormula") &&
        parsed.builderFilePath &&
        parsed.backupFilePath
      ) {
        entries.push(parsed);
      }
    } catch {
      // audit 是 append-only 診斷檔；單行壞資料不能阻止後續回復可用紀錄
    }
  }
  return entries;
}

function batchBackupPrefix(backupFilePath: string): string | null {
  const fileName = basename(backupFilePath);
  const match = /^(.+?)__batch\d+__/.exec(fileName);
  return match ? match[1] : null;
}

function latestRollbackCandidates(
  entries: FormulaPatchAuditAppliedEntry[]
): FormulaPatchAuditAppliedEntry[] {
  const latest = entries.at(-1);
  if (!latest) return [];
  const prefix = latest.batch && latest.backupFilePath ? batchBackupPrefix(latest.backupFilePath) : null;
  if (!prefix) return [latest];
  return entries.filter(
    (entry) =>
      entry.batch === true &&
      entry.backupFilePath &&
      batchBackupPrefix(entry.backupFilePath) === prefix
  );
}

export interface RagicFormulaPatchArtifactCleanupResult {
  deletedBackupFiles: number;
  deletedRollbackSafetyFiles: number;
  removedAuditLines: number;
  protectedBackupFiles: number;
}

function parseAuditLines(content: string): Array<{
  raw: string;
  parsed: (FormulaPatchAuditAppliedEntry & { status?: string; at?: string }) | null;
}> {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((raw) => {
      try {
        return { raw, parsed: JSON.parse(raw) as FormulaPatchAuditAppliedEntry };
      } catch {
        return { raw, parsed: null };
      }
    });
}

async function listFilesRecursively(root: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function deleteOldFiles(params: {
  root: string;
  thresholdMs: number;
  protectedFiles?: ReadonlySet<string>;
}): Promise<number> {
  const files = await listFilesRecursively(params.root);
  let deleted = 0;
  for (const filePath of files) {
    if (params.protectedFiles?.has(resolve(filePath))) continue;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(filePath);
    } catch {
      continue;
    }
    if (info.mtimeMs >= params.thresholdMs) continue;
    await unlink(filePath).then(
      () => {
        deleted += 1;
      },
      () => undefined
    );
  }
  return deleted;
}

export async function cleanupRagicFormulaPatchArtifacts(options: {
  backupRoot?: string;
  rollbackSafetyRoot?: string;
  auditFilePath?: string;
  retentionDays?: number;
  now?: Date;
} = {}): Promise<RagicFormulaPatchArtifactCleanupResult> {
  const retentionDays = Math.max(1, Math.trunc(options.retentionDays ?? 90));
  const thresholdMs = (options.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const backupRoot = resolve(options.backupRoot ?? defaultRagicFormulaPatchBackupRoot());
  const rollbackSafetyRoot = resolve(
    options.rollbackSafetyRoot ?? defaultRagicFormulaPatchRollbackSafetyRoot()
  );
  const auditFilePath = resolve(options.auditFilePath ?? defaultRagicFormulaPatchAuditFilePath());

  return runAuditIo(async () => {
    let auditContent = "";
    try {
      auditContent = await readFile(auditFilePath, "utf-8");
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code !== "ENOENT") throw error;
    }

    const auditLines = parseAuditLines(auditContent);
    const appliedEntries = auditLines
      .map((line) => line.parsed)
      .filter((entry): entry is FormulaPatchAuditAppliedEntry =>
        Boolean(
          entry &&
          entry.status === "applied" &&
          entry.formPath &&
          entry.fieldId &&
          (entry.formulaKind === "formula" || entry.formulaKind === "defaultFormula") &&
          entry.builderFilePath &&
          entry.backupFilePath
        )
      );
    const protectedBackupFiles = new Set(
      latestRollbackCandidates(appliedEntries)
        .map((entry) => entry.backupFilePath)
        .filter((item): item is string => Boolean(item))
        .map((item) => resolve(item))
    );

    const retainedLines = auditLines.filter((line) => {
      if (!line.parsed) return true;
      if (line.parsed.backupFilePath && protectedBackupFiles.has(resolve(line.parsed.backupFilePath))) {
        return true;
      }
      if (!line.parsed.at) return true;
      const atMs = Date.parse(line.parsed.at);
      if (!Number.isFinite(atMs)) return true;
      return atMs >= thresholdMs;
    });
    const removedAuditLines = auditLines.length - retainedLines.length;
    if (removedAuditLines > 0) {
      await mkdir(dirname(auditFilePath), { recursive: true });
      await writeFile(
        auditFilePath,
        retainedLines.length > 0 ? `${retainedLines.map((line) => line.raw).join("\n")}\n` : "",
        "utf-8"
      );
    }

    const [deletedBackupFiles, deletedRollbackSafetyFiles] = await Promise.all([
      deleteOldFiles({ root: backupRoot, thresholdMs, protectedFiles: protectedBackupFiles }),
      deleteOldFiles({ root: rollbackSafetyRoot, thresholdMs }),
    ]);

    return {
      deletedBackupFiles,
      deletedRollbackSafetyFiles,
      removedAuditLines,
      protectedBackupFiles: protectedBackupFiles.size,
    };
  });
}

function formPathFromDefinitionsGitStatusEntry(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/");
  const marker = "ragic-definitions/forms/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return null;
  const rest = normalized.slice(markerIndex + marker.length);
  const parts = rest.split("/").filter(Boolean);
  const fileIndex = parts.findIndex((part) =>
    part === "form.json" ||
    part === "fields.json" ||
    part === "formulas.json" ||
    part === "workflows"
  );
  if (fileIndex <= 0) return null;
  return parts.slice(0, fileIndex).join("/");
}

async function assertReadableFile(filePath: string, label: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`${label} 不是檔案`);
  } catch (error) {
    throw new Error(
      `${label} 不存在或不可讀：${filePath}（${
        error instanceof Error ? error.message : String(error)
      }）`
    );
  }
}

function findLineRange(bytes: Buffer, sourceLine: number): { start: number; end: number } | null {
  let line = 1;
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue;
    let end = index;
    if (end > start && bytes[end - 1] === 13) end -= 1;
    if (line === sourceLine) return { start, end };
    line += 1;
    start = index + 1;
  }
  if (line === sourceLine) return { start, end: bytes.length };
  return null;
}

function normalizeEncoding(encoding: string): string {
  const normalized = encoding.trim().toLowerCase();
  return normalized === "utf8" ? "utf-8" : normalized || "utf-8";
}

function formulaFormulasPath(definitionsRoot: string, formPath: string): string {
  return join(definitionsRoot, "forms", ...formPath.split("/"), "formulas.json");
}

async function readFormulaFromFilesystem(
  definitionsRoot: string,
  formPath: string,
  fieldId: string,
  formulaKind: RagicDefinitionFormula["formulaKind"]
): Promise<RagicDefinitionFormula | null> {
  const path = formulaFormulasPath(definitionsRoot, formPath);
  const formulas = JSON.parse(await readFile(path, "utf-8")) as RagicDefinitionFormula[];
  return (
    formulas.find((formula) => formula.fieldId === fieldId && formula.formulaKind === formulaKind) ??
    null
  );
}

function isUtf8Encoding(encoding: string): boolean {
  return normalizeEncoding(encoding) === "utf-8";
}

function assertRepresentableInSourceEncoding(value: string, sourceEncoding: string): void {
  const normalizedEncoding = normalizeEncoding(sourceEncoding);
  const encoded = iconv.encode(value, normalizedEncoding);
  const decoded = iconv.decode(encoded, normalizedEncoding);
  if (decoded !== value) {
    throw new Error(
      `新公式含目前 .nui 編碼 ${sourceEncoding} 無法表示的字元，已阻擋寫入，避免公式被替換成 ?。`
    );
  }
}

function publishFormulaPatchSyncEvent(formPaths: string[], message: string): void {
  if (formPaths.length === 0) return;
  publishRagicDefinitionsSyncStatus({
    status: "synced",
    message,
    changedCount: Math.max(1, formPaths.length),
  });
}

function findEncodedAttrSegmentIndex(
  lineBytes: Buffer,
  attrKey: string,
  segmentBytes: Buffer
): number {
  const keyPrefix = Buffer.from(`${attrKey}=`, "ascii");
  let offset = 0;
  while (offset <= lineBytes.length) {
    const matchIndex = lineBytes.indexOf(keyPrefix, offset);
    if (matchIndex < 0) return -1;

    const isStartBoundary = matchIndex === 0 || lineBytes[matchIndex - 1] === 38;
    if (isStartBoundary) {
      const nextAmpersand = lineBytes.indexOf(38, matchIndex + 1);
      const segmentEnd = nextAmpersand < 0 ? lineBytes.length : nextAmpersand;
      const segmentSlice = lineBytes.subarray(matchIndex, segmentEnd);
      if (segmentSlice.equals(segmentBytes)) {
        return matchIndex;
      }
    }

    offset = matchIndex + 1;
  }

  return -1;
}

function replaceAttrValue(
  attrs: readonly { key: string; rawValue: string | null }[],
  key: string,
  value: string
): string {
  return attrs
    .map((attr) => {
      if (attr.key === key) return `${key}=${value}`;
      return attr.rawValue === null ? attr.key : `${attr.key}=${attr.rawValue}`;
    })
    .join("&");
}

function insertAttrValue(rawAttrs: string, key: string, value: string): string {
  return rawAttrs ? `${rawAttrs}&${key}=${value}` : `${key}=${value}`;
}

async function patchNuiFormulaBytes(params: {
  builderFilePath: string;
  sourceLine: number;
  sourceEncoding: string;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  expectedFieldId: string;
  expectedOldFormula: string | null;
  newFormula: string;
  warnings: string[];
}): Promise<void> {
  const bytes = await readFile(params.builderFilePath);
  const range = findLineRange(bytes, params.sourceLine);
  if (!range) throw new Error(`實際 .nui 沒有第 ${params.sourceLine} 行`);

  const lineBytes = bytes.subarray(range.start, range.end);
  const line = decodeNuiContent(lineBytes, params.sourceEncoding, params.warnings);
  const parsedLine = parseNuiFieldLine(line, params.sourceLine);
  if (!parsedLine) throw new Error("sourceLine 不是可解析的 .nui 欄位行");
  if (parsedLine.fieldId !== params.expectedFieldId) {
    throw new Error(
      `Ragic 現況已不同步，sourceLine fieldId 不一致：expected=${params.expectedFieldId}，actual=${parsedLine.fieldId}`
    );
  }

  const attrs = parsedLine.attrs;
  const attrKey = formulaAttrKey(params.formulaKind);
  const oldAttr = attrs.find((attr) => attr.key === attrKey);
  if (params.expectedOldFormula !== null) {
    if (!oldAttr || oldAttr.rawValue === null) {
      throw new Error(`Ragic 現況已不同步，sourceLine attrs 找不到 ${attrKey}= 公式`);
    }
    if (
      !isNuiFormulaInSync({
        baselineFormula: params.expectedOldFormula,
        liveFormula: oldAttr.decodedValue,
        sourceEncoding: params.sourceEncoding,
        liveRawFormula: oldAttr.rawValue,
      })
    ) {
      throw new Error(
        `Ragic 現況已不同步，請先重新匯入後再套用：expected=${params.expectedOldFormula}，actual=${oldAttr.decodedValue}`
      );
    }
  } else if (oldAttr && oldAttr.rawValue !== null && oldAttr.decodedValue.trim() !== "") {
    throw new Error(
      `Ragic 現況已不同步，請先重新匯入後再套用：expected=（無公式），actual=${oldAttr.decodedValue}`
    );
  }
  const newRawValue = encodeReplacementAttrValue(
    params.newFormula,
    oldAttr?.rawValue ?? null
  );
  const normalizedSourceEncoding = normalizeEncoding(params.sourceEncoding);
  if (!isUtf8Encoding(normalizedSourceEncoding)) {
    assertRepresentableInSourceEncoding(newRawValue, normalizedSourceEncoding);
  }

  let patched: Buffer;
  if (isUtf8Encoding(normalizedSourceEncoding)) {
    const nextRawAttrs =
      oldAttr?.rawValue !== null && oldAttr?.rawValue !== undefined
        ? replaceAttrValue(attrs, attrKey, newRawValue)
        : insertAttrValue(parsedLine.rawAttrs, attrKey, newRawValue);

    const nextParts = [...parsedLine.parts];
    nextParts[5] = nextRawAttrs;
    const nextLine = nextParts.join(",");
    const nextLineBytes = Buffer.from(nextLine, "utf-8");
    patched = Buffer.concat([bytes.subarray(0, range.start), nextLineBytes, bytes.subarray(range.end)]);
  } else {
    if (oldAttr?.rawValue !== null && oldAttr?.rawValue !== undefined) {
      const oldSegment = iconv.encode(`${attrKey}=${oldAttr.rawValue}`, normalizedSourceEncoding);
      const newSegment = iconv.encode(`${attrKey}=${newRawValue}`, normalizedSourceEncoding);
      const segmentIndex = findEncodedAttrSegmentIndex(lineBytes, attrKey, oldSegment);
      if (segmentIndex < 0) {
        throw new Error(`sourceLine 找不到可替換的 ${attrKey}= raw attr`);
      }
      patched = Buffer.concat([
        bytes.subarray(0, range.start + segmentIndex),
        newSegment,
        bytes.subarray(range.start + segmentIndex + oldSegment.length),
      ]);
    } else {
      const prefix = parsedLine.rawAttrs ? `&${attrKey}=` : `${attrKey}=`;
      const insertedSegment = iconv.encode(`${prefix}${newRawValue}`, normalizedSourceEncoding);
      patched = Buffer.concat([
        bytes.subarray(0, range.end),
        insertedSegment,
        bytes.subarray(range.end),
      ]);
    }
  }

  await writeFile(params.builderFilePath, patched);
  invalidateRagicFormulaSiblingsLiveNuiCache(params.builderFilePath);
}

export function createRagicFormulaPatchApplyService(
  options: RagicFormulaPatchApplyServiceOptions = {}
) {
  const definitionsService = options.definitionsService ?? ragicDefinitionsReadService;
  const builderRoot = options.builderRoot ?? process.env.RAGIC_BUILDER_PATH ?? "";
  const dryRunService =
    options.dryRunService ??
    createRagicFormulaPatchDryRunService({ definitionsService, builderRoot });
  const backupRoot = resolve(options.backupRoot ?? defaultRagicFormulaPatchBackupRoot());
  const rollbackSafetyRoot = resolve(
    options.rollbackSafetyRoot ?? defaultRagicFormulaPatchRollbackSafetyRoot()
  );
  const auditFilePath = resolve(options.auditFilePath ?? defaultRagicFormulaPatchAuditFilePath());
  const exportDefinitions = options.exportDefinitions ?? defaultExportDefinitions;
  const runWithDefinitionsWriteLock =
    options.withDefinitionsWriteLock ?? withDefinitionsWriteLock;
  const getStateUnlocked = (
    definitionsService as unknown as {
      getStateUnlocked?: RagicDefinitionsReadService["getState"];
    }
  ).getStateUnlocked?.bind(definitionsService);

  async function applyFormulaPatch(
    input: RagicFormulaPatchDryRunRequest
  ): Promise<RagicFormulaPatchApplyResult> {
    const dryRun = await dryRunService.dryRunFormulaPatch(input);
    const warnings = [...dryRun.warnings];
    const blockers = [...dryRun.blockers];
    const result: RagicFormulaPatchApplyResult = {
      applied: false,
      mode: "apply",
      dryRun,
      backupFilePath: null,
      auditFilePath: null,
      exportOutput: null,
      verifiedFormula: null,
      rolledBack: false,
      warnings,
      blockers,
    };

    if (!dryRun.allowed || blockers.length > 0) return result;
    if (!dryRun.builderFilePath || !dryRun.sourceLine) {
      result.blockers.push("dry-run 回傳缺少可寫入資訊");
      return result;
    }
    const newFormula = dryRun.newFormula;

    const state = await definitionsService.getState();
    const definitionsRoot = state.definitionsRoot;
    const namespaces = namespacesFromState(state.manifest);
    const detail = await definitionsService.readForm(input.formPath);
    const backupFilePath = join(
      backupRoot,
      `${uniqueFileStamp()}__${safeFilePart(input.formPath)}__${safeFilePart(input.fieldId)}.nui`
    );
    const sourceLine = dryRun.sourceLine;
    const builderFilePath = dryRun.builderFilePath;
    result.backupFilePath = backupFilePath;
    result.auditFilePath = auditFilePath;

    let patched = false;
    let backupCreated = false;
    try {
      await runWithDefinitionsWriteLock(async () => {
        await mkdir(dirname(backupFilePath), { recursive: true });
        await copyFile(builderFilePath, backupFilePath);
        backupCreated = true;
        suppressRagicDefinitionsWatchPaths([builderFilePath], { builderRoot });
        await patchNuiFormulaBytes({
          builderFilePath,
          sourceLine,
          sourceEncoding: detail.form.sourceEncoding,
          formulaKind: input.formulaKind,
          expectedFieldId: input.fieldId,
          expectedOldFormula: dryRun.oldFormula,
          newFormula,
          warnings,
        });
        patched = true;

        const exportedDefinitions = await exportDefinitions({
          builderRoot,
          definitionsRoot,
          namespaces,
        });
        definitionsService.invalidateCache();
        result.exportOutput = [exportedDefinitions.stdout.trim(), exportedDefinitions.stderr.trim()]
          .filter(Boolean)
          .join("\n");

        const verifiedFormula =
          (await readFormulaFromFilesystem(
            definitionsRoot,
            input.formPath,
            input.fieldId,
            input.formulaKind
          )) ?? null;
        result.verifiedFormula = verifiedFormula;
        if (!verifiedFormula) {
          throw new Error("re-export 後 formulas.json 找不到指定公式");
        }
        const expectedFormulaCandidates = new Set([
          newFormula,
          encodeReplacementAttrValue(newFormula, null),
        ]);
        if (!expectedFormulaCandidates.has(verifiedFormula.nuiFormula)) {
          throw new Error(
            `re-export 驗證失敗：expected=${newFormula}，actual=${verifiedFormula.nuiFormula}`
          );
        }

        result.applied = true;
        try {
          await appendAudit(auditFilePath, {
            at: new Date().toISOString(),
            status: "applied",
            formPath: input.formPath,
            fieldId: input.fieldId,
            formulaKind: input.formulaKind,
            sourceLine: dryRun.sourceLine,
            builderFilePath,
            backupFilePath,
            definitionsRoot,
            oldFormula: dryRun.oldFormula === null ? null : maskSecrets(dryRun.oldFormula),
            newFormula: maskSecrets(newFormula),
            oldLinePreview: dryRun.oldLinePreview,
            newLinePreview: dryRun.newLinePreview,
          });
        } catch (auditError) {
          result.warnings.push(
            `audit 紀錄寫入失敗（套用本身已成功）：${
              auditError instanceof Error ? auditError.message : String(auditError)
            }`
          );
        }
        publishFormulaPatchSyncEvent(
          [input.formPath],
          "公式套用已完成，definitions 已更新。"
        );
      });
      return result;
    } catch (error) {
      if (!backupCreated && !patched) {
        throw error;
      }
      if (patched) {
        let restored = false;
        try {
          await runWithDefinitionsWriteLock(async () => {
            suppressRagicDefinitionsWatchPaths([builderFilePath], { builderRoot });
            await copyFile(backupFilePath, builderFilePath);
            invalidateRagicFormulaSiblingsLiveNuiCache(builderFilePath);
            const exportedDefinitions = await exportDefinitions({
              builderRoot,
              definitionsRoot,
              namespaces,
            });
            definitionsService.invalidateCache();
            result.exportOutput = [exportedDefinitions.stdout.trim(), exportedDefinitions.stderr.trim()]
              .filter(Boolean)
              .join("\n");
          });
          restored = true;
        } catch (restoreError) {
          const message = `rollback 還原失敗：${
            restoreError instanceof Error ? restoreError.message : String(restoreError)
          }（備份：${backupFilePath}）`;
          result.warnings.push(message);
          result.blockers.push(message);
        }
        result.rolledBack = restored;
      }
      const message = error instanceof Error ? error.message : String(error);
      result.blockers.push(message);
      await appendAudit(auditFilePath, {
        at: new Date().toISOString(),
        status: result.rolledBack ? "rolled_back" : "failed",
        formPath: input.formPath,
        fieldId: input.fieldId,
        formulaKind: input.formulaKind,
          sourceLine,
          builderFilePath,
        backupFilePath,
        definitionsRoot,
        oldFormula: dryRun.oldFormula ? maskSecrets(dryRun.oldFormula) : null,
        newFormula: maskSecrets(newFormula),
        error: message,
      });
      return result;
    }
  }

  /**
   * 批次套用（主表 + 跨版本表單一次完成）。逐張 apply 在 git-clean blocker 下
   * 是流程死鎖：第一張套完 definitions 即 dirty，後面每張的 dry-run 都會被
   * 「未提交差異」擋住。批次把整件事做成一個原子單位：
   *   1. 全部 targets 先 dry-run（此時 definitions 仍 clean）→ 任一張被擋，整批不動
   *   2. 逐張備份 + byte-patch .nui（不 re-export）
   *   3. 一次 re-export → 逐張 verify
   *   4. 任何寫入/驗證失敗 → 全部還原備份 + 再 re-export（all-or-nothing）
   */
  async function applyFormulaPatchBatch(
    inputs: RagicFormulaPatchDryRunRequest[]
  ): Promise<RagicFormulaPatchBatchApplyResult> {
    const results: RagicFormulaPatchBatchTargetResult[] = [];
    const batch: RagicFormulaPatchBatchApplyResult = {
      applied: false,
      mode: "apply-batch",
      results,
      rolledBack: false,
      exportOutput: null,
      auditFilePath,
    };

    // Phase 1：全部 dry-run（definitions 尚未 dirty，git-clean 檢查只會在這裡擋）
    for (const input of inputs) {
      let dryRun: RagicFormulaPatchDryRunResult;
      try {
        dryRun = await dryRunService.dryRunFormulaPatch(input);
      } catch (error) {
        const blocker = definitionReadErrorToBlocker(error);
        if (!blocker) throw error;
        dryRun = blockedDryRunFromError(input, blocker);
      }
      results.push({
        formPath: input.formPath,
        fieldId: input.fieldId,
        formulaKind: input.formulaKind,
        newFormula: dryRun.newFormula,
        dryRun,
        applied: false,
        verifiedFormula: null,
        blockers: [...dryRun.blockers],
        warnings: [...dryRun.warnings],
      });
    }

    const writable = results.map(
      (target) =>
        target.dryRun.allowed &&
        target.dryRun.blockers.length === 0 &&
        Boolean(target.dryRun.builderFilePath) &&
        Boolean(target.dryRun.sourceLine)
    );
    if (!writable.every(Boolean)) {
      for (let index = 0; index < results.length; index += 1) {
        const target = results[index];
        if (writable[index]) {
          target.blockers.push("批次內其他表單試算被擋，整批未套用");
        } else if (target.dryRun.allowed && target.dryRun.blockers.length === 0) {
          target.blockers.push("dry-run 回傳缺少可寫入資訊");
        }
      }
      return batch;
    }

    const state = await definitionsService.getState();
    const definitionsRoot = state.definitionsRoot;
    const namespaces = namespacesFromState(state.manifest);
    const stamp = uniqueFileStamp();
    const sourceEncodings = new Map<string, string>();
    const backups: Array<{ builderFilePath: string; backupFilePath: string }> = [];

    for (const input of inputs) {
      try {
        const detail = await definitionsService.readForm(input.formPath);
        sourceEncodings.set(input.formPath, detail.form.sourceEncoding);
      } catch (error) {
        const blocker = definitionReadErrorToBlocker(error);
        if (!blocker) throw error;
        sourceEncodings.set(input.formPath, `__ERROR__:${blocker}`);
      }
    }

    const hasSourceEncodingError = inputs.some((input) =>
      sourceEncodings.get(input.formPath)?.startsWith("__ERROR__:")
    );
    if (hasSourceEncodingError) {
      for (let index = 0; index < results.length; index += 1) {
        const target = results[index];
        if (target.blockers.length > 0) continue;
        const rawBlocker = sourceEncodings.get(target.formPath);
        if (!rawBlocker?.startsWith("__ERROR__:")) continue;
        const blocker = rawBlocker.slice("__ERROR__:".length);
        if (blocker) {
          target.blockers.push(blocker);
        }
      }
      return batch;
    }

    const restoreAll = async (): Promise<string[]> => {
      // 逐檔還原且單檔失敗不中斷：rollback 中再丟例外會讓 builder 停在
      // 「部分還原」狀態且 audit 全沒寫，比原錯誤更糟
      const failures: string[] = [];
      for (const backup of [...backups].reverse()) {
        try {
          await copyFile(backup.backupFilePath, backup.builderFilePath);
          invalidateRagicFormulaSiblingsLiveNuiCache(backup.builderFilePath);
        } catch (restoreError) {
          failures.push(
            `${backup.builderFilePath} 還原失敗：${
              restoreError instanceof Error ? restoreError.message : String(restoreError)
            }（備份：${backup.backupFilePath}）`
          );
        }
      }
      return failures;
    };

    try {
      await runWithDefinitionsWriteLock(async () => {
        suppressRagicDefinitionsWatchPaths(
          results
            .map((target) => target.dryRun.builderFilePath)
            .filter((item): item is string => Boolean(item)),
          { builderRoot }
        );
        // Phase 2：逐張備份 + 寫入（同檔多 target 也安全：patch 不增刪行，
        // patchNuiFormulaBytes 每次重讀檔以行號重新定位）
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          const target = results[index];
          const builderFilePath = target.dryRun.builderFilePath as string;
          const backupFilePath = join(
            backupRoot,
            `${stamp}__batch${index}__${safeFilePart(input.formPath)}__${safeFilePart(input.fieldId)}.nui`
          );
          await mkdir(dirname(backupFilePath), { recursive: true });
          await copyFile(builderFilePath, backupFilePath);
          backups.push({ builderFilePath, backupFilePath });

          const sourceEncoding = sourceEncodings.get(input.formPath);
          if (!sourceEncoding) {
            throw new Error(`無法取得 ${input.formPath} 的原始編碼`);
          }
          await patchNuiFormulaBytes({
            builderFilePath,
            sourceLine: target.dryRun.sourceLine as number,
            sourceEncoding,
            formulaKind: input.formulaKind,
            expectedFieldId: input.fieldId,
            expectedOldFormula: target.dryRun.oldFormula,
            newFormula: target.newFormula,
            warnings: target.warnings,
          });
        }

        // Phase 3：一次 re-export + 逐張 verify
        const exportedDefinitions = await exportDefinitions({
          builderRoot,
          definitionsRoot,
          namespaces,
        });
        definitionsService.invalidateCache();
        batch.exportOutput = [exportedDefinitions.stdout.trim(), exportedDefinitions.stderr.trim()]
          .filter(Boolean)
          .join("\n");

        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          const target = results[index];
          const verifiedFormula =
            (await readFormulaFromFilesystem(
              definitionsRoot,
              input.formPath,
              input.fieldId,
              input.formulaKind
            )) ?? null;
          target.verifiedFormula = verifiedFormula;
          if (!verifiedFormula) {
            throw new Error(`${input.formPath} re-export 後 formulas.json 找不到指定公式`);
          }
          const expectedFormulaCandidates = new Set([
            target.newFormula,
            encodeReplacementAttrValue(target.newFormula, null),
          ]);
          if (!expectedFormulaCandidates.has(verifiedFormula.nuiFormula)) {
            throw new Error(
              `${input.formPath} re-export 驗證失敗：expected=${target.newFormula}，actual=${verifiedFormula.nuiFormula}`
            );
          }
        }

        // 套用已成功且驗證通過——audit 記帳失敗不回滾，只降級 warning。
        // 但成功 audit 必須在 definitions write lock 釋放前完成，rollback-latest 才不會讀到舊 latest。
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          const target = results[index];
          try {
            await appendAudit(auditFilePath, {
              at: new Date().toISOString(),
              status: "applied",
              batch: true,
              formPath: input.formPath,
              fieldId: input.fieldId,
              formulaKind: input.formulaKind,
              sourceLine: target.dryRun.sourceLine,
              builderFilePath: target.dryRun.builderFilePath,
              backupFilePath: backups[index]?.backupFilePath ?? null,
              definitionsRoot,
              oldFormula: target.dryRun.oldFormula ? maskSecrets(target.dryRun.oldFormula) : null,
              newFormula: maskSecrets(target.newFormula),
            });
          } catch (auditError) {
            target.warnings.push(
              `audit 紀錄寫入失敗（套用本身已成功）：${
                auditError instanceof Error ? auditError.message : String(auditError)
              }`
            );
          }
        }
      });

      batch.applied = true;
      publishFormulaPatchSyncEvent(
        results.map((target) => target.formPath),
        "批次公式套用已完成，definitions 已更新。"
      );
      for (const target of results) {
        target.applied = true;
      }
    } catch (error) {
      let restoreFailures: string[];
      let rollbackExportSucceeded = false;
      try {
        restoreFailures = await runWithDefinitionsWriteLock(async () => {
          suppressRagicDefinitionsWatchPaths(
            backups.map((backup) => backup.builderFilePath),
            { builderRoot }
          );
          const failures = await restoreAll();
          if (failures.length === 0) {
            const exportedDefinitions = await exportDefinitions({
              builderRoot,
              definitionsRoot,
              namespaces,
            });
            definitionsService.invalidateCache();
            batch.exportOutput = [exportedDefinitions.stdout.trim(), exportedDefinitions.stderr.trim()]
              .filter(Boolean)
              .join("\n");
            rollbackExportSucceeded = true;
          }
          return failures;
        });
      } catch (rollbackExportError) {
        restoreFailures = [];
        const message =
          rollbackExportError instanceof Error
            ? rollbackExportError.message
            : String(rollbackExportError);
        for (const target of results) {
          target.warnings.push(`rollback 後 re-export 失敗：${message}`);
        }
      }
      batch.rolledBack = restoreFailures.length === 0 && rollbackExportSucceeded;
      batch.applied = false;
      for (const failure of restoreFailures) {
        for (const target of results) {
          target.warnings.push(failure);
          target.blockers.push(`整批回滾失敗：${failure}`);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      for (const target of results) {
        target.applied = false;
        target.verifiedFormula = null;
        target.blockers.push(`整批回滾：${message}`);
      }
      try {
        await appendAudit(auditFilePath, {
          at: new Date().toISOString(),
          status: "batch_rolled_back",
          error: message,
          restoreFailures,
          targets: inputs.map((input, index) => ({
            formPath: input.formPath,
            fieldId: input.fieldId,
            formulaKind: input.formulaKind,
            newFormula: maskSecrets(results[index]?.newFormula ?? input.newFormula),
          })),
        });
      } catch {
        // audit 寫不進去不再丟：回滾結果本身要回給前端
      }
      return batch;
    }

    return batch;
  }

  async function rollbackLatestFormulaPatch(): Promise<RagicFormulaPatchRollbackCoreResult> {
    const result: RagicFormulaPatchRollbackCoreResult = {
      rolledBack: false,
      mode: "rollback-latest",
      auditFilePath,
      exportOutput: null,
      restoredCount: 0,
      targets: [],
      blockers: [],
      warnings: [],
    };

    const fallbackState = getStateUnlocked ? null : await definitionsService.getState();

    return runWithDefinitionsWriteLock(async () => {
      let auditContent = "";
      try {
        auditContent = await readFile(auditFilePath, "utf-8");
      } catch (error) {
        result.blockers.push(
          `找不到公式套用 audit，無法判斷要回復哪一次套用：${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return result;
      }

      const candidates = latestRollbackCandidates(parseAppliedAuditEntries(auditContent));
      if (candidates.length === 0) {
        result.blockers.push("找不到可回復的公式套用紀錄");
        return result;
      }

      const byBuilderFilePath = new Map<string, FormulaPatchAuditAppliedEntry>();
      for (const candidate of candidates) {
        if (!candidate.builderFilePath) continue;
        if (!byBuilderFilePath.has(candidate.builderFilePath)) {
          byBuilderFilePath.set(candidate.builderFilePath, candidate);
        }
      }

      const state = getStateUnlocked ? await getStateUnlocked() : fallbackState!;
      if (state.gitStatus.available && state.gitStatus.clean) {
        result.blockers.push("目前 definitions 沒有未提交差異，無需回復套用前狀態");
        return result;
      }
      if (state.gitStatus.available) {
        const dirtyFormPaths = new Set(
          state.gitStatus.entries
            .map(formPathFromDefinitionsGitStatusEntry)
            .filter((item): item is string => Boolean(item))
        );
        const candidateFormPaths = new Set(
          [...byBuilderFilePath.values()]
            .map((candidate) => candidate.formPath)
            .filter((item): item is string => Boolean(item))
        );
        if (state.gitStatus.entries.length > 0 && dirtyFormPaths.size === 0) {
          result.blockers.push(
            "目前 definitions 差異無法對應到最近一次公式套用表單，為避免誤回復舊備份，請先重新匯入或手動確認差異。"
          );
          return result;
        }
        if (
          dirtyFormPaths.size > 0 &&
          [...dirtyFormPaths].every((formPath) => !candidateFormPaths.has(formPath))
        ) {
          result.blockers.push(
            "目前 definitions 差異不屬於最近一次公式套用，為避免誤回復舊備份，請先確認差異或重新匯入。"
          );
          return result;
        }
        const unrelatedDirtyFormPaths = [...dirtyFormPaths].filter(
          (formPath) => !candidateFormPaths.has(formPath)
        );
        if (unrelatedDirtyFormPaths.length > 0) {
          result.warnings.push(
            `仍有其他表單差異不會被這次回復處理：${unrelatedDirtyFormPaths.join(" / ")}`
          );
        }
      }

      const definitionsRoot = state.definitionsRoot;
      const namespaces = namespacesFromState(state.manifest);
      const stamp = uniqueFileStamp();

      for (const candidate of byBuilderFilePath.values()) {
        const target: RagicFormulaPatchRollbackTarget = {
          formPath: candidate.formPath as string,
          fieldId: candidate.fieldId as string,
          formulaKind: candidate.formulaKind as RagicDefinitionFormula["formulaKind"],
          builderFilePath: candidate.builderFilePath as string,
          backupFilePath: candidate.backupFilePath as string,
          safetyBackupFilePath: null,
          restored: false,
          blockers: [],
          warnings: [],
        };
        result.targets.push(target);
        try {
          await assertReadableFile(target.backupFilePath, "公式套用備份");
          await assertReadableFile(target.builderFilePath, "目前 live .nui");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          target.blockers.push(message);
          result.blockers.push(message);
        }
      }

      if (result.blockers.length > 0) {
        return result;
      }

      const restoreSafetyBackups = async (): Promise<void> => {
        for (const target of [...result.targets].reverse()) {
          if (!target.safetyBackupFilePath) continue;
          try {
            await copyFile(target.safetyBackupFilePath, target.builderFilePath);
            invalidateRagicFormulaSiblingsLiveNuiCache(target.builderFilePath);
            target.warnings.push("回復失敗後已還原 safety backup");
          } catch (restoreError) {
            const message = `回復失敗後 safety backup 還原失敗：${
              restoreError instanceof Error ? restoreError.message : String(restoreError)
            }（${target.safetyBackupFilePath} -> ${target.builderFilePath}）`;
            target.blockers.push(message);
            result.blockers.push(message);
          }
        }
      };

      try {
        for (const target of result.targets) {
          const safetyBackupFilePath = join(
            rollbackSafetyRoot,
            `${stamp}__${safeFilePart(target.formPath)}__${safeFilePart(target.fieldId)}.nui`
          );
          target.safetyBackupFilePath = safetyBackupFilePath;
          await mkdir(dirname(safetyBackupFilePath), { recursive: true });
          suppressRagicDefinitionsWatchPaths([target.builderFilePath], { builderRoot });
          await copyFile(target.builderFilePath, safetyBackupFilePath);
          await copyFile(target.backupFilePath, target.builderFilePath);
          invalidateRagicFormulaSiblingsLiveNuiCache(target.builderFilePath);
          target.restored = true;
        }

        const exportedDefinitions = await exportDefinitions({
          builderRoot,
          definitionsRoot,
          namespaces,
        });
        definitionsService.invalidateCache();
        result.exportOutput = [exportedDefinitions.stdout.trim(), exportedDefinitions.stderr.trim()]
          .filter(Boolean)
          .join("\n");
        result.rolledBack = true;
        result.restoredCount = result.targets.length;

        try {
          await appendAudit(auditFilePath, {
            at: new Date().toISOString(),
            status: "rollback_applied",
            restoredCount: result.restoredCount,
            targets: result.targets.map((target) => ({
              formPath: target.formPath,
              fieldId: target.fieldId,
              formulaKind: target.formulaKind,
              builderFilePath: target.builderFilePath,
              backupFilePath: target.backupFilePath,
              safetyBackupFilePath: target.safetyBackupFilePath,
            })),
          });
        } catch (auditError) {
          result.warnings.push(
            `rollback audit 紀錄寫入失敗（回復本身已成功）：${
              auditError instanceof Error ? auditError.message : String(auditError)
            }`
          );
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.blockers.push(`回復套用前失敗：${message}`);
        try {
          suppressRagicDefinitionsWatchPaths(
            result.targets.map((target) => target.builderFilePath),
            { builderRoot }
          );
          await restoreSafetyBackups();
          const exportedDefinitions = await exportDefinitions({
            builderRoot,
            definitionsRoot,
            namespaces,
          });
          definitionsService.invalidateCache();
          result.exportOutput = [exportedDefinitions.stdout.trim(), exportedDefinitions.stderr.trim()]
            .filter(Boolean)
            .join("\n");
        } catch (rollbackExportError) {
          result.warnings.push(
            `還原 safety backup 後 re-export 失敗：${
              rollbackExportError instanceof Error
                ? rollbackExportError.message
                : String(rollbackExportError)
            }`
          );
        }
        try {
          await appendAudit(auditFilePath, {
            at: new Date().toISOString(),
            status: "rollback_failed",
            error: message,
            targets: result.targets.map((target) => ({
              formPath: target.formPath,
              fieldId: target.fieldId,
              formulaKind: target.formulaKind,
              builderFilePath: target.builderFilePath,
              backupFilePath: target.backupFilePath,
              safetyBackupFilePath: target.safetyBackupFilePath,
              restored: target.restored,
            })),
          });
        } catch {
          // 失敗路徑不能再因 audit 寫入問題蓋掉真正錯誤
        }
        return result;
      }
    });
  }

  return {
    applyFormulaPatch,
    applyFormulaPatchBatch,
    rollbackLatestFormulaPatch,
  };
}

export type RagicFormulaPatchApplyService = ReturnType<
  typeof createRagicFormulaPatchApplyService
>;

export const ragicFormulaPatchApplyService = createRagicFormulaPatchApplyService();
