import dotenv from "dotenv";
import { randomBytes } from "node:crypto";

dotenv.config();

// Demo mode：DEMO_MODE=true 時把 Ragic 上游切成記憶體 mock，並注入必填 env 預設值
// 讓專案能在面試官的機器上 zero-config 啟動。實際的 mock 切換在 ragic/client.ts 出口處。
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
  // demo 下 write target = test，需要把 test 路徑也填上，否則 resolveWritePath 會回 null
  // 直接指到跟 prod 同一張表（mock 內部用 normalizeFormPath 收斂掉 /test 後綴）
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
  // demo 下 SQLite read model 不預讀，所有讀取走 mock，看到的是「第一手」資料路徑
  process.env.SQLITE_READ_FORMS ??= "";
  // 啟動預熱不做（mock 即時回應，沒必要佔 lane）
  process.env.REPORT_FULL_CACHE_PREWARM_ON_START ??= "false";
  process.env.FORM16_SQLITE_AUTO_SYNC_ENABLED ??= "false";
  process.env.SQLITE_AUTO_SYNC_ENABLED ??= "false";
  process.env.RUNTIME_HEALTH_LOG_ENABLED ??= "false";
  process.env.FORM16_ORPHAN_CLEANUP_ENABLED ??= "false";
  process.env.CORS_ORIGIN ??= "http://localhost:5173,http://localhost:5174";

  // Demo reset key：沒給就自動產生一支 16-byte hex（32 字），server log 提示
  // 開發者可以直接複製進 X-Demo-Key header 呼 /api/__demo/reset
  if (!process.env.DEMO_RESET_KEY) {
    const generated = randomBytes(16).toString("hex");
    process.env.DEMO_RESET_KEY = generated;
    console.info(
      `[demo] DEMO_RESET_KEY 未設定，已自動產生：${generated}\n` +
        `       呼叫範例：curl -X POST http://localhost:${process.env.PORT ?? "3000"}/api/__demo/reset \\\n` +
        `         -H "X-Demo-Key: ${generated}"`
    );
  }

  // Notice admin 帳密：demo 預設 demo / demo（SHA-256 hex of "demo"）
  // 跟 .env.demo 一致；讓開發者模式登入可以 zero-config 用 demo/demo 進入
  process.env.NOTICE_ADMIN_USERNAME ??= "demo";
  process.env.NOTICE_ADMIN_PASSWORD_HASH ??=
    "2a97516c354b68848cdbd8f54a226a0a55b21ed138e207ad6c5cbb9c00aa5aea";

  // Fly.io：FLY_APP_NAME 由 platform 注入，代表跑在 Fly 機器上。
  // 預設的 ./.cache / ./.data 在容器內 working dir 不可寫（也不會持久），
  // 把所有 SQLite / JSON 狀態檔指到 /data（fly.toml mounts 的 volume）才會在
  // 部署 / 重啟 / scale 之間保留。已被 .env 或 Dockerfile ENV 設過的不覆蓋。
  if (process.env.FLY_APP_NAME) {
    process.env.SQLITE_DB_FILE ??= "/data/work-report-read-model.v1.sqlite3";
    process.env.REPORT_FULL_CACHE_FILE ??= "/data/reports-104-full.v1.json";
    process.env.CREATE_TASK_STORE_FILE ??= "/data/create-report-tasks.v1.json";
    process.env.RAGIC_CALLBACK_TASK_STORE_FILE ??= "/data/ragic-callback-tasks.v1.json";
    process.env.WORK_REPORT_TASK_REGISTRY_STORE_FILE ??= "/data/work-report-task-registry.v1.json";
    process.env.SYSTEM_NOTICE_FILE ??= "/data/system-notice.v1.json";
  }
}

type WriteTarget = "test" | "prod";

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

function readCorsOriginsEnv(): string[] {
  const multiValue = process.env.CORS_ORIGINS;
  if (multiValue) {
    return readStringListEnv("CORS_ORIGINS", ["http://localhost:5173"]);
  }

  const singleOrCsvValue = process.env.CORS_ORIGIN;
  if (!singleOrCsvValue) {
    return ["http://localhost:5173"];
  }

  const list = singleOrCsvValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ["http://localhost:5173"];
}

function readWriteTargetEnv(): WriteTarget {
  const value = (process.env.RAGIC_WRITE_TARGET ?? "test").toLowerCase();
  if (value === "test" || value === "prod") {
    return value;
  }
  return "test";
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  DEMO_MODE: isDemoMode,
  // 僅 demo mode 有意義；non-demo 留空字串避免外洩 / 誤呼叫
  DEMO_RESET_KEY: process.env.DEMO_RESET_KEY ?? "",
  PORT: readNumberEnv("PORT", 3000),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  CORS_ORIGINS: readCorsOriginsEnv(),
  SERVE_FRONTEND_FROM_BACKEND: readBooleanEnv("SERVE_FRONTEND_FROM_BACKEND", false),
  FRONTEND_STATIC_DIR: process.env.FRONTEND_STATIC_DIR ?? "",
  RAGIC_PROTOCOL: readRequiredEnv("RAGIC_PROTOCOL"),
  RAGIC_DOMAIN: readRequiredEnv("RAGIC_DOMAIN"),
  RAGIC_API_KEY: readRequiredEnv("RAGIC_API_KEY"),
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
  SQLITE_READ_FORMS: readStringListEnv("SQLITE_READ_FORMS", ["105"]),
  SQLITE_DB_FILE:
    process.env.SQLITE_DB_FILE ?? "./.cache/work-report-read-model.v1.sqlite3",
  SQLITE_SYNC_BATCH_SIZE: Math.max(
    50,
    Math.trunc(readNumberEnv("SQLITE_SYNC_BATCH_SIZE", 500))
  ),
  SQLITE_AUTO_SYNC_ENABLED: readBooleanEnv("SQLITE_AUTO_SYNC_ENABLED", false),
  SQLITE_AUTO_SYNC_FORMS: readStringListEnv("SQLITE_AUTO_SYNC_FORMS", []),
  FORM16_SQLITE_AUTO_SYNC_ENABLED: readBooleanEnv("FORM16_SQLITE_AUTO_SYNC_ENABLED", true),
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
  // 全域 token bucket 限制每秒打 Ragic 上限。所有 lane 的請求都要先過這個閘
  // 避免 user(12) + sync(4) + background(4) + write(2) = 22 個同時 burst 打爆 Ragic
  RAGIC_GLOBAL_RATE_PER_SECOND: Math.max(
    1,
    Math.trunc(readNumberEnv("RAGIC_GLOBAL_RATE_PER_SECOND", 8))
  ),
  RAGIC_GLOBAL_BURST_CAPACITY: Math.max(
    1,
    Math.trunc(readNumberEnv("RAGIC_GLOBAL_BURST_CAPACITY", 12))
  ),
  RAGIC_WRITE_TIMEOUT_MS: Math.max(
    1_000,
    Math.trunc(readNumberEnv("RAGIC_WRITE_TIMEOUT_MS", 30_000))
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
  SYSTEM_NOTICE_FILE:
    process.env.SYSTEM_NOTICE_FILE ?? "./.data/system-notice.v1.json",
  NOTICE_ADMIN_USERNAME: process.env.NOTICE_ADMIN_USERNAME ?? "",
  NOTICE_ADMIN_PASSWORD_HASH: process.env.NOTICE_ADMIN_PASSWORD_HASH ?? "",
  NOTICE_TOKEN_TTL_MINUTES: Math.max(
    5,
    Math.trunc(readNumberEnv("NOTICE_TOKEN_TTL_MINUTES", 10080))
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
