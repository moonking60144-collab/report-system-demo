export const SYSTEM_NOTICE_TOKEN_STORAGE_KEY = "work-report:system-notice-admin-token:v1";

export type SystemNoticeAdminTokenStorage = "local" | "session";

function readStorageValue(storage: Storage | null): string {
  if (!storage) return "";
  try {
    return String(storage.getItem(SYSTEM_NOTICE_TOKEN_STORAGE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

export function readSystemNoticeAdminToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return (
    readStorageValue(window.sessionStorage) ||
    readStorageValue(window.localStorage)
  );
}

export function writeSystemNoticeAdminToken(
  token: string,
  storage: SystemNoticeAdminTokenStorage = "local"
): void {
  if (typeof window === "undefined") {
    return;
  }
  const target = storage === "session" ? window.sessionStorage : window.localStorage;
  try {
    if (!token) {
      clearSystemNoticeAdminToken();
      return;
    }
    target.setItem(SYSTEM_NOTICE_TOKEN_STORAGE_KEY, token);
    if (storage === "local") {
      window.sessionStorage.removeItem(SYSTEM_NOTICE_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage 不可用時不阻塞主要流程。
  }
}

export function clearSystemNoticeAdminToken(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.removeItem(SYSTEM_NOTICE_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    window.localStorage.removeItem(SYSTEM_NOTICE_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}
