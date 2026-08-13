import dotenv from "dotenv";
import { randomBytes } from "node:crypto";
import path from "node:path";

if (process.env.NODE_ENV !== "test") {
  dotenv.config();
}

// Brand-neutral env names (UPSTREAM_*)：demo repo 對外文件避免綁死特定 SaaS 名稱；
// runtime 仍沿用主系統的 RAGIC_* key，兩者自動互補。
const ENV_ALIASES: Array<[string, string]> = [
  ["UPSTREAM_PROTOCOL", "RAGIC_PROTOCOL"],
  ["UPSTREAM_DOMAIN", "RAGIC_DOMAIN"],
  ["UPSTREAM_API_KEY", "RAGIC_API_KEY"],
  ["UPSTREAM_FORM_104_PATH", "RAGIC_FORM_104_PATH"],
  ["UPSTREAM_FORM_104_TEST_PATH", "RAGIC_FORM_104_TEST_PATH"],
  ["UPSTREAM_FORM_104_CLOSE_ACTION_BUTTON_ID", "RAGIC_FORM_104_CLOSE_ACTION_BUTTON_ID"],
  ["UPSTREAM_FORM_104_REOPEN_ACTION_BUTTON_ID", "RAGIC_FORM_104_REOPEN_ACTION_BUTTON_ID"],
  ["UPSTREAM_FORM_105_PATH", "RAGIC_FORM_105_PATH"],
  ["UPSTREAM_FORM_105_TEST_PATH", "RAGIC_FORM_105_TEST_PATH"],
  ["UPSTREAM_FORM_105_CLOSE_ACTION_BUTTON_ID", "RAGIC_FORM_105_CLOSE_ACTION_BUTTON_ID"],
  ["UPSTREAM_FORM_105_REOPEN_ACTION_BUTTON_ID", "RAGIC_FORM_105_REOPEN_ACTION_BUTTON_ID"],
  ["UPSTREAM_FORM_16_PATH", "RAGIC_FORM_16_PATH"],
  ["UPSTREAM_FORM_16_TEST_PATH", "RAGIC_FORM_16_TEST_PATH"],
  ["UPSTREAM_FORM_16_SAVE_ACTION_BUTTON_ID", "RAGIC_FORM_16_SAVE_ACTION_BUTTON_ID"],
  ["UPSTREAM_FORM_16_WORK_ORDER_FIELD_ID", "RAGIC_FORM_16_WORK_ORDER_FIELD_ID"],
  ["UPSTREAM_FORM_16_TYPE_FIELD_ID", "RAGIC_FORM_16_TYPE_FIELD_ID"],
  ["UPSTREAM_FORM_16_PROCESS_FIELD_ID", "RAGIC_FORM_16_PROCESS_FIELD_ID"],
  ["UPSTREAM_FORM_16_DEP_FIELD_ID", "RAGIC_FORM_16_DEP_FIELD_ID"],
  ["UPSTREAM_FORM_16_PROD_TYPE_FIELD_ID", "RAGIC_FORM_16_PROD_TYPE_FIELD_ID"],
  ["UPSTREAM_FORM_16_REMARK_FIELD_ID", "RAGIC_FORM_16_REMARK_FIELD_ID"],
  ["UPSTREAM_FORM_16_DATE_FIELD_ID", "RAGIC_FORM_16_DATE_FIELD_ID"],
  ["UPSTREAM_ACTION_BUTTON_TIMEOUT_MS", "RAGIC_ACTION_BUTTON_TIMEOUT_MS"],
  ["UPSTREAM_WRITE_TARGET", "RAGIC_WRITE_TARGET"],
  ["UPSTREAM_SOURCE_MACHINE", "RAGIC_SOURCE_MACHINE"],
  ["UPSTREAM_SOURCE_OPERATOR", "RAGIC_SOURCE_OPERATOR"],
  ["UPSTREAM_SOURCE_PROCESS", "RAGIC_SOURCE_PROCESS"],
  ["UPSTREAM_CALLBACK_TOKEN", "RAGIC_CALLBACK_TOKEN"],
  ["UPSTREAM_CALLBACK_DELAY_MS", "RAGIC_CALLBACK_DELAY_MS"],
  ["UPSTREAM_CALLBACK_TASK_PERSIST_ENABLED", "RAGIC_CALLBACK_TASK_PERSIST_ENABLED"],
  ["UPSTREAM_CALLBACK_TASK_STORE_FILE", "RAGIC_CALLBACK_TASK_STORE_FILE"],
  ["UPSTREAM_READ_CONCURRENCY", "RAGIC_READ_CONCURRENCY"],
  ["UPSTREAM_SYNC_READ_CONCURRENCY", "RAGIC_SYNC_READ_CONCURRENCY"],
  ["UPSTREAM_BACKGROUND_READ_CONCURRENCY", "RAGIC_BACKGROUND_READ_CONCURRENCY"],
  ["UPSTREAM_GLOBAL_RATE_PER_SECOND", "RAGIC_GLOBAL_RATE_PER_SECOND"],
  ["UPSTREAM_GLOBAL_BURST_CAPACITY", "RAGIC_GLOBAL_BURST_CAPACITY"],
  ["UPSTREAM_QUEUE_TIMEOUT_MS", "RAGIC_QUEUE_TIMEOUT_MS"],
  ["UPSTREAM_READ_TIMEOUT_MS", "RAGIC_READ_TIMEOUT_MS"],
  ["UPSTREAM_SYNC_READ_TIMEOUT_MS", "RAGIC_SYNC_READ_TIMEOUT_MS"],
  ["UPSTREAM_BACKGROUND_READ_TIMEOUT_MS", "RAGIC_BACKGROUND_READ_TIMEOUT_MS"],
  ["UPSTREAM_WRITE_TIMEOUT_MS", "RAGIC_WRITE_TIMEOUT_MS"],
  ["UPSTREAM_WRITE_CONCURRENCY", "RAGIC_WRITE_CONCURRENCY"],
  ["UPSTREAM_GET_RETRY_MAX", "RAGIC_GET_RETRY_MAX"],
  ["UPSTREAM_GET_RETRY_BASE_DELAY_MS", "RAGIC_GET_RETRY_BASE_DELAY_MS"],
  ["UPSTREAM_WRITE_RETRY_MAX", "RAGIC_WRITE_RETRY_MAX"],
  ["UPSTREAM_WRITE_RETRY_BASE_DELAY_MS", "RAGIC_WRITE_RETRY_BASE_DELAY_MS"],
  ["UPSTREAM_METRICS_WINDOW_SIZE", "RAGIC_METRICS_WINDOW_SIZE"],
  ["UPSTREAM_CIRCUIT_FAILURE_THRESHOLD", "RAGIC_CIRCUIT_FAILURE_THRESHOLD"],
  ["UPSTREAM_CIRCUIT_COOLDOWN_MS", "RAGIC_CIRCUIT_COOLDOWN_MS"],
];

