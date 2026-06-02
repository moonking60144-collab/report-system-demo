import { env, resolveWritePath } from "../../config/env";
import { ragicClient } from "../../ragic/client";
import { createLogger } from "../../observability/logger";
import { normalizeRows } from "../work-report/shared/ragicRowUtils";
import {
  detectNonWhitelistedOrphanType,
  isForm16Orphan,
  parseForm16CreatedAtMs,
} from "./form16OrphanPolicy";

const log = createLogger("form16-orphan-cleanup-service");

/**
 * Form 16 孤兒背景清理 service。
 *
 * 判定條件 / createdAt 解析都走 `form16OrphanPolicy` 共用模組（跟 audit 腳本共用一份），
 * 改條件只要改那一個 file，不再有 service vs script drift。
 *
 * 做 2A/2B/2C 兜底的角色：
 * - 2A idempotency / 2B post-write verify / 2C action button rollback 都在活躍 request path 上
 * - 若有漏網的（Ragic crash / backend crash in specific window），本 service 每隔 interval
 *   掃一次，保守條件下 DELETE 掉
 */

export interface Form16OrphanCleanupOptions {
  /** 掃最近幾天內的 entry */
  daysBack: number;
  /** createdAt 距今少於此毫秒數的孤兒不刪（避免殺還在建立中的） */
  ageThresholdMs: number;
  /** 單次 run 最多刪幾筆（避免一次大掃對 Ragic 負擔過大） */
  maxPerRun: number;
  /** 開單者帳號過濾值 */
  creatorAccount: string;
}

export interface Form16OrphanCleanupStats {
  fetched: number;
  /** 符合全部判定條件的筆數（含太新的） */
  matched: number;
  /** 符合條件但 createdAt 太新被跳過 */
  skippedTooRecent: number;
  /** 實際成功刪除 */
  deleted: number;
  /** 嘗試刪除但失敗 */
  deleteFailed: number;
  /**
   * 「其他條件都中、但報工類別不在白名單」的分佈。
   * key = reportType，value = 筆數。出現就代表可能要加進白名單。
   */
  nonWhitelistedReportTypes: Record<string, number>;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

export async function runForm16OrphanCleanupOnce(
  options: Form16OrphanCleanupOptions
): Promise<Form16OrphanCleanupStats> {
  const form16Path =
    resolveWritePath("16", env.RAGIC_FORM_16_PATH) ?? env.RAGIC_FORM_16_PATH;
  if (!form16Path.trim()) {
    throw new Error("Form 16 path 未設定，無法執行 orphan cleanup");
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - options.daysBack);
  const dateFrom = formatDate(cutoff);

  const stats: Form16OrphanCleanupStats = {
    fetched: 0,
    matched: 0,
    skippedTooRecent: 0,
    deleted: 0,
    deleteFailed: 0,
    nonWhitelistedReportTypes: {},
  };

  const pageSize = 1000;
  let offset = 0;
  const toDelete: string[] = [];
  const now = Date.now();

  while (toDelete.length < options.maxPerRun) {
    const page = await ragicClient.getFormPage(
      form16Path,
      {
        limit: pageSize,
        offset,
        where: [`${env.RAGIC_FORM_16_DATE_FIELD_ID},>=,${dateFrom}`],
      },
      false,
      { timeoutMs: env.RAGIC_SYNC_READ_TIMEOUT_MS, priority: "background" }
    );
    const rows = normalizeRows(page);
    stats.fetched += rows.length;

    for (const row of rows) {
      if (!isForm16Orphan(row.data, { creatorAccount: options.creatorAccount })) {
        // 不是白名單類別、但其他條件都中 → 記下來觀察；之後可以判斷白名單是否該擴充
        const maybeType = detectNonWhitelistedOrphanType(row.data, {
          creatorAccount: options.creatorAccount,
        });
        if (maybeType !== null) {
          stats.nonWhitelistedReportTypes[maybeType] =
            (stats.nonWhitelistedReportTypes[maybeType] ?? 0) + 1;
        }
        continue;
      }
      stats.matched += 1;

      const createdAtMs = parseForm16CreatedAtMs(row.data);
      const ageMs = createdAtMs !== null ? now - createdAtMs : Infinity;
      if (ageMs < options.ageThresholdMs) {
        stats.skippedTooRecent += 1;
        continue;
      }

      toDelete.push(row.entryId);
      if (toDelete.length >= options.maxPerRun) break;
    }

    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  // 逐筆刪，失敗只 log 繼續；讓一筆壞資料不影響其他
  for (const entryId of toDelete) {
    try {
      await ragicClient.deleteEntry(form16Path, entryId);
      stats.deleted += 1;
    } catch (error) {
      stats.deleteFailed += 1;
      log.warn({
        event: "delete-failed",
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return stats;
}
