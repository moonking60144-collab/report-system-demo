import { env } from "../../config/env";
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
 */

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

  // 1. 查既有映射
  const existing = await form16ClientRowKeyRepository.lookup(key);
  if (existing) {
    return { entryId: existing.entryId, reused: true };
  }

  // 2. 沒映射就真的打 Ragic（create 內部可能再失敗）
  const result = await input.create();

  // 3. 只有 create 實際回了 entryId 才記映射
  //    回 null 時不記，下次同 key 重試能重新嘗試（而不是被空值永久 pin 住）
  if (result.entryId) {
    await form16ClientRowKeyRepository.record({
      clientRowKey: key,
      entryId: result.entryId,
      source: input.source,
    });
  }

  return { entryId: result.entryId, reused: false };
}
