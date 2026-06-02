import axios, { type AxiosInstance } from "axios";

/**
 * 所有 API 檔案共用的 axios factory。
 * - 統一 baseURL（讓環境變數切換乾淨）
 * - 統一 default timeout（單一請求可用 per-request override）
 * - 未來要加 interceptor / retry / auth 都只改這一個地方
 *
 * baseURL 預設為相對路徑 "/api"，配合 single-service 部署（Fly.io / 自架）
 * 直接走同源請求，免設定 CORS。本機開發若前端跑在 5173、後端跑在 3000，
 * 由 vite dev server 或 VITE_API_BASE_URL=http://localhost:3000/api 覆蓋。
 */
export function createApiClient(options: { timeoutMs?: number } = {}): AxiosInstance {
  return axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL ?? "/api",
    timeout: options.timeoutMs ?? 30000,
  });
}