for (const [neutral, legacy] of ENV_ALIASES) {
  if (process.env[neutral] !== undefined && process.env[legacy] === undefined) {
    process.env[legacy] = process.env[neutral];
  } else if (process.env[legacy] !== undefined && process.env[neutral] === undefined) {
    process.env[neutral] = process.env[legacy];
  }
}

const isDemoMode =
  process.env.DEMO_MODE === "true" ||
  process.env.DEMO_MODE === "1" ||
  process.env.DEMO_MODE === "yes";

if (isDemoMode) {
  process.env.RAGIC_PROTOCOL ??= "https";
  process.env.RAGIC_DOMAIN ??= "demo.local";
  process.env.RAGIC_API_KEY ??= "demo-api-key";
  process.env.RAGIC_FORM_104_PATH ??= "/default/forms8/104";
  process.env.RAGIC_FORM_105_PATH ??= "/default/forms8/105";
  process.env.RAGIC_FORM_16_PATH ??= "/default/c1/16";
  process.env.RAGIC_FORM_104_TEST_PATH ??= "/default/forms8/104";
  process.env.RAGIC_FORM_105_TEST_PATH ??= "/default/forms8/105";
  process.env.RAGIC_FORM_16_TEST_PATH ??= "/default/c1/16";
  process.env.RAGIC_FORM_16_SAVE_ACTION_BUTTON_ID ??= "48";
  process.env.RAGIC_FORM_104_CLOSE_ACTION_BUTTON_ID ??= "13";
  process.env.RAGIC_FORM_104_REOPEN_ACTION_BUTTON_ID ??= "18";
  process.env.RAGIC_FORM_105_CLOSE_ACTION_BUTTON_ID ??= "13";
  process.env.RAGIC_FORM_105_REOPEN_ACTION_BUTTON_ID ??= "18";
  process.env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID ??= "1006365";
  process.env.RAGIC_FORM_16_TYPE_FIELD_ID ??= "1012669";
  process.env.RAGIC_FORM_16_PROCESS_FIELD_ID ??= "1002195";
  process.env.RAGIC_FORM_16_DEP_FIELD_ID ??= "1002221";
  process.env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID ??= "1002191";
  process.env.RAGIC_FORM_16_REMARK_FIELD_ID ??= "1002177";
  process.env.RAGIC_FORM_16_DATE_FIELD_ID ??= "1002190";
  process.env.RAGIC_SOURCE_MACHINE ??= "/default/forms51/1";
  process.env.RAGIC_SOURCE_OPERATOR ??= "/default/forms11/13";
  process.env.RAGIC_SOURCE_PROCESS ??= "/default/forms51/3";
  process.env.SQLITE_READ_FORMS ??= "104,105";
  process.env.SQLITE_AUTO_SYNC_FORMS ??= "104,105";
  process.env.SQLITE_AUTO_SYNC_ENABLED ??= "true";
  process.env.SQLITE_AUTO_SYNC_STARTUP_DELAY_MS ??= "1000";
  process.env.REPORT_FULL_CACHE_PREWARM_ON_START ??= "false";
  process.env.FORM16_SQLITE_AUTO_SYNC_ENABLED ??= "false";
  process.env.FORM16_PLANNED_IDLE_SYNC_ENABLED ??= "false";
  process.env.FORM16_WRITE_REVERIFY_ENABLED ??= "false";
  process.env.RAGIC_FIELD_INDEX_AUTO_REFRESH_ENABLED ??= "false";
  process.env.RUNTIME_HEALTH_LOG_ENABLED ??= "false";
  process.env.FORM16_ORPHAN_CLEANUP_ENABLED ??= "false";
  process.env.DEV_AI_ENABLED ??= "false";
  process.env.DEV_AI_CONVERSATION_HISTORY_ENABLED ??= "false";
  process.env.TRUST_PROXY ??= "1";
  process.env.CORS_ORIGIN ??=
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174";

  if (!process.env.DEMO_RESET_KEY) {
    const generated = randomBytes(16).toString("hex");
    process.env.DEMO_RESET_KEY = generated;
    console.info(
      `[demo] DEMO_RESET_KEY 未設定，已自動產生：${generated}\n` +
        `       呼叫範例：curl -X POST http://localhost:${process.env.PORT ?? "3000"}/api/__demo/reset \\\n` +
        `         -H "X-Demo-Key: ${generated}"`
    );
  }

  process.env.NOTICE_ADMIN_USERNAME ??= "demo";
  process.env.NOTICE_ADMIN_PASSWORD_HASH ??=
    "2a97516c354b68848cdbd8f54a226a0a55b21ed138e207ad6c5cbb9c00aa5aea";

  if (process.env.FLY_APP_NAME) {
    process.env.SQLITE_DB_FILE ??= "/data/work-report-read-model.v1.sqlite3";
    process.env.REPORT_FULL_CACHE_FILE ??= "/data/reports-104-full.v1.json";
    process.env.CREATE_TASK_STORE_FILE ??= "/data/create-report-tasks.v1.json";
    process.env.RAGIC_CALLBACK_TASK_STORE_FILE ??= "/data/ragic-callback-tasks.v1.json";
    process.env.WORK_REPORT_TASK_REGISTRY_STORE_FILE ??= "/data/work-report-task-registry.v1.json";
    process.env.SYSTEM_NOTICE_FILE ??= "/data/system-notice.v1.json";
    process.env.FORM16_WRITE_REVERIFY_STORE_FILE ??= "/data/form16-write-reverify.v1.json";
    process.env.DEV_AI_CONVERSATION_DB_FILE ??= "/data/dev-ai-conversations.v1.sqlite3";
  }
}

type WriteTarget = "test" | "prod";

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

function readRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    // 明確告知目前 process.env 是 undefined 還是空字串；
    // 後者常見於 shell / Windows 使用者環境變數被設空值、dotenv 因此不會覆蓋
    const actualState = value === undefined ? "undefined" : "empty string";
    throw new Error(
      `缺少必要環境變數：${key}（process.env.${key} = ${actualState}）。` +
        `請檢查 .env、shell export、Windows 環境變數是否有同名空值把 .env 蓋掉。`
    );
  }
  return value;
}

