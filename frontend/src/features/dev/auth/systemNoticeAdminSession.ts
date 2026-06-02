/**
 * Dev panel admin token storage.
 *
 * 用 localStorage（不是 sessionStorage），讓使用者關 tab / 重開瀏覽器後
 * 仍維持登入。Backend TTL 預設一週，過期就會 401，前端會走 logout flow。
 *
 * 內部 IT 工具、藏 URL，安全模型不要求 tab 級隔離。
 */
const SYSTEM_NOTICE_TOKEN_STORAGE_KEY = "work-report:system-notice-admin-token:v1";

export function readSystemNoticeAdminToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return String(window.localStorage.getItem(SYSTEM_NOTICE_TOKEN_STORAGE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

export function writeSystemNoticeAdminToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!token) {
      window.localStorage.removeItem(SYSTEM_NOTICE_TOKEN_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SYSTEM_NOTICE_TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore
  }
}
