import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";
import { form16ClientRowKeyRepository } from "../../storage/sqlite/form16ClientRowKeyRepository";

/**
 * Form 16 寫入的 idempotency 包裝器。
 *
 * 使用情境：使用者按送出 → network timeout / UI 卡住 → 使用者又按一次。
 * 每次 click 如果 frontend 重用同一個 clientRowKey，這支 service 就能把多次 call
 * 收斂成「第一次寫 Ragic、之後都回同一筆 entryId」，避免 Form 16 出現重複 entry。
 *
 * 實際 Ragic 寫入流程由 `create` callback 負責（含 post-write verify、action button、
 * rollback 等）。本 service 只處理「查舊映射 / 記新映射」。
 *
 * 失敗語意：
 *   - `create` 拋錯：不記映射，下次 retry 同 clientRowKey 會重新嘗試
 *   - `create` 回傳 entryId = null：不記映射，下次 retry 會重新嘗試
 *   - 成功（entryId 非 null）：記錄映射，下次同 key 直接回舊 entryId
 *
 * 並發語意（TOCTOU 防護）：同 key 兩個請求同時進來時，lookup 都會 miss（先到者
 * 還沒 record），若各自 create 就重複開單。因此同 key 的 create 流程用 in-flight
 * Map 收斂：後到者直接等先到者的結果（reused=true），不重複打 Ragic；先到者
 * 失敗時等待者收到同一個錯誤，Map 隨即清掉，後續 retry 能重新嘗試。
 */

const inflightByKey = new Map<string, Promise<Form16IdempotencyResult>>();
const INDETERMINATE_WRITE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
]);
const INDETERMINATE_RAGIC_WRITE_RESULT_CODES = new Set([
  "RAGIC_WRITE_GONE",
  "RAGIC_WRITE_ROLLBACK_DELETED",
  "RAGIC_WRITE_ROLLBACK_UNCONFIRMED",
]);

export interface Form16IdempotencyCreateResult {
  entryId: string | null;
}

export interface Form16IdempotencyInput {
  /** 前端產的 UUID，同一次送出流程重用同一個 */
  clientRowKey: string | null | undefined;
  /** 來源標記，用於 debug / 稽核，例如 "downtime"、"work-report-104" */
  source: string;
  /** 真正打 Ragic 寫入 + 後續處理的 callback；回 entryId 或 null */
  create: () => Promise<Form16IdempotencyCreateResult>;
}

export interface Form16IdempotencyResult {
  entryId: string | null;
  /** true = 命中既有映射，create 沒有執行；false = 真的打過 Ragic */
  reused: boolean;
}

function readUnknownRecord(input: unknown): Record<string, unknown> | null {
  return Boolean(input) && typeof input === "object" ? (input as Record<string, unknown>) : null;
}

function getNestedRecord(input: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return readUnknownRecord(input[key]);
}

function getHttpErrorUpstreamStatus(error: HttpError): number | undefined {
  const record = readUnknownRecord(error);
  const upstreamDetail = record ? getNestedRecord(record, "upstreamDetail") : null;
  const status = upstreamDetail?.status;
  return typeof status === "number" ? status : undefined;
}

function getErrorHttpStatus(error: unknown): number | undefined {
  if (error instanceof HttpError) {
    return getHttpErrorUpstreamStatus(error) ?? error.statusCode;
  }
  const record = readUnknownRecord(error);
  const response = record ? getNestedRecord(record, "response") : null;
  const status = response?.status;
  return typeof status === "number" ? status : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  const record = readUnknownRecord(error);
  const code = record?.code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldMarkCreateResultIndeterminate(error: unknown): boolean {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);

  if (error instanceof HttpError) {
    if (code && INDETERMINATE_RAGIC_WRITE_RESULT_CODES.has(code)) {
      return true;
    }
    if (code === "RAGIC_ACTION_BUTTON_INDETERMINATE") {
      return true;
    }
    if (code !== "RAGIC_WRITE_FAILED") {
      return false;
    }
    if (message.includes("新增成功但讀不到新明細列")) {
      return true;
    }
    const httpStatus = getErrorHttpStatus(error);
    if (typeof httpStatus === "number") {
      return httpStatus >= 500;
    }
    return Array.from(INDETERMINATE_WRITE_ERROR_CODES).some((knownCode) =>
      message.includes(knownCode)
    );
  }

  const status = getErrorHttpStatus(error);
  if (typeof status === "number" && status >= 500) {
    return true;
  }
  if (code && INDETERMINATE_WRITE_ERROR_CODES.has(code)) {
    return true;
  }
  return Array.from(INDETERMINATE_WRITE_ERROR_CODES).some((knownCode) =>
    message.includes(knownCode)
  );
}

