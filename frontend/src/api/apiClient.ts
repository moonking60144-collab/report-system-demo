import axios, { type AxiosInstance } from "axios";

/**
 * 所有 API 檔案共用的 axios factory。
 * - 統一 baseURL（讓環境變數切換乾淨）
 * - 統一 default timeout（單一請求可用 per-request override）
 * - 未來要加 interceptor / retry / auth 都只改這一個地方
 */
export function createApiClient(
  options: { timeoutMs?: number; withCredentials?: boolean } = {}
): AxiosInstance {
  return axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL ?? "/api",
    timeout: options.timeoutMs ?? 30000,
    withCredentials: options.withCredentials ?? false,
  });
}
