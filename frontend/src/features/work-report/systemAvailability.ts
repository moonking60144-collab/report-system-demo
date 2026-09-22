import type { SystemNoticeRecord } from "../../api/systemNotice";

export const WORK_REPORT_SYSTEM_UNAVAILABLE_ROUTE = "/system-unavailable";
const WORK_REPORT_SYSTEM_NOTICE_AVAILABILITY_CACHE_KEY =
  "work-report:system-notice-availability:v2";

export type WorkReportSystemUnavailableReason =
  | "maintenance"
  | "backend-unavailable";

export interface CachedSystemNoticeAvailabilitySnapshot {
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  startAt: string | null;
  endAt: string | null;
  updatedAt: string | null;
}

interface PersistedSystemNoticeAvailabilitySnapshot
  extends CachedSystemNoticeAvailabilitySnapshot {
  enabled: boolean;
}

function readLocalStorageValue(key: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return String(window.localStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

function writeLocalStorageValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!value) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // NOTE: localStorage 寫入失敗不阻塞主流程
  }
}

export function sanitizeWorkReportAvailabilityReturnToPath(
  value: string | null | undefined
): string {
  const normalized = String(value ?? "").trim();
  if (!normalized.startsWith("/")) {
    return "/";
  }
  if (
    normalized.startsWith(WORK_REPORT_SYSTEM_UNAVAILABLE_ROUTE) ||
    normalized.startsWith("/session-expired")
  ) {
    return "/";
  }
  return normalized;
}

export function buildWorkReportSystemUnavailablePath(
  returnTo: string,
  reason: WorkReportSystemUnavailableReason,
  message?: string | null
): string {
  const searchParams = new URLSearchParams();
  searchParams.set(
    "returnTo",
    sanitizeWorkReportAvailabilityReturnToPath(returnTo)
  );
  searchParams.set("reason", reason);
  const normalizedMessage = String(message ?? "").trim();
  if (normalizedMessage) {
    searchParams.set("message", normalizedMessage);
  }
  return `${WORK_REPORT_SYSTEM_UNAVAILABLE_ROUTE}?${searchParams.toString()}`;
}

export function isWorkReportSystemUnavailablePath(pathname: string): boolean {
  return (
    String(pathname ?? "").trim() === WORK_REPORT_SYSTEM_UNAVAILABLE_ROUTE
  );
}

export function isSystemNoticeActive(
  notice: Pick<SystemNoticeRecord, "enabled" | "startAt" | "endAt">,
  nowMs = Date.now()
): boolean {
  if (!notice.enabled) {
    return false;
  }
  const startAt = notice.startAt ? Date.parse(notice.startAt) : null;
  const endAt = notice.endAt ? Date.parse(notice.endAt) : null;
  if (startAt !== null && Number.isFinite(startAt) && nowMs < startAt) {
    return false;
  }
  if (endAt !== null && Number.isFinite(endAt) && nowMs > endAt) {
    return false;
  }
  return true;
}

export function resolveSystemNoticeAvailabilitySnapshot(
  notice: Pick<
    SystemNoticeRecord,
    "enabled" | "maintenanceMode" | "message" | "startAt" | "endAt" | "updatedAt"
  >,
  nowMs = Date.now()
): CachedSystemNoticeAvailabilitySnapshot {
  return {
    maintenanceMode: notice.maintenanceMode === true && isSystemNoticeActive(notice, nowMs),
    maintenanceMessage: String(notice.message ?? "").trim() || null,
    startAt: String(notice.startAt ?? "").trim() || null,
    endAt: String(notice.endAt ?? "").trim() || null,
    updatedAt: String(notice.updatedAt ?? "").trim() || null,
  };
}

export function cacheSystemNoticeAvailabilitySnapshot(
  notice: Pick<
    SystemNoticeRecord,
    "enabled" | "maintenanceMode" | "message" | "startAt" | "endAt" | "updatedAt"
  >
): void {
  const snapshot: PersistedSystemNoticeAvailabilitySnapshot = {
    enabled: notice.enabled === true,
    maintenanceMode: notice.maintenanceMode === true,
    maintenanceMessage: String(notice.message ?? "").trim() || null,
    startAt: String(notice.startAt ?? "").trim() || null,
    endAt: String(notice.endAt ?? "").trim() || null,
    updatedAt: String(notice.updatedAt ?? "").trim() || null,
  };
  writeLocalStorageValue(
    WORK_REPORT_SYSTEM_NOTICE_AVAILABILITY_CACHE_KEY,
    JSON.stringify(snapshot)
  );
}

export function readCachedSystemNoticeAvailabilitySnapshot(): CachedSystemNoticeAvailabilitySnapshot {
  const raw = readLocalStorageValue(WORK_REPORT_SYSTEM_NOTICE_AVAILABILITY_CACHE_KEY);
  if (!raw) {
    return {
      maintenanceMode: false,
      maintenanceMessage: null,
      startAt: null,
      endAt: null,
      updatedAt: null,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSystemNoticeAvailabilitySnapshot>;
    return resolveSystemNoticeAvailabilitySnapshot({
      enabled: parsed.enabled === true,
      maintenanceMode: parsed.maintenanceMode === true,
      message:
        typeof parsed.maintenanceMessage === "string"
          ? parsed.maintenanceMessage
          : "",
      startAt: typeof parsed.startAt === "string" ? parsed.startAt : null,
      endAt: typeof parsed.endAt === "string" ? parsed.endAt : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    });
  } catch {
    return {
      maintenanceMode: false,
      maintenanceMessage: null,
      startAt: null,
      endAt: null,
      updatedAt: null,
    };
  }
}
