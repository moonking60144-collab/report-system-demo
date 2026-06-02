import { env } from "../../config/env";
import { ragicClient, type RagicRecord } from "../../ragic/client";
import { createLogger } from "../../observability/logger";
import { HttpError } from "../../utils/httpError";
import { buildBackgroundReadOptions } from "../work-report/shared/refreshEntryOptions";
import { FORM16_FIELD_KEYS, pickRagicField } from "./form16FieldKeys";

const log = createLogger("form16-write-verifier");

/**
 * Form 16 寫入後的完整性驗證。
 *
 * 觀察到的 bug：Ragic 偶爾會回成功（帶 ragicId），但核心欄位（特別是 workOrderNo）
 * 沒真的存進去，結果 Ragic 側留下 orphan entry（workOrderNo 空 + type 有值）。
 *
 * 本 module 在 create / update 後立刻 GET 回來比對預期欄位；
 * 對不起來就主動 DELETE 該 entry + throw 讓上層知道寫入其實沒成功。
 *
 * 刻意只驗 workOrderNo 和 type 兩個最關鍵的欄位：
 *   - workOrderNo：104/105 orphan 的 root cause（Ragic 偶爾靜默丟掉這個欄位）
 *   - type：downtime 路徑需要 type 有值才不會變成沒類別的空 entry
 * 其他衍生欄位（depUnit / prodType）是 Ragic 端的 lookup / workflow 推算，
 * Ragic 可能會自己 normalize / transform 值，verify 容易誤判造成假 mismatch → 誤殺合法 entry。
 */

export interface VerifyForm16EntryExpected {
  /** 104/105 傳實際工令、downtime 傳空字串驗證 Ragic 沒亂塞；不填代表不驗 */
  workOrderNo?: string;
  /** 報工類別（resolvedReportType.type） */
  type?: string;
}

/**
 * 用 field ID 當 primary key、附帶字串 candidates 當 fallback 去抓欄位值。
 * Ragic 通常回字串 key，但保險起見兩種都試。
 */
function resolveExpectedField(
  record: RagicRecord,
  fieldId: string,
  candidates: readonly string[]
): string {
  const fromId = (record as Record<string, unknown>)?.[fieldId];
  if (fromId !== undefined && fromId !== null && String(fromId).trim() !== "") {
    return String(fromId).trim();
  }
  return pickRagicField(record, candidates);
}

/**
 * 讀回 entry 比對預期欄位。
 *
 * - 全部欄位都符合 → 靜默成功
 * - 任何欄位對不起來 → 先 DELETE 該 entry 再 throw，讓上層 caller（service / flow）
 *   知道寫入沒真的完成、idempotency 不要記 mapping、讓前端使用者看到 error
 */
export async function assertForm16EntryStored(
  form16Path: string,
  entryId: string,
  expected: VerifyForm16EntryExpected
): Promise<void> {
  // Verify read 走 background lane：
  // - 這是寫入流程的 post-hook，不是使用者主動讀取，沒理由污染 user lane
  // - 批次 create 20 筆 → 20 次 verify 就會是 20 個 request，走 user lane 會跟其他使用者搶
  // - 若 background lane 當下 OPEN（callback burst），verify fast-fail → 寫入被當失敗回滾。
  //   這比「verify 卡住耗完 user lane」或「假裝成功但資料不一致」都安全
  const entry = await ragicClient.getEntry(
    form16Path,
    entryId,
    false,
    buildBackgroundReadOptions("background")
  );

  if (!entry) {
    // 寫完就不見 — 不用刪（已消失），但告訴上層
    throw new HttpError(
      502,
      `Form 16 寫入後驗證：entry ${entryId} 讀不回來`,
      "RAGIC_WRITE_FAILED"
    );
  }

  const mismatches: string[] = [];

  if (expected.workOrderNo !== undefined) {
    const actual = resolveExpectedField(
      entry,
      env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID,
      FORM16_FIELD_KEYS.workOrderNo
    );
    if (actual !== String(expected.workOrderNo).trim()) {
      mismatches.push(`workOrderNo: expected="${expected.workOrderNo}" actual="${actual}"`);
    }
  }

  if (expected.type !== undefined) {
    const actual = resolveExpectedField(
      entry,
      env.RAGIC_FORM_16_TYPE_FIELD_ID,
      FORM16_FIELD_KEYS.reportType
    );
    if (actual !== String(expected.type).trim()) {
      mismatches.push(`type: expected="${expected.type}" actual="${actual}"`);
    }
  }

  if (mismatches.length === 0) {
    return;
  }

  // 有欄位不一致 → 這筆就是 orphan 種子，立刻 DELETE 止血
  try {
    await ragicClient.deleteEntry(form16Path, entryId);
    log.warn({ event: "rollback-deleted", entryId, mismatches });
  } catch (deleteError) {
    // 刪除失敗只能 log，繼續 throw 讓上層知道
    log.error({
      event: "rollback-delete-failed",
      entryId,
      mismatches,
      error: deleteError instanceof Error ? deleteError.message : String(deleteError),
    });
  }

  throw new HttpError(
    502,
    `Form 16 寫入後驗證失敗（已回滾刪除 entry ${entryId}）：${mismatches.join("; ")}`,
    "RAGIC_WRITE_FAILED"
  );
}
