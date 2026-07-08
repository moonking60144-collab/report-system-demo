const CLIENT_ID_STORAGE_KEY = "work-report:client-id:v1";
const TAB_ID_STORAGE_KEY = "work-report:tab-id:v1";
const CLIENT_BOOT_ID_STORAGE_KEY = "work-report:client-boot-id:v1";

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

function shouldRefreshClonedTabScopedIdentity(existing: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (!existing) {
    return false;
  }
  const navigationType = readNavigationType();
  // NOTE: duplicated tab 會把 sessionStorage 一起複製，但通常仍是新的 navigate document。
  // 這裡只在「sessionStorage 已有值 + 本次是 navigate」時重建 tab/boot identity，
  // 避免 duplicated tab 跟原 tab 共用同一組 tabId / clientBootId。
  return navigationType === "navigate";
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
  if (typeof window === "undefined") {
    return buildId("tab");
  }
  const existing = String(window.sessionStorage.getItem(TAB_ID_STORAGE_KEY) ?? "").trim();
  if (existing && !shouldRefreshClonedTabScopedIdentity(existing)) {
    return existing;
  }
  const next = buildId("tab");
  window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, next);
  return next;
}

export function getOrCreateClientBootId(): string {
  if (typeof window === "undefined") {
    return buildId("boot");
  }
  const existing = String(window.sessionStorage.getItem(CLIENT_BOOT_ID_STORAGE_KEY) ?? "").trim();
  if (existing && !shouldRefreshClonedTabScopedIdentity(existing)) {
    return existing;
  }
  const next = buildId("boot");
  window.sessionStorage.setItem(CLIENT_BOOT_ID_STORAGE_KEY, next);
  return next;
}
