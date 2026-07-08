import type {
  RagicDefinitionFormula,
  RagicDefinitionFormDetail,
  RagicDefinitionsVersionControlStatus,
  RagicFormulaPatchDryRunInput,
} from "../../../api/devRagicDefinitions";

export const SEARCH_DEBOUNCE_MS = 250;
export const DEFAULT_BASELINE_COMMIT_MESSAGE =
  "chore(ragic): 更新 definitions baseline";
export const SELECTED_FORM_STORAGE_KEY = "ragicDefinitionsSelectedFormPath";
export const EMPTY_DRY_RUN_DRAFT: RagicFormulaPatchDryRunInput = {
  formPath: "",
  fieldId: "",
  formulaKind: "formula",
  newFormula: "",
};
export const FORMULA_KIND_LABELS: Record<RagicDefinitionFormula["formulaKind"], string> = {
  formula: "公式",
  defaultFormula: "預設公式",
};

export interface FormulaPatchErrorDialogContext {
  title: string;
  message: string;
  blockers: string[];
  warnings: string[];
  fatalValidationErrors: string[];
  formPaths: string[];
  sheetPath?: string;
  sourceEncoding?: string;
  requestId?: string;
  traceId?: string;
  raw: string;
}

export interface WorkflowOutline {
  lineCount: number;
  referencedFields: Array<{ fieldId: string; fieldName: string; position: string }>;
  unknownFieldIds: string[];
  targetSheets: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectValuesByKey(
  value: unknown,
  key: string,
  values: Set<string>,
  seen: Set<object>
) {
  if (!isRecord(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectValuesByKey(item, key, values, seen);
    }
    return;
  }

  const next = value as Record<string, unknown>;
  const candidate = next[key];
  if (typeof candidate === "string" && candidate.trim()) {
    values.add(candidate.trim());
  }

  for (const field of Object.values(next)) {
    collectValuesByKey(field, key, values, seen);
  }
}

function collectArrayValuesByKey(
  value: unknown,
  key: string,
  values: Set<string>,
  seen: Set<object>
) {
  if (!isRecord(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectArrayValuesByKey(item, key, values, seen);
    }
    return;
  }

  const next = value as Record<string, unknown>;
  const candidate = next[key];
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      if (typeof item === "string" && item.trim()) {
        values.add(item.trim());
      }
    }
  }

  for (const field of Object.values(next)) {
    collectArrayValuesByKey(field, key, values, seen);
  }
}

function readValue(value: unknown, keys: string | readonly string[]): string | undefined {
  if (!isRecord(value) || !keys) return undefined;
  const path = Array.isArray(keys) ? keys : [keys];
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    const candidate = current[key];
    if (candidate === null || candidate === undefined) return undefined;
    current = candidate;
  }
  if (typeof current === "string" && current.trim()) {
    return current.trim();
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  if (value === undefined) return "（無原始回應可顯示）";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createFormulaPatchErrorDialogContextInternal(
  payload: unknown
): Pick<
  FormulaPatchErrorDialogContext,
  "formPaths" | "sheetPath" | "sourceEncoding" | "requestId" | "traceId" | "fatalValidationErrors"
> {
  const formPaths = new Set<string>();
  const sheetPaths = new Set<string>();
  const sourceEncodings = new Set<string>();
  const requestIds = new Set<string>();
  const traceIds = new Set<string>();
  const fatalValidationErrors = new Set<string>();

  collectValuesByKey(payload, "formPath", formPaths, new Set());
  collectValuesByKey(payload, "sourceEncoding", sourceEncodings, new Set());
  collectValuesByKey(payload, "requestId", requestIds, new Set());
  collectValuesByKey(payload, "traceId", traceIds, new Set());
  collectValuesByKey(payload, "sheetPath", sheetPaths, new Set());
  collectValuesByKey(payload, "sourceRelativePath", sheetPaths, new Set());
  collectArrayValuesByKey(payload, "fatalValidationErrors", fatalValidationErrors, new Set());
  collectArrayValuesByKey(payload, "validationErrors", fatalValidationErrors, new Set());

  const metaFromRecord = isRecord(payload) ? payload : null;
  const fallbackSourceEncoding = readValue(metaFromRecord, ["form", "sourceEncoding"]);
  const fallbackSheetPath = readValue(metaFromRecord, "sheetPath")
    ?? readValue(metaFromRecord, "sourceRelativePath")
    ?? readValue(metaFromRecord, "builderFilePath");
  const fallbackRequestId = readValue(metaFromRecord, "requestId");
  const fallbackTraceId = readValue(metaFromRecord, "traceId");

  return {
    formPaths: [...formPaths],
    sheetPath: [...sheetPaths][0] ?? fallbackSheetPath,
    sourceEncoding:
      [...sourceEncodings][0] ?? readValue(metaFromRecord, ["sourceEncoding"]) ?? fallbackSourceEncoding,
    requestId: [...requestIds][0] ?? fallbackRequestId,
    traceId: [...traceIds][0] ?? fallbackTraceId,
    fatalValidationErrors: [...fatalValidationErrors],
  };
}

export function createFormulaPatchErrorDialogContext(
  options: {
    title: string;
    message: string;
    blockers?: unknown;
    warnings?: unknown;
    fatalValidationErrors?: unknown;
    payload?: unknown;
  }
): FormulaPatchErrorDialogContext {
  const meta = createFormulaPatchErrorDialogContextInternal(options.payload);
  const fatalValidationErrors = asStringArray(options.fatalValidationErrors);
  return {
    title: options.title,
    message: options.message,
    blockers: asStringArray(options.blockers).slice(0, 50),
    warnings: asStringArray(options.warnings).slice(0, 50),
    fatalValidationErrors: [...new Set([...fatalValidationErrors, ...meta.fatalValidationErrors])].slice(0, 50),
    formPaths: meta.formPaths,
    sheetPath: meta.sheetPath,
    sourceEncoding: meta.sourceEncoding,
    requestId: meta.requestId,
    traceId: meta.traceId,
    raw: safeStringify(options.payload),
  };
}

export function extractRagicFormPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  let candidate = trimmed;
  try {
    candidate = new URL(trimmed).pathname;
  } catch {
    candidate = trimmed.split(/[?#]/)[0] ?? trimmed;
  }

  const segments = candidate
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  if (segments.length >= 3) {
    return segments.slice(0, 3).join("/");
  }

  return trimmed;
}

export function isCompleteFormPath(input: string): boolean {
  return input.split("/").filter(Boolean).length === 3;
}

export function includesQuery(
  values: Array<string | number | null | undefined>,
  query: string
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return values.some((value) =>
    String(value ?? "").toLowerCase().includes(normalizedQuery)
  );
}

export function looksLikeFormLookup(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(trimmed)) {
    return true;
  }
  return /^\d+$/.test(trimmed);
}

export function readStoredSelectedFormPath(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = extractRagicFormPath(
      params.get("form") ?? params.get("formPath") ?? ""
    );
    if (isCompleteFormPath(fromUrl)) return fromUrl;

    const stored = window.localStorage.getItem(SELECTED_FORM_STORAGE_KEY);
    if (!stored) return null;
    const formPath = extractRagicFormPath(stored);
    return isCompleteFormPath(formPath) ? formPath : null;
  } catch {
    return null;
  }
}

