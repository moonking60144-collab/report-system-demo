import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { parseNuiFieldLine, splitFirstCommas } from "./ragicNuiParser";

interface NuiField {
  kind: string;
  column: number;
  row: number;
  position: string;
  fieldId: string;
  fieldName: string;
  attrs: Record<string, string>;
  sourceLine: number;
}

interface ExportedFormula {
  fieldId: string;
  fieldName: string;
  position: string;
  formulaKind: "formula" | "defaultFormula";
  nuiFormula: string;
  displayFormula: string;
  sourceLine: number;
}

interface ExportedField {
  fieldId: string;
  fieldName: string;
  kind: string;
  position: string;
  sourceLine: number;
  attrs: Record<string, string>;
}

interface WorkflowSection {
  fileName: string;
  marker: string;
  content: string;
}

interface DecodedNui {
  content: string;
  encoding: string;
}

interface NamespaceFilter {
  mode: "all" | "include";
  namespaces: string[];
}

export interface RagicDefinitionsExportParams {
  builderRoot: string;
  outDir: string;
  namespaces?: string;
  ragicNuiEncoding?: string;
}

export interface RagicDefinitionsExportResult {
  forms: number;
  fields: number;
  formulas: number;
  workflows: number;
  namespaces: string;
  outDir: string;
}

const WORKFLOW_MARKERS = [
  { marker: "PRE_WORKFLOW_START", fileName: "pre.js" },
  { marker: "SCRIPT_START", fileName: "post.js" },
  { marker: "APPROVAL_START", fileName: "approval.js" },
  { marker: "SHEET_SCOPE_START", fileName: "sheet-scope.js" },
] as const;

export function ragicDefinitionsExportUsage(): string {
  return [
    "用法：tsx scripts/export-ragic-definitions.ts [builder-root] [out-dir] [namespaces]",
    "",
    "builder-root 預設讀 RAGIC_BUILDER_PATH，例如 D:\\Ragic\\RagicBuilder\\cust\\def\\app",
    "out-dir 預設 ../ragic-definitions",
    "namespaces 預設 default；可用逗號指定，例如 default,sandbox78957；用 * 匯出全部。",
    "RAGIC_DEFINITION_NAMESPACES 可設定預設 namespaces。",
    "RAGIC_NUI_ENCODING 可指定 utf-8 或 big5；未指定時自動偵測。",
  ].join("\n");
}

function maskSecrets(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "***REDACTED-JWT***")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-***REDACTED***")
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "AIza***REDACTED***")
    .replace(/fdtw-ragic-callback-[A-Za-z0-9_-]+/g, "fdtw-ragic-callback-***REDACTED***");
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function moveIfExists(from: string, to: string): boolean {
  if (!existsSync(from)) return false;
  renameSync(from, to);
  return true;
}

function restoreIfMoved(from: string, to: string, moved: boolean): void {
  if (!moved || !existsSync(from)) return;
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
}

function swapExportedDefinitions(outDir: string, tmpOutDir: string): void {
  const stamp = `${process.pid}-${Date.now()}`;
  const formsPath = join(outDir, "forms");
  const manifestPath = join(outDir, "manifest.json");
  const newFormsPath = join(tmpOutDir, "forms");
  const newManifestPath = join(tmpOutDir, "manifest.json");
  const oldFormsPath = join(outDir, `.forms.previous-${stamp}`);
  const oldManifestPath = join(outDir, `.manifest.previous-${stamp}.json`);

  let oldFormsMoved = false;
  let oldManifestMoved = false;
  try {
    oldFormsMoved = moveIfExists(formsPath, oldFormsPath);
    oldManifestMoved = moveIfExists(manifestPath, oldManifestPath);
    renameSync(newFormsPath, formsPath);
    renameSync(newManifestPath, manifestPath);
    rmSync(oldFormsPath, { recursive: true, force: true });
    rmSync(oldManifestPath, { force: true });
  } catch (error) {
    restoreIfMoved(oldFormsPath, formsPath, oldFormsMoved);
    restoreIfMoved(oldManifestPath, manifestPath, oldManifestMoved);
    throw error;
  }
}

function parseNamespaceFilter(raw: string | undefined): NamespaceFilter {
  const value = raw?.trim() || "default";
  if (value === "*" || value.toLowerCase() === "all") {
    return { mode: "all", namespaces: [] };
  }
  const namespaces = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (namespaces.length === 0) {
    throw new Error(`namespaces 不能是空值。\n${ragicDefinitionsExportUsage()}`);
  }
  return { mode: "include", namespaces: Array.from(new Set(namespaces)).sort() };
}

function namespaceFromFormPath(formPath: string): string | null {
  return formPath.split("/")[0] || null;
}

