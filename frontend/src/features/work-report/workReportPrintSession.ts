import type { UiLanguage } from "./types";
import { writeWorkReportPrintWindow } from "./workReportPrint";

const WORK_REPORT_PRINT_SESSION_VERSION = 1;
const WORK_REPORT_PRINT_SESSION_TTL_MS = 30 * 60 * 1_000;
const WORK_REPORT_PRINT_ROUTE_PREFIX = "/work-report/print/";
const WORK_REPORT_PRINT_STORAGE_PREFIX = "work-report:print-session:";
const WORK_REPORT_PRINT_SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

interface WorkReportPrintSessionPayload {
  version: typeof WORK_REPORT_PRINT_SESSION_VERSION;
  sessionId: string;
  language: UiLanguage;
  documentHtml: string;
  createdAt: number;
  expiresAt: number;
}

export type WorkReportPrintSessionReadResult =
  | { status: "ready"; payload: WorkReportPrintSessionPayload }
  | { status: "missing"; language: UiLanguage }
  | { status: "expired"; language: UiLanguage }
  | { status: "invalid"; language: UiLanguage }
  | { status: "storage-unavailable"; language: UiLanguage };

function storageKey(sessionId: string): string {
  return `${WORK_REPORT_PRINT_STORAGE_PREFIX}${sessionId}`;
}

function normalizeLanguage(value: unknown): UiLanguage {
  return value === "en" ? "en" : "zh";
}

function createWorkReportPrintSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `print-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidPayload(
  value: unknown,
  expectedSessionId: string
): value is WorkReportPrintSessionPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<WorkReportPrintSessionPayload>;
  return (
    payload.version === WORK_REPORT_PRINT_SESSION_VERSION &&
    payload.sessionId === expectedSessionId &&
    (payload.language === "zh" || payload.language === "en") &&
    typeof payload.documentHtml === "string" &&
    payload.documentHtml.length > 0 &&
    typeof payload.createdAt === "number" &&
    Number.isFinite(payload.createdAt) &&
    typeof payload.expiresAt === "number" &&
    Number.isFinite(payload.expiresAt) &&
    payload.expiresAt > payload.createdAt
  );
}

export function createWorkReportPrintSession(
  storage: Storage,
  documentHtml: string,
  language: UiLanguage,
  now = Date.now(),
  sessionId: string = createWorkReportPrintSessionId()
): { sessionId: string; path: string } {
  if (!WORK_REPORT_PRINT_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("列印預覽識別碼不合法");
  }
  const payload: WorkReportPrintSessionPayload = {
    version: WORK_REPORT_PRINT_SESSION_VERSION,
    sessionId,
    language,
    documentHtml,
    createdAt: now,
    expiresAt: now + WORK_REPORT_PRINT_SESSION_TTL_MS,
  };
  storage.setItem(storageKey(sessionId), JSON.stringify(payload));
  return {
    sessionId,
    path: `${WORK_REPORT_PRINT_ROUTE_PREFIX}${encodeURIComponent(sessionId)}`,
  };
}

export function readWorkReportPrintSession(
  storage: Storage,
  sessionId: string,
  now = Date.now()
): WorkReportPrintSessionReadResult {
  if (!WORK_REPORT_PRINT_SESSION_ID_PATTERN.test(sessionId)) {
    return { status: "invalid", language: "zh" };
  }
  const key = storageKey(sessionId);
  const raw = storage.getItem(key);
  if (!raw) {
    return { status: "missing", language: "zh" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(key);
    return { status: "invalid", language: "zh" };
  }
  const language = normalizeLanguage(
    parsed && typeof parsed === "object"
      ? (parsed as { language?: unknown }).language
      : null
  );
  if (!isValidPayload(parsed, sessionId)) {
    storage.removeItem(key);
    return { status: "invalid", language };
  }
  if (parsed.expiresAt <= now) {
    storage.removeItem(key);
    return { status: "expired", language: parsed.language };
  }
  return { status: "ready", payload: parsed };
}

export function parseWorkReportPrintSessionId(pathname: string): string | null {
  if (!pathname.startsWith(WORK_REPORT_PRINT_ROUTE_PREFIX)) {
    return null;
  }
  const encodedSessionId = pathname.slice(WORK_REPORT_PRINT_ROUTE_PREFIX.length);
  if (!encodedSessionId || encodedSessionId.includes("/")) {
    return "";
  }
  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    return "";
  }
}

function buildWorkReportPrintRecoveryDocument(
  result: Exclude<WorkReportPrintSessionReadResult, { status: "ready" }>
): string {
  const isEnglish = result.language === "en";
  const title = isEnglish ? "Print preview unavailable" : "列印預覽無法還原";
  const detail =
    result.status === "expired"
      ? isEnglish
        ? "This print preview has expired. Return to the work report and create it again."
        : "這份列印預覽已超過 30 分鐘，請回到報工頁重新建立。"
      : result.status === "storage-unavailable"
        ? isEnglish
          ? "This browser cannot access the print session. Return to the work report and create it again."
          : "瀏覽器目前無法讀取列印工作階段，請回到報工頁重新建立。"
        : isEnglish
          ? "The print session is missing or invalid. Return to the work report and create it again."
          : "找不到有效的列印工作階段，請回到報工頁重新建立。";
  const close = isEnglish ? "Close" : "關閉";
  return `<!doctype html>
<html lang="${isEnglish ? "en" : "zh-Hant"}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #e7edf1; color: #152739; font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif; }
    main { width: min(560px, 100%); padding: 28px; border-top: 4px solid #17688b; background: #fff; box-shadow: 0 16px 44px rgba(27, 48, 65, .16); }
    p { margin: 0; color: #53697b; font-size: 15px; line-height: 1.7; }
    h1 { margin: 0 0 12px; font-size: 26px; line-height: 1.2; }
    footer { display: flex; justify-content: flex-end; margin-top: 24px; }
    button { min-width: 96px; min-height: 44px; padding: 10px 18px; border: 1px solid #17688b; border-radius: 4px; background: #17688b; color: #fff; font: inherit; font-weight: 800; cursor: pointer; }
    button:focus-visible { outline: 3px solid #77c7ec; outline-offset: 3px; }
  </style>
</head>
<body><main><h1>${title}</h1><p>${detail}</p><footer><button id="work-report-close-action" type="button">${close}</button></footer></main></body>
</html>`;
}

export function renderWorkReportPrintRoute(target: Window): boolean {
  const sessionId = parseWorkReportPrintSessionId(target.location.pathname);
  if (sessionId === null) {
    return false;
  }
  let result: WorkReportPrintSessionReadResult;
  try {
    result = readWorkReportPrintSession(target.sessionStorage, sessionId);
  } catch {
    result = { status: "storage-unavailable", language: "zh" };
  }
  if (result.status === "ready") {
    writeWorkReportPrintWindow(target, result.payload.documentHtml);
  } else {
    writeWorkReportPrintWindow(
      target,
      buildWorkReportPrintRecoveryDocument(result)
    );
  }
  return true;
}