function resolveSqliteDbFile(): string {
  const sqliteTestDir = String(process.env.SQLITE_TEST_DB_DIR ?? "").trim();
  if (process.env.NODE_ENV === "test" && sqliteTestDir) {
    return path.join(sqliteTestDir, `work-report-read-model.${process.pid}.sqlite3`);
  }
  return process.env.SQLITE_DB_FILE ?? "./.cache/work-report-read-model.v1.sqlite3";
}

function readNumberEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBooleanEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function readStringListEnv(key: string, fallback: string[]): string[] {
  const value = process.env[key];
  if (!value) {
    return fallback;
  }

  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

function readTrustProxyEnv(): boolean | number | string {
  const value = process.env.TRUST_PROXY;
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return numeric;
  }

  return value.trim();
}

function readCorsOriginsEnv(): string[] {
  const multiValue = process.env.CORS_ORIGINS;
  if (multiValue) {
    return readStringListEnv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS);
  }

  const singleOrCsvValue = process.env.CORS_ORIGIN;
  if (!singleOrCsvValue) {
    return DEFAULT_CORS_ORIGINS;
  }

  const list = singleOrCsvValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_CORS_ORIGINS;
}

function readWriteTargetEnv(): WriteTarget {
  const value = (process.env.RAGIC_WRITE_TARGET ?? "test").toLowerCase();
  if (value === "test" || value === "prod") {
    return value;
  }
  return "test";
}

const legacyRagicGlobalRatePerSecond = Math.max(
  1,
  Math.trunc(readNumberEnv("RAGIC_GLOBAL_RATE_PER_SECOND", 8))
);
const legacyRagicGlobalBurstCapacity = Math.max(
  1,
  Math.trunc(readNumberEnv("RAGIC_GLOBAL_BURST_CAPACITY", 12))
);
const defaultRagicBackgroundRatePerSecond = Math.max(
  1,
  Math.floor(legacyRagicGlobalRatePerSecond / 4)
);
const defaultRagicForegroundRatePerSecond = Math.max(
  1,
  legacyRagicGlobalRatePerSecond - defaultRagicBackgroundRatePerSecond
);
const defaultRagicBackgroundBurstCapacity = Math.max(
  1,
  Math.floor(legacyRagicGlobalBurstCapacity / 4)
);
const defaultRagicForegroundBurstCapacity = Math.max(
  1,
  legacyRagicGlobalBurstCapacity - defaultRagicBackgroundBurstCapacity
);
const defaultRagicMutationRatePerSecond = Math.max(
  1,
  Math.floor(defaultRagicForegroundRatePerSecond / 2)
);
const defaultRagicMutationBurstCapacity = Math.max(
  1,
  Math.floor(defaultRagicForegroundBurstCapacity / 2)
);

