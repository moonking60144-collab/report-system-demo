import { env } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { createLogger } from "../observability/logger";
import { runForm16OrphanCleanupOnce } from "../services/form16/form16OrphanCleanupService";

const log = createLogger("form16-orphan-cleanup");

// Hardcoded 操作常數（想調再 env-ify）
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分鐘跑一次
const AGE_THRESHOLD_MS = 10 * 60 * 1000; // createdAt 不到 10 分鐘的不殺（活躍流程緩衝）
const MAX_PER_RUN = 50; // 單次最多刪 50 筆避免大風暴
const DAYS_BACK = 90; // 掃最近 90 天內的
const STARTUP_DELAY_MS = 5 * 60 * 1000; // 啟動後 5 分鐘才跑第一次

let cleanupTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  if (!env.FORM16_ORPHAN_CLEANUP_ENABLED) return;

  const stats = await runForm16OrphanCleanupOnce({
    daysBack: DAYS_BACK,
    ageThresholdMs: AGE_THRESHOLD_MS,
    maxPerRun: MAX_PER_RUN,
    creatorAccount: env.FORM16_ORPHAN_CREATOR_ACCOUNT,
  });

  // 只在實際有動作或 match 到東西時 log，避免空輪噪音
  const hasNonWhitelisted =
    Object.keys(stats.nonWhitelistedReportTypes).length > 0;
  if (
    stats.matched > 0 ||
    stats.deleted > 0 ||
    stats.deleteFailed > 0 ||
    hasNonWhitelisted
  ) {
    log.info({ event: "run-complete", ...stats });
  }
  // 白名單外的類別要另外顯著提醒：代表白名單可能漏了新類別
  if (hasNonWhitelisted) {
    log.warn({
      event: "non-whitelisted-report-types-detected",
      hint: "這些報工類別符合『workOrderNo 空 + 非計畫停機 + creator 符合 + ERP料號不含 test』但不在白名單；若確認該清理就加進 FORM16_WORK_ORDER_REQUIRED_TYPES",
      types: stats.nonWhitelistedReportTypes,
    });
  }
}

export function startForm16OrphanCleanup(): void {
  if (cleanupTimer || startupTimer) return;
  if (!env.FORM16_ORPHAN_CLEANUP_ENABLED) {
    log.info({ event: "disabled", reason: "FORM16_ORPHAN_CLEANUP_ENABLED=false" });
    return;
  }
  if (!env.FORM16_ORPHAN_CREATOR_ACCOUNT) {
    // 沒 creator filter 就讓條件變寬、可能誤殺他人手動建的 entry；
    // 所以強制要求設（跟 ENABLED 綁定）
    log.error({
      event: "refused-to-start",
      reason: "FORM16_ORPHAN_CLEANUP_ENABLED=true 但 FORM16_ORPHAN_CREATOR_ACCOUNT 沒設",
    });
    return;
  }
  if (env.RAGIC_WRITE_TARGET !== "prod") {
    // Cleanup 會真的 DELETE Ragic 資料；跑在 test target 時通常是 dev 在測 backend，
    // 但 .env 如果指向 prod Ragic，cleanup 仍會刪 prod 資料。保險起見限 prod 才跑。
    log.error({
      event: "refused-to-start",
      reason: "FORM16_ORPHAN_CLEANUP_ENABLED=true 但 RAGIC_WRITE_TARGET 不是 prod",
      ragicWriteTarget: env.RAGIC_WRITE_TARGET,
    });
    return;
  }

  log.info({
    event: "enabled",
    creatorAccount: env.FORM16_ORPHAN_CREATOR_ACCOUNT,
    intervalMs: CLEANUP_INTERVAL_MS,
    ageThresholdMs: AGE_THRESHOLD_MS,
    maxPerRun: MAX_PER_RUN,
    daysBack: DAYS_BACK,
  });

  // 啟動延遲避免跟 prewarm / auto-sync 搶 Ragic concurrency
  startupTimer = setTimeout(() => {
    runBackgroundTask("form16-orphan-cleanup.startup", runOnce);
    startupTimer = null;
  }, STARTUP_DELAY_MS);
  startupTimer.unref();

  cleanupTimer = setInterval(() => {
    runBackgroundTask("form16-orphan-cleanup.interval", runOnce);
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

export function stopForm16OrphanCleanup(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