export function writeStoredSelectedFormPath(formPath: string): void {
  try {
    window.localStorage.setItem(SELECTED_FORM_STORAGE_KEY, formPath);
  } catch {
    // localStorage 不可用時只保留本次選取。
  }
}

export function createFormulaDryRunDraft(
  formPath: string,
  formula: RagicDefinitionFormula
): RagicFormulaPatchDryRunInput {
  return {
    formPath,
    fieldId: formula.fieldId,
    formulaKind: formula.formulaKind,
    newFormula: formula.nuiFormula,
  };
}

export function shortCommit(commit: string | null | undefined): string {
  return commit ? commit.slice(0, 7) : "尚未讀取";
}

export function formatRemoteDelta(
  status: RagicDefinitionsVersionControlStatus | null
): string {
  if (!status) return "remote 尚未讀取";
  if (status.ahead === null || status.behind === null) return "remote 狀態未知";
  if (status.ahead === 0 && status.behind === 0) return "與 origin/main 同步";
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`領先 ${status.ahead}`);
  if (status.behind > 0) parts.push(`落後 ${status.behind}`);
  return parts.join(" · ");
}

export function isRemoteBehindBlocker(blocker: string): boolean {
  return /^origin\/main 有 \d+ 個新提交，先同步後再操作 baseline$/.test(blocker);
}

export function canPushBaselineWithAutoSync(
  status: RagicDefinitionsVersionControlStatus | null
): boolean {
  if (!status || status.canPush) return Boolean(status?.canPush);
  if (status.canAutoSyncPush) return true;
  const hasTrackedDirtyEntry = status.entries.some((entry) => entry.status !== "??");
  return (
    status.gitAvailable &&
    status.branch === "main" &&
    !status.error &&
    (status.ahead ?? 0) > 0 &&
    (status.behind ?? 0) > 0 &&
    !hasTrackedDirtyEntry &&
    status.blockers.length > 0 &&
    status.blockers.every(isRemoteBehindBlocker)
  );
}

export function formatLineCount(content: string | null | undefined): number {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

export function createWorkflowOutline(
  content: string | null | undefined,
  detail: RagicDefinitionFormDetail | null
): WorkflowOutline {
  const text = content ?? "";
  const fieldIds = Array.from(new Set(text.match(/\b\d{6,}\b/g) ?? []));
  const fields = new Map((detail?.fields ?? []).map((field) => [field.fieldId, field]));
  const referencedFields = fieldIds
    .map((fieldId) => fields.get(fieldId))
    .filter((field): field is RagicDefinitionFormDetail["fields"][number] =>
      Boolean(field)
    )
    .map((field) => ({
      fieldId: field.fieldId,
      fieldName: field.fieldName,
      position: field.position,
    }));
  const unknownFieldIds = fieldIds.filter((fieldId) => !fields.has(fieldId));
  const targetSheets = Array.from(
    new Set([
      detail?.form.formPath,
      ...(text.match(/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/g) ?? []),
    ])
  ).filter((value): value is string => Boolean(value));

  return {
    lineCount: formatLineCount(text),
    referencedFields,
    unknownFieldIds,
    targetSheets,
  };
}