// USE_TEST_API_KEY=true 時改用 TEST_API_KEY (測試用 service account)，
// 用於把 backend 暫時切到測試身分跑整套流程（驗證 service account 權限是否齊全）。
// 切換時印一行醒目警告，避免忘記改回去。
function resolveRagicApiKey(): string {
  const useTestKey = readBooleanEnv("USE_TEST_API_KEY", false);
  const mainKey = readRequiredEnv("RAGIC_API_KEY");
  if (!useTestKey) {
    return mainKey;
  }
  const testKey = process.env.TEST_API_KEY ?? "";
  if (!testKey) {
    console.warn(
      "[env] USE_TEST_API_KEY=true 但 TEST_API_KEY 為空，fallback 使用 RAGIC_API_KEY"
    );
    return mainKey;
  }
  console.warn(
    "[env] !!! USE_TEST_API_KEY=true — Ragic API 改用 TEST_API_KEY (非主 key)，正式部署前記得改回 false"
  );
  if (!process.env.ADMIN_API_KEY) {
    console.warn(
      "[env] !!! USE_TEST_API_KEY=true 但 ADMIN_API_KEY 未設 — dev mode 重新抓取會 fallback 用 TEST_API_KEY，service account 通常無 admin tool 權限 → refresh 會炸。建議補 ADMIN_API_KEY=<個人帳號 key>"
    );
  }
  return testKey;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  DEMO_MODE: isDemoMode,
  DEMO_RESET_KEY: process.env.DEMO_RESET_KEY ?? "",
  PORT: readNumberEnv("PORT", 3000),
  TRUST_PROXY: readTrustProxyEnv(),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGINS.join(","),
  CORS_ORIGINS: readCorsOriginsEnv(),
  SERVE_FRONTEND_FROM_BACKEND: readBooleanEnv("SERVE_FRONTEND_FROM_BACKEND", false),
  FRONTEND_STATIC_DIR: process.env.FRONTEND_STATIC_DIR ?? "",
  RAGIC_PROTOCOL: readRequiredEnv("RAGIC_PROTOCOL"),
  RAGIC_DOMAIN: readRequiredEnv("RAGIC_DOMAIN"),
  // Ragic Builder 安裝目錄的 cust/def/app 根（只有 backend 跟 Ragic 同台才設；空=停用「直讀 .nui」）。
  // server 例：D:\Ragic\RagicBuilder\cust\def\app。本機沒這目錄就留空。
  RAGIC_BUILDER_PATH: process.env.RAGIC_BUILDER_PATH ?? "",
  RAGIC_API_KEY: resolveRagicApiKey(),
  /**
   * Ragic admin tool 專用 key（dev mode 重新抓取欄位定義走 /sims/doc.jsp 這類
   * admin-only endpoint）。Service account 一般沒 admin tool 權限，必須用
   * 個人帳號 key。空值時 fallback 到 RAGIC_API_KEY（向後相容、原本沒換
   * service account 的環境不用設）。
   */
  ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? "",
  /**
   * dev mode 欄位索引 refresh 是否啟用 content hash skip。
   * 預設 true：抓回 doc.jsp HTML 後算 sha1，跟上次成功 refresh 的 hash
   * 比對命中 → 跳過 parse + replaceAll 的 25~30s。
   * 設 false 是 escape hatch（debug / 強制重抓）。
   */
  RAGIC_FIELD_INDEX_HASH_SKIP: readBooleanEnv("RAGIC_FIELD_INDEX_HASH_SKIP", true),
  /**
   * dev mode 欄位索引背景自動 refresh。預設每 30 分鐘抓一次 doc.jsp 重建索引，
   * 讓使用者開 dev modal 永遠讀到「最近一次背景更新」的本機 SQLite（<100ms），
   * 不用開 modal 才等 refresh。hash skip 命中時背景 refresh 幾乎 no-op。
   *   - ENABLED：總開關（false = 不背景跑，回到純手動「重新抓取」）
   *   - INTERVAL_MS：間隔，預設 1800000(30min)，下限 60s
   *   - STARTUP_DELAY_MS：啟動後延遲首次，避開啟動尖峰，預設 60s
   */
  RAGIC_FIELD_INDEX_AUTO_REFRESH_ENABLED: readBooleanEnv(
    "RAGIC_FIELD_INDEX_AUTO_REFRESH_ENABLED",
    true
  ),
  RAGIC_FIELD_INDEX_AUTO_REFRESH_INTERVAL_MS: Math.max(
    60_000,
    Math.trunc(readNumberEnv("RAGIC_FIELD_INDEX_AUTO_REFRESH_INTERVAL_MS", 1_800_000))
  ),
  RAGIC_FIELD_INDEX_AUTO_REFRESH_STARTUP_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("RAGIC_FIELD_INDEX_AUTO_REFRESH_STARTUP_DELAY_MS", 60_000))
  ),
  RAGIC_FORMULA_SIBLINGS_SLOW_LOG_THRESHOLD_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("RAGIC_FORMULA_SIBLINGS_SLOW_LOG_THRESHOLD_MS", 1_000))
  ),
  RAGIC_FORM_104_PATH: readRequiredEnv("RAGIC_FORM_104_PATH"),
  RAGIC_FORM_104_TEST_PATH: process.env.RAGIC_FORM_104_TEST_PATH ?? "",
  RAGIC_FORM_104_CLOSE_ACTION_BUTTON_ID: process.env.RAGIC_FORM_104_CLOSE_ACTION_BUTTON_ID ?? "",
  RAGIC_FORM_104_REOPEN_ACTION_BUTTON_ID: process.env.RAGIC_FORM_104_REOPEN_ACTION_BUTTON_ID ?? "",
  RAGIC_FORM_105_PATH: process.env.RAGIC_FORM_105_PATH ?? "",
  RAGIC_FORM_105_TEST_PATH: process.env.RAGIC_FORM_105_TEST_PATH ?? "",
  RAGIC_FORM_105_CLOSE_ACTION_BUTTON_ID: process.env.RAGIC_FORM_105_CLOSE_ACTION_BUTTON_ID ?? "",
  RAGIC_FORM_105_REOPEN_ACTION_BUTTON_ID: process.env.RAGIC_FORM_105_REOPEN_ACTION_BUTTON_ID ?? "",
  RAGIC_FORM_16_PATH: process.env.RAGIC_FORM_16_PATH ?? "/default/c1/16",
  RAGIC_FORM_16_TEST_PATH: process.env.RAGIC_FORM_16_TEST_PATH ?? "",
  RAGIC_FORM_16_SAVE_ACTION_BUTTON_ID:
    process.env.RAGIC_FORM_16_SAVE_ACTION_BUTTON_ID ?? "",
  // Form 16 欄位 ID 全部強制必填：若 Ragic schema 改 ID、.env 沒同步，
  // 寧可 boot 直接 throw，也不要 baked-in 的值 silent mismatch 害系統繼續寫錯欄位
  RAGIC_FORM_16_WORK_ORDER_FIELD_ID: readRequiredEnv("RAGIC_FORM_16_WORK_ORDER_FIELD_ID"),
  RAGIC_FORM_16_TYPE_FIELD_ID: readRequiredEnv("RAGIC_FORM_16_TYPE_FIELD_ID"),
  RAGIC_FORM_16_PROCESS_FIELD_ID: readRequiredEnv("RAGIC_FORM_16_PROCESS_FIELD_ID"),
  RAGIC_FORM_16_DEP_FIELD_ID: readRequiredEnv("RAGIC_FORM_16_DEP_FIELD_ID"),
  RAGIC_FORM_16_PROD_TYPE_FIELD_ID: readRequiredEnv("RAGIC_FORM_16_PROD_TYPE_FIELD_ID"),
  RAGIC_FORM_16_REMARK_FIELD_ID: readRequiredEnv("RAGIC_FORM_16_REMARK_FIELD_ID"),
  RAGIC_FORM_16_DATE_FIELD_ID: readRequiredEnv("RAGIC_FORM_16_DATE_FIELD_ID"),
  // 稼動表 Excel 匯出：使用者在 Ragic「發佈到網路」做好的完整下載網址（含 APIKey + view，view 已自己篩好）。
  // 後端當 proxy 直接抓這條網址、原樣轉給前端下載，把含 key 的網址藏在後端、同事按鈕不必看到 key。
  // 建議用 .csv 結尾的網址（稼動表「從文字檔」吃 CSV）；留空時匯出 endpoint 回明確錯誤、不影響主流程。
  REPORT_EXCEL_CSV: process.env.REPORT_EXCEL_CSV ?? "",
  REPORT_EXCEL_CSV_TIMEOUT_MS: Math.max(
    10_000,
    Math.trunc(readNumberEnv("REPORT_EXCEL_CSV_TIMEOUT_MS", 120_000))
  ),
  RAGIC_ACTION_BUTTON_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("RAGIC_ACTION_BUTTON_TIMEOUT_MS", 30_000))
  ),
  RAGIC_WRITE_TARGET: readWriteTargetEnv(),
  RAGIC_SOURCE_MACHINE: process.env.RAGIC_SOURCE_MACHINE ?? "",
  RAGIC_SOURCE_OPERATOR: process.env.RAGIC_SOURCE_OPERATOR ?? "",
  RAGIC_SOURCE_PROCESS: process.env.RAGIC_SOURCE_PROCESS ?? "",
  RAGIC_CALLBACK_TOKEN: process.env.RAGIC_CALLBACK_TOKEN ?? "",
  RAGIC_CALLBACK_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("RAGIC_CALLBACK_DELAY_MS", 1000))
  ),
  RAGIC_CALLBACK_TASK_PERSIST_ENABLED: readBooleanEnv(
    "RAGIC_CALLBACK_TASK_PERSIST_ENABLED",
    true
  ),
  RAGIC_CALLBACK_TASK_STORE_FILE:
    process.env.RAGIC_CALLBACK_TASK_STORE_FILE ?? "./.cache/ragic-callback-tasks.v1.json",
  CACHE_TTL: readNumberEnv("CACHE_TTL", 300),
  CACHE_CHECK_PERIOD: readNumberEnv("CACHE_CHECK_PERIOD", 60),
  SQLITE_ENABLED: readBooleanEnv("SQLITE_ENABLED", true),
  SQLITE_READ_ENABLED: readBooleanEnv("SQLITE_READ_ENABLED", true),
  SQLITE_READ_FORMS: readStringListEnv("SQLITE_READ_FORMS", ["104", "105"]),
  // snapshot 超過此毫秒數未更新（全量 sync 與 callback 都會推進 snapshotAt）
  // 即視為過舊 → 回退 Ragic 直讀，避免背景同步默默掛掉後使用者持續看舊資料
  // 而不自知。0 = 停用檢查。
  SQLITE_READ_MAX_STALENESS_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("SQLITE_READ_MAX_STALENESS_MS", 2 * 60 * 60 * 1000))
  ),
  SQLITE_DB_FILE: resolveSqliteDbFile(),
  SQLITE_SYNC_BATCH_SIZE: Math.max(
    50,
    Math.trunc(readNumberEnv("SQLITE_SYNC_BATCH_SIZE", 500))
  ),
  SQLITE_AUTO_SYNC_ENABLED: readBooleanEnv("SQLITE_AUTO_SYNC_ENABLED", false),
  SQLITE_AUTO_SYNC_FORMS: readStringListEnv("SQLITE_AUTO_SYNC_FORMS", []),
  FORM16_SQLITE_AUTO_SYNC_ENABLED: readBooleanEnv("FORM16_SQLITE_AUTO_SYNC_ENABLED", true),
  // 計畫停機統計 SQLite 同步：背景定時撈近半年 (P)計畫停機分進 SQLite，讓圖表查 SQLite 秒回。
  FORM16_PLANNED_IDLE_SYNC_ENABLED: readBooleanEnv("FORM16_PLANNED_IDLE_SYNC_ENABLED", true),
  FORM16_PLANNED_IDLE_SYNC_INTERVAL_MS: Math.max(
    60_000,
    Math.trunc(readNumberEnv("FORM16_PLANNED_IDLE_SYNC_INTERVAL_MS", 30 * 60 * 1000))
  ),
  FORM16_PLANNED_IDLE_SYNC_STARTUP_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("FORM16_PLANNED_IDLE_SYNC_STARTUP_DELAY_MS", 120_000))
  ),
  SQLITE_AUTO_SYNC_INTERVAL_MS: Math.max(
    60_000,
    Math.trunc(readNumberEnv("SQLITE_AUTO_SYNC_INTERVAL_MS", 30 * 60 * 1000))
  ),
  SQLITE_AUTO_SYNC_STARTUP_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("SQLITE_AUTO_SYNC_STARTUP_DELAY_MS", 30_000))
  ),
  RAGIC_READ_CONCURRENCY: Math.max(
    1,
    Math.trunc(readNumberEnv("RAGIC_READ_CONCURRENCY", 12))
  ),
  RAGIC_SYNC_READ_CONCURRENCY: Math.max(
    1,
    Math.trunc(readNumberEnv("RAGIC_SYNC_READ_CONCURRENCY", 4))
  ),
  RAGIC_MUTATION_READ_CONCURRENCY: Math.max(
    1,
    Math.trunc(readNumberEnv("RAGIC_MUTATION_READ_CONCURRENCY", 4))
  ),
  RAGIC_BACKGROUND_READ_CONCURRENCY: Math.max(
    1,
    Math.trunc(readNumberEnv("RAGIC_BACKGROUND_READ_CONCURRENCY", 4))
  ),
  RAGIC_QUEUE_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("RAGIC_QUEUE_TIMEOUT_MS", 30_000))
  ),
  RAGIC_READ_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("RAGIC_READ_TIMEOUT_MS", 15_000))
  ),
  RAGIC_SYNC_READ_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("RAGIC_SYNC_READ_TIMEOUT_MS", 60_000))
  ),
  // 背景任務（Ragic callback refresh、mutation projection、Form 16 refresh）
  // 通常讀單一 entry，比 sync 全表掃短；比 user 短一些留點 Ragic 回應空間
  RAGIC_BACKGROUND_READ_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("RAGIC_BACKGROUND_READ_TIMEOUT_MS", 30_000))
  ),
  RAGIC_MUTATION_READ_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("RAGIC_MUTATION_READ_TIMEOUT_MS", 10_000))
  ),
  RAGIC_MUTATION_READ_MAX_RETRIES: Math.max(
    0,
    Math.trunc(readNumberEnv("RAGIC_MUTATION_READ_MAX_RETRIES", 1))
  ),
  // 舊版總預算設定保留為相容欄位；實際 runtime 已拆成 foreground/mutation/background
  // 三個 bucket，避免背景同步或一般 refresh 吃掉 mutation precondition 的 token。
  RAGIC_GLOBAL_RATE_PER_SECOND: legacyRagicGlobalRatePerSecond,
  RAGIC_GLOBAL_BURST_CAPACITY: legacyRagicGlobalBurstCapacity,
  RAGIC_FOREGROUND_RATE_PER_SECOND: Math.max(
    1,
    Math.trunc(
      readNumberEnv(
        "RAGIC_FOREGROUND_RATE_PER_SECOND",
        defaultRagicForegroundRatePerSecond
      )
    )
  ),
  RAGIC_FOREGROUND_BURST_CAPACITY: Math.max(
    1,
    Math.trunc(
      readNumberEnv(
        "RAGIC_FOREGROUND_BURST_CAPACITY",
        defaultRagicForegroundBurstCapacity
      )
    )
  ),
  RAGIC_MUTATION_RATE_PER_SECOND: Math.max(
    1,
    Math.trunc(
      readNumberEnv(
        "RAGIC_MUTATION_RATE_PER_SECOND",
        defaultRagicMutationRatePerSecond
      )
    )
  ),
  RAGIC_MUTATION_BURST_CAPACITY: Math.max(
    1,
    Math.trunc(
      readNumberEnv(
        "RAGIC_MUTATION_BURST_CAPACITY",
        defaultRagicMutationBurstCapacity
      )
    )
  ),
  RAGIC_BACKGROUND_RATE_PER_SECOND: Math.max(
    1,
    Math.trunc(
      readNumberEnv(
        "RAGIC_BACKGROUND_RATE_PER_SECOND",
        defaultRagicBackgroundRatePerSecond
      )
    )
  ),
  RAGIC_BACKGROUND_BURST_CAPACITY: Math.max(
    1,
    Math.trunc(
      readNumberEnv(
        "RAGIC_BACKGROUND_BURST_CAPACITY",
        defaultRagicBackgroundBurstCapacity
      )
    )
  ),
  RAGIC_WRITE_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("RAGIC_WRITE_TIMEOUT_MS", 30_000))
  ),
  FORM16_WRITE_VERIFY_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("FORM16_WRITE_VERIFY_TIMEOUT_MS", 10_000))
  ),
  FORM16_WRITE_VERIFY_MAX_RETRIES: Math.max(
    0,
    Math.trunc(readNumberEnv("FORM16_WRITE_VERIFY_MAX_RETRIES", 0))
  ),
  FORM16_WRITE_REVERIFY_ENABLED: readBooleanEnv("FORM16_WRITE_REVERIFY_ENABLED", true),
  FORM16_WRITE_REVERIFY_STORE_FILE:
    process.env.FORM16_WRITE_REVERIFY_STORE_FILE ?? "./.data/form16-write-reverify.v1.json",
  FORM16_WRITE_REVERIFY_INTERVAL_MS: Math.max(
    10_000,
    Math.trunc(readNumberEnv("FORM16_WRITE_REVERIFY_INTERVAL_MS", 60_000))
  ),
  FORM16_WRITE_REVERIFY_STARTUP_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("FORM16_WRITE_REVERIFY_STARTUP_DELAY_MS", 30_000))
  ),
  FORM16_WRITE_REVERIFY_MAX_PER_RUN: Math.max(
    1,
    Math.trunc(readNumberEnv("FORM16_WRITE_REVERIFY_MAX_PER_RUN", 20))
  ),
  FORM16_WRITE_REVERIFY_MAX_ATTEMPTS: Math.max(
    1,
    Math.trunc(readNumberEnv("FORM16_WRITE_REVERIFY_MAX_ATTEMPTS", 6))
  ),
  FORM16_WRITE_REVERIFY_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("FORM16_WRITE_REVERIFY_TIMEOUT_MS", 30_000))
  ),
  FORM16_WRITE_REVERIFY_MAX_RETRIES: Math.max(
    0,
    Math.trunc(readNumberEnv("FORM16_WRITE_REVERIFY_MAX_RETRIES", 1))
  ),
  FORM16_SQLITE_REFRESH_INTERVAL_MS: Math.max(
    10_000,
    Math.trunc(readNumberEnv("FORM16_SQLITE_REFRESH_INTERVAL_MS", 60_000))
  ),
  RAGIC_WRITE_CONCURRENCY: Math.max(
    1,
    Math.trunc(readNumberEnv("RAGIC_WRITE_CONCURRENCY", 2))
  ),
  RAGIC_GET_RETRY_MAX: Math.max(
    0,
    Math.trunc(readNumberEnv("RAGIC_GET_RETRY_MAX", 2))
  ),
  RAGIC_GET_RETRY_BASE_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("RAGIC_GET_RETRY_BASE_DELAY_MS", 200))
  ),
  RAGIC_WRITE_RETRY_MAX: Math.max(
    0,
    Math.trunc(readNumberEnv("RAGIC_WRITE_RETRY_MAX", 1))
  ),
  RAGIC_WRITE_RETRY_BASE_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("RAGIC_WRITE_RETRY_BASE_DELAY_MS", 300))
  ),
  RAGIC_METRICS_WINDOW_SIZE: Math.max(
    20,
    Math.trunc(readNumberEnv("RAGIC_METRICS_WINDOW_SIZE", 200))
  ),
  // Threshold 從 5 → 10 補償新行為：retry 移出 lane 後每次 attempt 都算 breaker failure
  // （以前 retry 結束才算 1 次）。實質敏感度跟舊版接近，但對 Ragic 不健康狀態觸發更準
  RAGIC_CIRCUIT_FAILURE_THRESHOLD: Math.max(
    1,
    Math.trunc(readNumberEnv("RAGIC_CIRCUIT_FAILURE_THRESHOLD", 10))
  ),
  RAGIC_CIRCUIT_COOLDOWN_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("RAGIC_CIRCUIT_COOLDOWN_MS", 30_000))
  ),
  // Default false：fallback 應該是「沒設定就安全」（不噴 log 噪音）；
  // dev / 觀察 lane 流量時 ops 主動 opt-in 設 true
  RUNTIME_HEALTH_LOG_ENABLED: readBooleanEnv("RUNTIME_HEALTH_LOG_ENABLED", false),
  RUNTIME_HEALTH_LOG_INTERVAL_MS: Math.max(
    5000,
    Math.trunc(readNumberEnv("RUNTIME_HEALTH_LOG_INTERVAL_MS", 60000))
  ),
  RUNTIME_HEALTH_EVENT_LOOP_P95_WARN_MS: Math.max(
    10,
    Math.trunc(readNumberEnv("RUNTIME_HEALTH_EVENT_LOOP_P95_WARN_MS", 100))
  ),
  WORK_REPORT_DEBUG_LOG_ENABLED: readBooleanEnv(
    "WORK_REPORT_DEBUG_LOG_ENABLED",
    process.env.NODE_ENV !== "production"
  ),
  OPERATOR_OPTION_CACHE_TTL_MS: Math.max(
    60_000,
    Math.trunc(readNumberEnv("OPERATOR_OPTION_CACHE_TTL_MS", 60_000))
  ),
  REPORT_FULL_CACHE_ENABLED: readBooleanEnv("REPORT_FULL_CACHE_ENABLED", true),
  REPORT_FULL_CACHE_TTL_MS: Math.max(
    60_000,
    Math.trunc(readNumberEnv("REPORT_FULL_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000))
  ),
  REPORT_FULL_CACHE_FILE:
    process.env.REPORT_FULL_CACHE_FILE ?? "./.cache/reports-104-full.v1.json",
  REPORT_FULL_CACHE_STALE_WHILE_REVALIDATE: readBooleanEnv(
    "REPORT_FULL_CACHE_STALE_WHILE_REVALIDATE",
    true
  ),
  REPORT_FULL_CACHE_PREWARM_ON_START: readBooleanEnv(
    "REPORT_FULL_CACHE_PREWARM_ON_START",
    true
  ),
  WORK_REPORT_OPTIONS_PREWARM_STARTUP_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("WORK_REPORT_OPTIONS_PREWARM_STARTUP_DELAY_MS", 120_000))
  ),
  WORK_REPORT_OPTIONS_PREWARM_BETWEEN_FORMS_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("WORK_REPORT_OPTIONS_PREWARM_BETWEEN_FORMS_DELAY_MS", 10_000))
  ),
  REPORT_FULL_CACHE_MAX_RECORDS: Math.max(
    1000,
    Math.trunc(readNumberEnv("REPORT_FULL_CACHE_MAX_RECORDS", 20000))
  ),
  CREATE_POLL_MAX_RETRY: Math.max(1, Math.trunc(readNumberEnv("CREATE_POLL_MAX_RETRY", 3))),
  CREATE_POLL_DELAY_MS: Math.max(0, Math.trunc(readNumberEnv("CREATE_POLL_DELAY_MS", 200))),
  CREATE_SLOW_LOG_THRESHOLD_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("CREATE_SLOW_LOG_THRESHOLD_MS", 3000))
  ),
  CREATE_DEBUG_OPERATOR: readBooleanEnv("CREATE_DEBUG_OPERATOR", false),
  CREATE_DEBUG_OPERATOR_KEY_LIMIT: Math.max(
    1,
    Math.trunc(readNumberEnv("CREATE_DEBUG_OPERATOR_KEY_LIMIT", 30))
  ),
  CREATE_RECALC_ACTION_RETRY: Math.max(
    0,
    Math.trunc(readNumberEnv("CREATE_RECALC_ACTION_RETRY", 1))
  ),
  CREATE_RECALC_VERIFY_RETRY: Math.max(
    1,
    Math.trunc(readNumberEnv("CREATE_RECALC_VERIFY_RETRY", 2))
  ),
  CREATE_RECALC_VERIFY_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("CREATE_RECALC_VERIFY_DELAY_MS", 400))
  ),
  CREATE_RECALC_STRICT: readBooleanEnv("CREATE_RECALC_STRICT", false),
  CREATE_TASK_PERSIST_ENABLED: readBooleanEnv("CREATE_TASK_PERSIST_ENABLED", true),
  CREATE_TASK_STORE_FILE:
    process.env.CREATE_TASK_STORE_FILE ?? "./.cache/create-report-tasks.v1.json",
  CREATE_TASK_HISTORY_LIMIT: Math.max(
    100,
    Math.trunc(readNumberEnv("CREATE_TASK_HISTORY_LIMIT", 2000))
  ),
  WORK_REPORT_MUTATION_MAX_PENDING_TOTAL: Math.max(
    10,
    Math.trunc(readNumberEnv("WORK_REPORT_MUTATION_MAX_PENDING_TOTAL", 500))
  ),
  WORK_REPORT_MUTATION_MAX_PENDING_PER_KEY: Math.max(
    2,
    Math.trunc(readNumberEnv("WORK_REPORT_MUTATION_MAX_PENDING_PER_KEY", 25))
  ),
  WORK_REPORT_MUTATION_MAX_QUEUE_AGE_MS: Math.max(
    60_000,
    Math.trunc(readNumberEnv("WORK_REPORT_MUTATION_MAX_QUEUE_AGE_MS", 10 * 60 * 1000))
  ),
  WORK_REPORT_BATCH_DELETE_CONCURRENCY: Math.max(
    1,
    Math.min(8, Math.trunc(readNumberEnv("WORK_REPORT_BATCH_DELETE_CONCURRENCY", 3)))
  ),
  WORK_REPORT_BATCH_CREATE_FINALIZE_RETRY: Math.max(
    1,
    Math.trunc(readNumberEnv("WORK_REPORT_BATCH_CREATE_FINALIZE_RETRY", 3))
  ),
  WORK_REPORT_BATCH_CREATE_FINALIZE_RETRY_DELAY_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("WORK_REPORT_BATCH_CREATE_FINALIZE_RETRY_DELAY_MS", 1_500))
  ),
  WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: readBooleanEnv(
    "WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED",
    true
  ),
  WORK_REPORT_TASK_REGISTRY_STORE_FILE:
    process.env.WORK_REPORT_TASK_REGISTRY_STORE_FILE ?? "./.cache/work-report-task-registry.v1.json",
  WORK_REPORT_TASK_REGISTRY_HISTORY_LIMIT: Math.max(
    100,
    Math.trunc(readNumberEnv("WORK_REPORT_TASK_REGISTRY_HISTORY_LIMIT", 5000))
  ),
  DEV_AI_ENABLED: readBooleanEnv("DEV_AI_ENABLED", false),
  DEV_AI_PROVIDER: process.env.DEV_AI_PROVIDER?.trim() || "google",
  GOOGLE_GEMINI_API_KEY: process.env.GOOGLE_GEMINI_API_KEY?.trim() ?? "",
  GOOGLE_GEMINI_MODEL: process.env.GOOGLE_GEMINI_MODEL?.trim() || "gemini-3.5-flash",
  GOOGLE_GEMINI_FAST_MODEL: process.env.GOOGLE_GEMINI_FAST_MODEL?.trim() || "",
  GOOGLE_GEMINI_THINKING_LEVEL:
    process.env.GOOGLE_GEMINI_THINKING_LEVEL?.trim() || "minimal",
  GOOGLE_GEMINI_STORE_INTERACTIONS: readBooleanEnv(
    "GOOGLE_GEMINI_STORE_INTERACTIONS",
    false
  ),
  DEV_AI_MAX_CONTEXT_CHARS: Math.max(
    4_000,
    Math.trunc(readNumberEnv("DEV_AI_MAX_CONTEXT_CHARS", 24_000))
  ),
  DEV_AI_CHAT_MAX_CONTEXT_CHARS: Math.max(
    4_000,
    Math.trunc(readNumberEnv("DEV_AI_CHAT_MAX_CONTEXT_CHARS", 16_000))
  ),
  DEV_AI_MAX_OUTPUT_TOKENS: Math.max(
    256,
    Math.trunc(readNumberEnv("DEV_AI_MAX_OUTPUT_TOKENS", 2_048))
  ),
  DEV_AI_CHAT_MAX_OUTPUT_TOKENS: Math.max(
    256,
    Math.trunc(readNumberEnv("DEV_AI_CHAT_MAX_OUTPUT_TOKENS", 1_024))
  ),
  DEV_AI_REQUEST_TIMEOUT_MS: Math.max(
    5_000,
    Math.trunc(readNumberEnv("DEV_AI_REQUEST_TIMEOUT_MS", 30_000))
  ),
  DEV_AI_MAX_CONCURRENT_REQUESTS: Math.max(
    1,
    Math.min(8, Math.trunc(readNumberEnv("DEV_AI_MAX_CONCURRENT_REQUESTS", 2)))
  ),
  DEV_AI_SUGGEST_RATE_LIMIT_PER_MINUTE: Math.max(
    1,
    Math.trunc(readNumberEnv("DEV_AI_SUGGEST_RATE_LIMIT_PER_MINUTE", 6))
  ),
  DEV_AI_KNOWLEDGE_DIR:
    process.env.DEV_AI_KNOWLEDGE_DIR?.trim() || "./.data/dev-ai/knowledge",
  DEV_AI_KNOWLEDGE_MAX_ITEMS: Math.max(
    1,
    Math.trunc(readNumberEnv("DEV_AI_KNOWLEDGE_MAX_ITEMS", 8))
  ),
  DEV_AI_KNOWLEDGE_CACHE_TTL_MS: Math.max(
    0,
    Math.trunc(readNumberEnv("DEV_AI_KNOWLEDGE_CACHE_TTL_MS", 15_000))
  ),
  DEV_AI_APPROVED_EXAMPLES_FILE:
    process.env.DEV_AI_APPROVED_EXAMPLES_FILE?.trim() ||
    "./.data/dev-ai/knowledge/approved-examples.jsonl",
  DEV_AI_COMPILED_KNOWLEDGE_DIR:
    process.env.DEV_AI_COMPILED_KNOWLEDGE_DIR?.trim() ||
    "./.data/dev-ai/knowledge/compiled",
  DEV_AI_CONVERSATION_HISTORY_ENABLED: readBooleanEnv(
    "DEV_AI_CONVERSATION_HISTORY_ENABLED",
    false
  ),
  DEV_AI_CONVERSATION_DB_FILE:
    process.env.DEV_AI_CONVERSATION_DB_FILE?.trim() ||
    "./.data/dev-ai/conversations.v1.sqlite3",
  DEV_AI_THREAD_CONTEXT_MESSAGES: Math.max(
    0,
    Math.trunc(readNumberEnv("DEV_AI_THREAD_CONTEXT_MESSAGES", 12))
  ),
  DEV_AI_THREAD_LIST_LIMIT: Math.max(
    1,
    Math.trunc(readNumberEnv("DEV_AI_THREAD_LIST_LIMIT", 50))
  ),
  DEV_AI_THREAD_DETAIL_MESSAGE_LIMIT: Math.max(
    20,
    Math.trunc(readNumberEnv("DEV_AI_THREAD_DETAIL_MESSAGE_LIMIT", 200))
  ),
  DEV_AI_THREAD_DETAIL_ARTIFACT_LIMIT: Math.max(
    20,
    Math.trunc(readNumberEnv("DEV_AI_THREAD_DETAIL_ARTIFACT_LIMIT", 100))
  ),
  DEV_AI_MAX_THREADS_PER_ACTOR: Math.max(
    10,
    Math.trunc(readNumberEnv("DEV_AI_MAX_THREADS_PER_ACTOR", 200))
  ),
  DEV_AI_MAX_MESSAGES_PER_THREAD: Math.max(
    20,
    Math.trunc(readNumberEnv("DEV_AI_MAX_MESSAGES_PER_THREAD", 300))
  ),
  DEV_AI_MAX_ARTIFACTS_PER_THREAD: Math.max(
    20,
    Math.trunc(readNumberEnv("DEV_AI_MAX_ARTIFACTS_PER_THREAD", 150))
  ),
  DEV_AI_THREAD_RETENTION_DAYS: Math.max(
    1,
    Math.trunc(readNumberEnv("DEV_AI_THREAD_RETENTION_DAYS", 180))
  ),
  DEV_AI_ARCHIVED_THREAD_RETENTION_DAYS: Math.max(
    1,
    Math.trunc(readNumberEnv("DEV_AI_ARCHIVED_THREAD_RETENTION_DAYS", 30))
  ),
  DEV_AI_THREAD_SUMMARY_ENABLED: readBooleanEnv(
    "DEV_AI_THREAD_SUMMARY_ENABLED",
    true
  ),
  DEV_AI_THREAD_SUMMARY_AFTER_MESSAGES: Math.max(
    2,
    Math.trunc(readNumberEnv("DEV_AI_THREAD_SUMMARY_AFTER_MESSAGES", 2))
  ),
  DEV_AI_STORE_RAW_OUTPUT: readBooleanEnv("DEV_AI_STORE_RAW_OUTPUT", false),
  SYSTEM_NOTICE_FILE:
    process.env.SYSTEM_NOTICE_FILE ?? "./.data/system-notice.v1.json",
  NOTICE_ADMIN_USERNAME: process.env.NOTICE_ADMIN_USERNAME ?? "",
  NOTICE_ADMIN_PASSWORD_HASH: process.env.NOTICE_ADMIN_PASSWORD_HASH ?? "",
  NOTICE_TOKEN_TTL_MINUTES: Math.max(
    5,
    Math.trunc(readNumberEnv("NOTICE_TOKEN_TTL_MINUTES", 10080))
  ),
  NOTICE_LOGIN_MAX_FAILURES: Math.max(
    1,
    Math.trunc(readNumberEnv("NOTICE_LOGIN_MAX_FAILURES", 8))
  ),
  NOTICE_LOGIN_WINDOW_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("NOTICE_LOGIN_WINDOW_MS", 15 * 60 * 1000))
  ),
  NOTICE_LOGIN_LOCK_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("NOTICE_LOGIN_LOCK_MS", 15 * 60 * 1000))
  ),
  // Form 16 孤兒背景清理：預設關閉，確認 2A/2B/2C 上線穩定後再手動 env 打開
  FORM16_ORPHAN_CLEANUP_ENABLED: readBooleanEnv("FORM16_ORPHAN_CLEANUP_ENABLED", false),
  // Creator filter：空值不給預設（避免寫死個人名稱在 prod config 裡）。
  // CLEANUP_ENABLED=true 時會在 bootstrap 強制檢查這個必須有值
  FORM16_ORPHAN_CREATOR_ACCOUNT:
    process.env.FORM16_ORPHAN_CREATOR_ACCOUNT?.trim() ?? "",
} as const;

export function shouldUseSqliteReadForForm(formId: string): boolean {
  const normalizedFormId = String(formId ?? "").trim();
  if (!normalizedFormId) {
    return false;
  }

  return (
    env.SQLITE_ENABLED &&
    env.SQLITE_READ_ENABLED &&
    env.SQLITE_READ_FORMS.map((item) => item.trim()).includes(normalizedFormId)
  );
}

export function resolveWritePath(formId: string, defaultPath: string): string | null {
  if (env.RAGIC_WRITE_TARGET === "prod") {
    return defaultPath;
  }

  if (formId === "104") {
    return env.RAGIC_FORM_104_TEST_PATH || null;
  }

  if (formId === "105") {
    return env.RAGIC_FORM_105_TEST_PATH || null;
  }

  if (formId === "16") {
    return env.RAGIC_FORM_16_TEST_PATH || null;
  }

  return null;
}
