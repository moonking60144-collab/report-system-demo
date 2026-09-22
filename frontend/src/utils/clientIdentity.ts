const CLIENT_ID_STORAGE_KEY = "work-report:client-id:v1";
const TAB_ID_STORAGE_KEY = "work-report:tab-id:v1";
const CLIENT_BOOT_ID_STORAGE_KEY = "work-report:client-boot-id:v1";
const DEVICE_LABEL_STORAGE_KEY = "work-report:device-label:v1";
const LEGACY_DEVICE_LABEL_STORAGE_KEY = "debug.deviceLabel";
const DEVICE_LABEL_MAX_LENGTH = 60;

interface TabScopedIdentity {
  tabId: string;
  clientBootId: string;
}

let currentTabScopedIdentity: TabScopedIdentity | null = null;

function normalizeDeviceLabel(value: unknown): string {
  return String(value ?? "").trim().replace(/[\r\n]+/g, " ").slice(0, DEVICE_LABEL_MAX_LENGTH);
}

function buildId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readNavigationType(): string {
  if (typeof window === "undefined" || typeof performance === "undefined") {
    return "";
  }
  const navigationEntry = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return String(navigationEntry?.type ?? "").trim().toLowerCase();
}

function shouldRefreshClonedTabScopedIdentity(existing: TabScopedIdentity): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (!existing.tabId && !existing.clientBootId) {
    return false;
  }
  const navigationType = readNavigationType();
  // NOTE: duplicated tab 會把 sessionStorage 一起複製，但通常仍是新的 navigate document。
  // 這裡只在「sessionStorage 已有值 + 本次是 navigate」時重建 tab/boot identity，
  // 避免 duplicated tab 跟原 tab 共用同一組 tabId / clientBootId。
  return navigationType === "navigate";
}

function getOrCreateTabScopedIdentity(): TabScopedIdentity {
  if (typeof window === "undefined") {
    return {
      tabId: buildId("tab"),
      clientBootId: buildId("boot"),
    };
  }
  if (currentTabScopedIdentity) {
    return currentTabScopedIdentity;
  }

  const existing = {
    tabId: String(window.sessionStorage.getItem(TAB_ID_STORAGE_KEY) ?? "").trim(),
    clientBootId: String(
      window.sessionStorage.getItem(CLIENT_BOOT_ID_STORAGE_KEY) ?? ""
    ).trim(),
  };
  const refresh = shouldRefreshClonedTabScopedIdentity(existing);
  currentTabScopedIdentity = {
    tabId: refresh || !existing.tabId ? buildId("tab") : existing.tabId,
    clientBootId:
      refresh || !existing.clientBootId ? buildId("boot") : existing.clientBootId,
  };
  window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, currentTabScopedIdentity.tabId);
  window.sessionStorage.setItem(
    CLIENT_BOOT_ID_STORAGE_KEY,
    currentTabScopedIdentity.clientBootId
  );
  return currentTabScopedIdentity;
}

export function getOrCreateClientId(): string {
  if (typeof window === "undefined") {
    return buildId("client");
  }
  const existing = String(window.localStorage.getItem(CLIENT_ID_STORAGE_KEY) ?? "").trim();
  if (existing) {
    return existing;
  }
  const next = buildId("client");
  window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, next);
  return next;
}

export function getOrCreateTabId(): string {
  return getOrCreateTabScopedIdentity().tabId;
}

export function getOrCreateClientBootId(): string {
  return getOrCreateTabScopedIdentity().clientBootId;
}

export function readWorkReportDeviceLabel(): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    const current = normalizeDeviceLabel(window.localStorage.getItem(DEVICE_LABEL_STORAGE_KEY));
    if (current) {
      return current;
    }
    return normalizeDeviceLabel(window.localStorage.getItem(LEGACY_DEVICE_LABEL_STORAGE_KEY));
  } catch {
    return "";
  }
}

export function encodeTaskActorLabelHeader(value: unknown): string {
  return encodeURIComponent(normalizeDeviceLabel(value));
}

export function writeWorkReportDeviceLabel(value: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const normalized = normalizeDeviceLabel(value);
    if (!normalized) {
      window.localStorage.removeItem(DEVICE_LABEL_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_DEVICE_LABEL_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(DEVICE_LABEL_STORAGE_KEY, normalized);
  } catch {
    return;
  }
}
