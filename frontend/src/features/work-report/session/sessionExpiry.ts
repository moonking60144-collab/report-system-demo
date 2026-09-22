export const WORK_REPORT_SESSION_EXPIRED_ROUTE = "/session-expired";
export const WORK_REPORT_SESSION_CREATED_AT_STORAGE_KEY =
  "work-report:session-created-at:v1";
export const WORK_REPORT_LAST_ACTIVITY_AT_STORAGE_KEY =
  "work-report:last-activity-at:v1";

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

function readNumberEnv(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const WORK_REPORT_SESSION_IDLE_TIMEOUT_MS = readNumberEnv(
  import.meta.env.VITE_WORK_REPORT_SESSION_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS
);

export type WorkReportSessionExpiredReason =
  | "idle-timeout"
  | "forced-by-admin";

function readSessionStorageValue(key: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return String(window.sessionStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

function writeSessionStorageValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!value) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, value);
  } catch {
    // NOTE: sessionStorage 寫入失敗時不阻塞主流程
  }
}

function readTimestamp(key: string): number | null {
  const rawValue = readSessionStorageValue(key);
  if (!rawValue) {
    return null;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function writeTimestamp(key: string, value: number): void {
  writeSessionStorageValue(key, String(Math.trunc(value)));
}

export function clearWorkReportSessionExpiryState(): void {
  writeSessionStorageValue(WORK_REPORT_SESSION_CREATED_AT_STORAGE_KEY, "");
  writeSessionStorageValue(WORK_REPORT_LAST_ACTIVITY_AT_STORAGE_KEY, "");
}

export function ensureWorkReportSessionState(now = Date.now()): {
  sessionCreatedAt: number;
  lastActivityAt: number;
} {
  const existingSessionCreatedAt = readTimestamp(
    WORK_REPORT_SESSION_CREATED_AT_STORAGE_KEY
  );
  const existingLastActivityAt = readTimestamp(
    WORK_REPORT_LAST_ACTIVITY_AT_STORAGE_KEY
  );
  const sessionCreatedAt = existingSessionCreatedAt ?? now;
  const lastActivityAt = existingLastActivityAt ?? now;
  if (!existingSessionCreatedAt) {
    writeTimestamp(WORK_REPORT_SESSION_CREATED_AT_STORAGE_KEY, sessionCreatedAt);
  }
  if (!existingLastActivityAt) {
    writeTimestamp(WORK_REPORT_LAST_ACTIVITY_AT_STORAGE_KEY, lastActivityAt);
  }
  return {
    sessionCreatedAt,
    lastActivityAt,
  };
}

export function markWorkReportSessionActivity(now = Date.now()): void {
  ensureWorkReportSessionState(now);
  writeTimestamp(WORK_REPORT_LAST_ACTIVITY_AT_STORAGE_KEY, now);
}

export function readWorkReportSessionState(): {
  sessionCreatedAt: number | null;
  lastActivityAt: number | null;
} {
  return {
    sessionCreatedAt: readTimestamp(WORK_REPORT_SESSION_CREATED_AT_STORAGE_KEY),
    lastActivityAt: readTimestamp(WORK_REPORT_LAST_ACTIVITY_AT_STORAGE_KEY),
  };
}

export function sanitizeWorkReportReturnToPath(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim();
  if (!normalized.startsWith("/")) {
    return "/";
  }
  if (normalized.startsWith(WORK_REPORT_SESSION_EXPIRED_ROUTE)) {
    return "/";
  }
  return normalized;
}

export function buildWorkReportSessionExpiredPath(
  returnTo: string,
  reason: WorkReportSessionExpiredReason
): string {
  const searchParams = new URLSearchParams();
  searchParams.set("returnTo", sanitizeWorkReportReturnToPath(returnTo));
  searchParams.set("reason", reason);
  return `${WORK_REPORT_SESSION_EXPIRED_ROUTE}?${searchParams.toString()}`;
}

export function isWorkReportSessionExpiredPath(pathname: string): boolean {
  return String(pathname ?? "").trim() === WORK_REPORT_SESSION_EXPIRED_ROUTE;
}