function throwIndeterminateForm16Write(
  status: "pending" | "indeterminate",
  errorMessage?: string
): never {
  const message =
    status === "pending"
      ? "Form 16 寫入仍在處理中，已暫停同 clientRowKey 重送，請稍後重新整理確認結果。"
      : `Form 16 寫入結果尚未確認，已暫停同 clientRowKey 重送，請先確認是否已建立。${
          errorMessage ? ` 原因：${errorMessage}` : ""
        }`;
  throw new HttpError(409, message, "FORM16_WRITE_INDETERMINATE");
}

export async function checkOrCreateForm16Entry(
  input: Form16IdempotencyInput
): Promise<Form16IdempotencyResult> {
  const key = String(input.clientRowKey ?? "").trim();

  // 沒 clientRowKey 就直接 create。服務仍然可用，只是沒有 idempotency 保護
  // （保留給過渡期或舊 client 沒傳 key 的請求）
  if (!key) {
    const result = await input.create();
    return { entryId: result.entryId, reused: false };
  }

  // SQLite 關閉時也直接 create（保功能可用，失去 idempotency）
  if (!env.SQLITE_ENABLED) {
    const result = await input.create();
    return { entryId: result.entryId, reused: false };
  }

  // 0. 同 key 已有進行中的 create → 等它的結果，不重複打 Ragic
  const inflight = inflightByKey.get(key);
  if (inflight) {
    const settled = await inflight;
    return { entryId: settled.entryId, reused: true };
  }

  const task = (async (): Promise<Form16IdempotencyResult> => {
    // 1. 先 reserve pending。這一步要早於 Ragic create，才能擋 backend 重啟或
    // Cloudflare/timeout 造成的「寫入可能成功但回應未知」重送。
    const reserveResult = await form16ClientRowKeyRepository.reservePending({
      clientRowKey: key,
      source: input.source,
    });
    if (!reserveResult.reserved) {
      const existing = reserveResult.record;
      if (existing?.status === "confirmed" && existing.entryId) {
        return { entryId: existing.entryId, reused: true };
      }
      if (existing?.status === "pending" || existing?.status === "indeterminate") {
        throwIndeterminateForm16Write(existing.status, existing.errorMessage);
      }
      throw new HttpError(
        409,
        "Form 16 寫入 idempotency key 已被占用，但查不到可重用的 entryId，請重新整理後再試。",
        "FORM16_WRITE_INDETERMINATE"
      );
    }

    // 2. 沒映射就真的打 Ragic（create 內部可能再失敗）
    let result: Form16IdempotencyCreateResult;
    try {
      result = await input.create();
    } catch (error) {
      if (shouldMarkCreateResultIndeterminate(error)) {
        await form16ClientRowKeyRepository.markIndeterminate({
          clientRowKey: key,
          source: input.source,
          errorMessage: getErrorMessage(error),
        });
      } else {
        await form16ClientRowKeyRepository.releasePending({
          clientRowKey: key,
          source: input.source,
        });
      }
      throw error;
    }

    // 3. 只有 create 實際回了 entryId 才記映射
    //    回 null 時不記，下次同 key 重試能重新嘗試（而不是被空值永久 pin 住）
    if (result.entryId) {
      await form16ClientRowKeyRepository.confirm({
        clientRowKey: key,
        entryId: result.entryId,
        source: input.source,
      });
    } else {
      await form16ClientRowKeyRepository.releasePending({
        clientRowKey: key,
        source: input.source,
      });
    }

    return { entryId: result.entryId, reused: false };
  })();

  inflightByKey.set(key, task);
  try {
    return await task;
  } finally {
    inflightByKey.delete(key);
  }
}
