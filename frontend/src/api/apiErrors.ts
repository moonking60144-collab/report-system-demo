import { isAxiosError } from "axios";

/** 401 判斷 — 三個 modal/component 之前各自重複實作了一份，集中在此 */
export function isUnauthorized(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 401;
}

/** 取 backend HttpError 的 code（{ error: { code } }）；非 axios / 無 code → null */
export function getErrorCode(error: unknown): string | null {
  if (isAxiosError(error)) {
    const data = error.response?.data as { error?: { code?: string } } | undefined;
    return data?.error?.code ?? null;
  }
  return null;
}

/**
 * 從 axios error 抽 backend 回傳的中文訊息（HttpError 格式：{ error: { message } }）。
 * 走過：axios → Error → fallback string。
 */
export function extractErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    const data = error.response?.data as { error?: { message?: string } } | undefined;
    if (data?.error?.message) return data.error.message;
  }
  return error instanceof Error ? error.message : fallback;
}