function shouldIncludeFormPath(formPath: string, filter: NamespaceFilter): boolean {
  if (filter.mode === "all") return true;
  const namespace = namespaceFromFormPath(formPath);
  return namespace !== null && filter.namespaces.includes(namespace);
}

function replacementCount(value: string): number {
  return (value.match(/\uFFFD/g) ?? []).length;
}

function controlCharCount(value: string): number {
  return (value.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
}

function decodeScore(value: string): number {
  return replacementCount(value) * 100 + controlCharCount(value) * 50;
}

function decodeNuiFile(filePath: string, requestedEncodingRaw?: string): DecodedNui {
  const bytes = readFileSync(filePath);
  const requestedEncoding = requestedEncodingRaw?.trim().toLowerCase();
  const supportedEncodings = new Set(["utf-8", "utf8", "big5"]);

  if (requestedEncoding) {
    if (!supportedEncodings.has(requestedEncoding)) {
      throw new Error(`RAGIC_NUI_ENCODING 僅支援 utf-8 或 big5，目前是：${requestedEncoding}`);
    }
    const encoding = requestedEncoding === "utf8" ? "utf-8" : requestedEncoding;
    return {
      content: new TextDecoder(encoding).decode(bytes),
      encoding,
    };
  }

  const utf8Content = new TextDecoder("utf-8").decode(bytes);
  if (replacementCount(utf8Content) === 0) {
    return { content: utf8Content, encoding: "utf-8" };
  }

  const big5Content = new TextDecoder("big5").decode(bytes);
  return decodeScore(big5Content) < decodeScore(utf8Content)
    ? { content: big5Content, encoding: "big5" }
    : { content: utf8Content, encoding: "utf-8" };
}

function displayFormula(nuiFormula: string): string {
  return nuiFormula.replace(/`/g, ",");
}

function parseNuiField(line: string, sourceLine: number): NuiField | null {
  const parsed = parseNuiFieldLine(line, sourceLine);
  if (!parsed) return null;
  return {
    kind: parsed.kind,
    column: parsed.column,
    row: parsed.row,
    position: parsed.position,
    fieldId: parsed.fieldId,
    fieldName: parsed.fieldName,
    attrs: Object.fromEntries(
      parsed.attrs
        .filter((attr) => attr.key)
        .map((attr) => [attr.key, attr.decodedValue])
    ),
    sourceLine,
  };
}

function extractFormName(lines: string[]): string {
  const nameLine = lines.find((line) => line.startsWith("N,"));
  if (!nameLine) return "";
  const parts = splitFirstCommas(nameLine, 2);
  return parts?.[1] ?? "";
}

function formPathFromNui(root: string, filePath: string): string | null {
  const rel = relative(root, filePath);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.some((part) => !part || part === "history")) return null;
  const fileName = parts.at(-1);
  if (!fileName) return null;
  const match = /^(\d+)_Sheet\d+_index\.nui$/.exec(fileName);
  if (!match) return null;
  return [...parts.slice(0, -1), match[1]].join("/");
}

function listNuiFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "history") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /^(\d+)_Sheet\d+_index\.nui$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

function extractWorkflowSections(lines: string[]): WorkflowSection[] {
  const markersByName = new Map<string, string>(
    WORKFLOW_MARKERS.map((item) => [item.marker, item.fileName])
  );
  const sections: WorkflowSection[] = [];
  let currentMarker: string | null = null;
  let current: string[] = [];

  const flush = (): void => {
    if (!currentMarker) return;
    const fileName = markersByName.get(currentMarker);
    if (!fileName) return;
    const content = maskSecrets(current.join("\n").trim());
    if (content) sections.push({ marker: currentMarker, fileName, content });
  };

  for (const line of lines) {
    if (markersByName.has(line)) {
      flush();
      currentMarker = line;
      current = [];
      continue;
    }
    if (currentMarker) current.push(line);
  }
  flush();

  return sections;
}

function exportedFormulas(fields: NuiField[]): ExportedFormula[] {
  const formulas: ExportedFormula[] = [];
  for (const field of fields) {
    const normalFormula = field.attrs.f;
    if (normalFormula !== undefined && normalFormula !== "") {
      const masked = maskSecrets(normalFormula);
      formulas.push({
        fieldId: field.fieldId,
        fieldName: field.fieldName,
        position: field.position,
        formulaKind: "formula",
        nuiFormula: masked,
        displayFormula: displayFormula(masked),
        sourceLine: field.sourceLine,
      });
    }

    const defaultFormula = field.attrs.dv_f;
    if (defaultFormula !== undefined && defaultFormula !== "") {
      const masked = maskSecrets(defaultFormula);
      formulas.push({
        fieldId: field.fieldId,
        fieldName: field.fieldName,
        position: field.position,
        formulaKind: "defaultFormula",
        nuiFormula: masked,
        displayFormula: displayFormula(masked),
        sourceLine: field.sourceLine,
      });
    }
  }
  return formulas.sort((a, b) => Number(a.fieldId) - Number(b.fieldId) || a.formulaKind.localeCompare(b.formulaKind));
}

function exportedFields(fields: NuiField[]): ExportedField[] {
  return fields
    .map((field) => ({
      fieldId: field.fieldId,
      fieldName: field.fieldName,
      kind: field.kind,
      position: field.position,
      sourceLine: field.sourceLine,
      attrs: Object.fromEntries(
        Object.entries(field.attrs)
          .filter(([key]) => key !== "f" && key !== "dv_f")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, maskSecrets(value)])
      ),
    }))
    .sort((a, b) => Number(a.fieldId) - Number(b.fieldId));
}

function exportOne(
  root: string,
  outDir: string,
  filePath: string,
  ragicNuiEncoding?: string
): { formulaCount: number; fieldCount: number; workflowCount: number } {
  const formPath = formPathFromNui(root, filePath);
  if (!formPath) return { formulaCount: 0, fieldCount: 0, workflowCount: 0 };

  const { content, encoding } = decodeNuiFile(filePath, ragicNuiEncoding);
  const lines = content.split(/\r?\n/);
  const fields = lines
    .map((line, index) => parseNuiField(line, index + 1))
    .filter((field): field is NuiField => field !== null);
  const formulas = exportedFormulas(fields);
  const workflows = extractWorkflowSections(lines);

  const formOutDir = join(outDir, "forms", ...formPath.split("/"));
  const workflowDir = join(formOutDir, "workflows");
  ensureDir(formOutDir);
  if (workflows.length > 0) ensureDir(workflowDir);

  writeJson(join(formOutDir, "form.json"), {
    schemaVersion: 1,
    formPath,
    formName: extractFormName(lines),
    nuiFile: basename(filePath),
    sourceEncoding: encoding,
    sourceRelativePath: relative(root, filePath).replace(/\\/g, "/"),
    counts: {
      fields: fields.length,
      formulas: formulas.length,
      workflows: workflows.length,
    },
  });
  writeJson(join(formOutDir, "fields.json"), exportedFields(fields));
  writeJson(join(formOutDir, "formulas.json"), formulas);

  for (const workflow of workflows) {
    writeFileSync(join(workflowDir, workflow.fileName), `${workflow.content}\n`, "utf-8");
  }

  return { formulaCount: formulas.length, fieldCount: fields.length, workflowCount: workflows.length };
}

export function formatRagicDefinitionsExportMessage(
  result: RagicDefinitionsExportResult
): string {
  return `[ragic-definitions] exported forms=${result.forms} fields=${result.fields} formulas=${result.formulas} workflows=${result.workflows} namespaces=${result.namespaces} out=${result.outDir}`;
}

export function exportRagicDefinitions(
  params: RagicDefinitionsExportParams
): RagicDefinitionsExportResult {
  const root = params.builderRoot;
  const outDir = params.outDir;
  const namespaceFilter = parseNamespaceFilter(params.namespaces);
  if (!root) {
    throw new Error(`未提供 builder-root，也沒有設定 RAGIC_BUILDER_PATH。\n${ragicDefinitionsExportUsage()}`);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`builder-root 不存在或不是目錄：${root}`);
  }

  const files = listNuiFiles(root).filter((filePath) => {
    const formPath = formPathFromNui(root, filePath);
    return formPath !== null && shouldIncludeFormPath(formPath, namespaceFilter);
  });
  ensureDir(outDir);
  const tmpOutDir = join(outDir, `.export-tmp-${process.pid}-${Date.now()}`);
  rmSync(tmpOutDir, { recursive: true, force: true });
  ensureDir(join(tmpOutDir, "forms"));

  let formulaCount = 0;
  let fieldCount = 0;
  let workflowCount = 0;
  try {
    for (const filePath of files) {
      const result = exportOne(root, tmpOutDir, filePath, params.ragicNuiEncoding);
      formulaCount += result.formulaCount;
      fieldCount += result.fieldCount;
      workflowCount += result.workflowCount;
    }

    writeJson(join(tmpOutDir, "manifest.json"), {
      schemaVersion: 1,
      namespaceFilter:
        namespaceFilter.mode === "all"
          ? { mode: "all" }
          : { mode: "include", namespaces: namespaceFilter.namespaces },
      counts: {
        forms: files.length,
        fields: fieldCount,
        formulas: formulaCount,
        workflows: workflowCount,
      },
    });
    swapExportedDefinitions(outDir, tmpOutDir);
  } finally {
    rmSync(tmpOutDir, { recursive: true, force: true });
  }

  return {
    forms: files.length,
    fields: fieldCount,
    formulas: formulaCount,
    workflows: workflowCount,
    namespaces:
      namespaceFilter.mode === "all" ? "*" : namespaceFilter.namespaces.join(","),
    outDir,
  };
}
