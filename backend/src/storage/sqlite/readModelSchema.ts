import type { Database } from "sqlite";

// 注意：此版號只 gate work_report 系列表（workReportSqliteRepository / readModelState / syncServiceFactory）。
// form16 的 downtime / planned_idle 兩張表用 CREATE TABLE IF NOT EXISTS 自建、不受此版號管控，
// 故新增 form16 表不需 bump（bump 反而會誤判 104/105 snapshot 過期、觸發整批 re-sync）。
export const READ_MODEL_SCHEMA_VERSION = 6;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_report_entries (
  form_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  work_order_no TEXT,
  customer_part_no TEXT,
  machine_code TEXT,
  filter_machine_code TEXT,
  status TEXT,
  ragic_unfinished_status TEXT,
  site_running INTEGER,
  start_schedule INTEGER,
  sort_order REAL,
  planned_start_date TEXT,
  last_updated_at TEXT,
  search_text TEXT,
  summary_json TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (form_id, generation_id, entry_id)
);

CREATE TABLE IF NOT EXISTS work_report_rows (
  form_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  date_value TEXT,
  operator_id TEXT,
  process_code TEXT,
  machine_id TEXT,
  payload_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (form_id, generation_id, entry_id, row_id),
  FOREIGN KEY (form_id, generation_id, entry_id)
    REFERENCES work_report_entries(form_id, generation_id, entry_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS form16_downtime_records (
  entry_id TEXT PRIMARY KEY,
  date_value TEXT,
  machine_id TEXT,
  process_code TEXT,
  operator_id TEXT,
  operator_name TEXT,
  report_type TEXT,
  start_time TEXT,
  end_time TEXT,
  break_time TEXT,
  planned_idle_minutes INTEGER,
  remark TEXT,
  work_order_no TEXT,
  raw_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_form16_downtime_date
  ON form16_downtime_records (date_value);
CREATE INDEX IF NOT EXISTS idx_form16_downtime_machine
  ON form16_downtime_records (machine_id);
CREATE INDEX IF NOT EXISTS idx_form16_downtime_process
  ON form16_downtime_records (process_code);
CREATE INDEX IF NOT EXISTS idx_form16_downtime_operator
  ON form16_downtime_records (operator_id);
CREATE INDEX IF NOT EXISTS idx_form16_downtime_work_order
  ON form16_downtime_records (work_order_no);

CREATE TABLE IF NOT EXISTS form16_downtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_at TEXT,
  total_records INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 計畫停機統計用（口徑 B：全量含部分停機，保留近半年）。
-- 跟上面「最近停機紀錄」表分開：那張是 30 天無工令口徑、給表格；這張是每機台每月 (P)計畫停機分彙總圖表。
CREATE TABLE IF NOT EXISTS form16_planned_idle_records (
  entry_id TEXT PRIMARY KEY,
  date_value TEXT,
  month_key TEXT,
  machine_id TEXT,
  prod_type TEXT,
  planned_idle_minutes INTEGER,
  synced_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_form16_planned_idle_month
  ON form16_planned_idle_records (month_key);
CREATE INDEX IF NOT EXISTS idx_form16_planned_idle_machine
  ON form16_planned_idle_records (machine_id);

-- 計畫停機背景同步狀態：記錄上次同步時間與同步到的最舊月份。
-- 讓 summarize 能區分「這月真的 0 筆計畫停機」(oldest_month 內、不 fallback) vs「還沒同步」(fallback 即時撈)。
CREATE TABLE IF NOT EXISTS form16_planned_idle_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  synced_at TEXT,
  oldest_month TEXT,
  total_records INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  form_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  task_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  snapshot_at TEXT,
  active_generation_id TEXT,
  read_model_version INTEGER,
  total_entries INTEGER NOT NULL DEFAULT 0,
  total_rows INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_state (
  form_id TEXT PRIMARY KEY,
  last_enqueued_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_queue (
  form_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (form_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_projection_queue_form_processed_seq
  ON projection_queue (form_id, processed_at, seq);
CREATE INDEX IF NOT EXISTS idx_projection_queue_form_entry_seq
  ON projection_queue (form_id, entry_id, seq);

-- 批次新增 row 的 client-side idempotency key 對應 ragic row id
-- 前端每筆 row 產 UUID，後端 lookup 命中就回舊 row，未命中才真的建立
CREATE TABLE IF NOT EXISTS batch_create_row_keys (
  client_row_key TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  ragic_row_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_batch_create_row_keys_created_at
  ON batch_create_row_keys (created_at);
CREATE INDEX IF NOT EXISTS idx_batch_create_row_keys_form_entry
  ON batch_create_row_keys (form_id, entry_id);

-- 稽核日誌：紀錄 104/105 工令報工 row 與 16 停機紀錄的 update / delete 操作
-- scope = 'work-report'：form 104/105 的子表 row（rowId 必填）
-- scope = 'downtime'：form 16 entry 本身（rowId NULL）
-- 不記 create、不記 Ragic UI 直接改（callback refresh 進來那條）
CREATE TABLE IF NOT EXISTS record_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  form_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  row_id TEXT,
  action TEXT NOT NULL,
  actor_client_id TEXT,
  actor_tab_id TEXT,
  actor_ip TEXT,
  actor_label TEXT,
  task_id TEXT,
  before_snapshot_json TEXT,
  after_patch_json TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_record_audit_log_record
  ON record_audit_log (scope, form_id, entry_id, row_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_record_audit_log_occurred_at
  ON record_audit_log (occurred_at);
CREATE INDEX IF NOT EXISTS idx_record_audit_log_task
  ON record_audit_log (task_id);

-- Form 16 寫入的 client-side idempotency key，擋 retry 風暴造成的 duplicate entry
-- 前端每次 create 產 UUID（104/105 直接 reuse clientMutationId；downtime 新產）
-- 後端寫 Ragic 前先 lookup：命中就回舊 entryId 不再打 Ragic；未命中才真的寫，寫完記錄映射
CREATE TABLE IF NOT EXISTS form16_client_row_keys (
  client_row_key TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  source TEXT NOT NULL,                    -- 'downtime' | 'work-report-104' | 'work-report-105' 等
  status TEXT NOT NULL DEFAULT 'confirmed',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_form16_client_row_keys_created_at
  ON form16_client_row_keys (created_at);

-- 開發者模式登入 token 的持久化（in-memory Map 重啟會掉、寫進來才能 survive restart）
CREATE TABLE IF NOT EXISTS notice_sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notice_sessions_username
  ON notice_sessions (username);

CREATE INDEX IF NOT EXISTS idx_notice_sessions_expires_at
  ON notice_sessions (expires_at_ms);
`;

const WORK_REPORT_ENTRY_COLUMN_MIGRATIONS = [
  { name: "work_order_no", sql: "ALTER TABLE work_report_entries ADD COLUMN work_order_no TEXT" },
  {
    name: "customer_part_no",
    sql: "ALTER TABLE work_report_entries ADD COLUMN customer_part_no TEXT",
  },
  { name: "machine_code", sql: "ALTER TABLE work_report_entries ADD COLUMN machine_code TEXT" },
  { name: "filter_machine_code", sql: "ALTER TABLE work_report_entries ADD COLUMN filter_machine_code TEXT" },
  { name: "status", sql: "ALTER TABLE work_report_entries ADD COLUMN status TEXT" },
  {
    name: "ragic_unfinished_status",
    sql: "ALTER TABLE work_report_entries ADD COLUMN ragic_unfinished_status TEXT",
  },
  { name: "site_running", sql: "ALTER TABLE work_report_entries ADD COLUMN site_running INTEGER" },
  { name: "start_schedule", sql: "ALTER TABLE work_report_entries ADD COLUMN start_schedule INTEGER" },
  { name: "sort_order", sql: "ALTER TABLE work_report_entries ADD COLUMN sort_order REAL" },
  {
    name: "planned_start_date",
    sql: "ALTER TABLE work_report_entries ADD COLUMN planned_start_date TEXT",
  },
  { name: "last_updated_at", sql: "ALTER TABLE work_report_entries ADD COLUMN last_updated_at TEXT" },
  { name: "search_text", sql: "ALTER TABLE work_report_entries ADD COLUMN search_text TEXT" },
];

const WORK_REPORT_ROW_COLUMN_MIGRATIONS = [
  { name: "date_value", sql: "ALTER TABLE work_report_rows ADD COLUMN date_value TEXT" },
  { name: "operator_id", sql: "ALTER TABLE work_report_rows ADD COLUMN operator_id TEXT" },
  { name: "process_code", sql: "ALTER TABLE work_report_rows ADD COLUMN process_code TEXT" },
  { name: "machine_id", sql: "ALTER TABLE work_report_rows ADD COLUMN machine_id TEXT" },
];

export async function initializeReadModelSchema(db: Database): Promise<void> {
  await db.exec(SCHEMA_SQL);
  await ensureWorkReportEntriesColumns(db);
  await ensureBatchCreateRowKeyColumns(db);
  await ensureForm16ClientRowKeyColumns(db);
}

async function ensureTableColumns(
  db: Database,
  tableName: string,
  columns: Array<{ name: string; sql: string }>
): Promise<Set<string>> {
  const rows = await db.all<Array<{ name: string }>>(`PRAGMA table_info(${tableName})`);
  const existingColumns = new Set(rows.map((row) => String(row.name)));
  for (const column of columns) {
    if (!existingColumns.has(column.name)) {
      await db.exec(column.sql);
      existingColumns.add(column.name);
    }
  }
  return existingColumns;
}

async function ensureWorkReportEntriesColumns(db: Database): Promise<void> {
  await ensureWorkReportGenerationTables(db);

  await ensureTableColumns(db, "work_report_entries", WORK_REPORT_ENTRY_COLUMN_MIGRATIONS);
  await ensureTableColumns(db, "work_report_rows", WORK_REPORT_ROW_COLUMN_MIGRATIONS);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_ragic_unfinished_status
      ON work_report_entries (form_id, generation_id, ragic_unfinished_status)
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_filter_machine_code
      ON work_report_entries (form_id, generation_id, filter_machine_code)
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_planned_start
      ON work_report_entries (form_id, generation_id, planned_start_date)
  `);
  await ensureSyncStateColumns(db);
}

async function ensureWorkReportGenerationTables(db: Database): Promise<void> {
  const rows = await db.all<Array<{ name: string }>>("PRAGMA table_info(work_report_entries)");
  if (rows.length === 0) {
    return;
  }
  const existingColumns = new Set(rows.map((row) => String(row.name)));
  await ensureTableColumns(db, "work_report_entries", WORK_REPORT_ENTRY_COLUMN_MIGRATIONS);
  await ensureTableColumns(db, "work_report_rows", WORK_REPORT_ROW_COLUMN_MIGRATIONS);
  if (existingColumns.has("generation_id")) {
    await ensureWorkReportGenerationIndexes(db);
    return;
  }

  await db.exec("PRAGMA foreign_keys=OFF;");
  let transactionStarted = false;
  try {
    await db.exec("BEGIN IMMEDIATE TRANSACTION;");
    transactionStarted = true;
    await db.exec(`
      ALTER TABLE work_report_entries RENAME TO work_report_entries_legacy_generation_migration;
      ALTER TABLE work_report_rows RENAME TO work_report_rows_legacy_generation_migration;

      CREATE TABLE work_report_entries (
        form_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        work_order_no TEXT,
        customer_part_no TEXT,
        machine_code TEXT,
        filter_machine_code TEXT,
        status TEXT,
        ragic_unfinished_status TEXT,
        site_running INTEGER,
        start_schedule INTEGER,
        sort_order REAL,
        planned_start_date TEXT,
        last_updated_at TEXT,
        search_text TEXT,
        summary_json TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (form_id, generation_id, entry_id)
      );

      CREATE TABLE work_report_rows (
        form_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        row_id TEXT NOT NULL,
        date_value TEXT,
        operator_id TEXT,
        process_code TEXT,
        machine_id TEXT,
        payload_json TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (form_id, generation_id, entry_id, row_id),
        FOREIGN KEY (form_id, generation_id, entry_id)
          REFERENCES work_report_entries(form_id, generation_id, entry_id)
          ON DELETE CASCADE
      );

      INSERT INTO work_report_entries (
        form_id,
        generation_id,
        entry_id,
        work_order_no,
        customer_part_no,
        machine_code,
        filter_machine_code,
        status,
        ragic_unfinished_status,
        site_running,
        start_schedule,
        sort_order,
        planned_start_date,
        last_updated_at,
        search_text,
        summary_json,
        detail_json,
        synced_at
      )
      SELECT
        entry.form_id,
        COALESCE(
          (SELECT state.snapshot_at FROM sync_state AS state WHERE state.form_id = entry.form_id),
          entry.synced_at,
          'legacy'
        ) AS generation_id,
        entry.entry_id,
        entry.work_order_no,
        entry.customer_part_no,
        entry.machine_code,
        entry.filter_machine_code,
        entry.status,
        entry.ragic_unfinished_status,
        entry.site_running,
        entry.start_schedule,
        entry.sort_order,
        entry.planned_start_date,
        entry.last_updated_at,
        entry.search_text,
        entry.summary_json,
        entry.detail_json,
        entry.synced_at
      FROM work_report_entries_legacy_generation_migration AS entry;

      INSERT INTO work_report_rows (
        form_id,
        generation_id,
        entry_id,
        row_id,
        date_value,
        operator_id,
        process_code,
        machine_id,
        payload_json,
        synced_at
      )
      SELECT
        row.form_id,
        COALESCE(
          (SELECT state.snapshot_at FROM sync_state AS state WHERE state.form_id = row.form_id),
          row.synced_at,
          'legacy'
        ) AS generation_id,
        row.entry_id,
        row.row_id,
        row.date_value,
        row.operator_id,
        row.process_code,
        row.machine_id,
        row.payload_json,
        row.synced_at
      FROM work_report_rows_legacy_generation_migration AS row;

      DROP TABLE work_report_rows_legacy_generation_migration;
      DROP TABLE work_report_entries_legacy_generation_migration;
    `);
    await db.exec("COMMIT;");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await db.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    await db.exec("PRAGMA foreign_keys=ON;");
  }

  await ensureWorkReportGenerationIndexes(db);
}

async function ensureWorkReportGenerationIndexes(db: Database): Promise<void> {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_id
      ON work_report_entries (form_id, generation_id);
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_work_order
      ON work_report_entries (form_id, generation_id, work_order_no);
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_customer_part
      ON work_report_entries (form_id, generation_id, customer_part_no);
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_machine_code
      ON work_report_entries (form_id, generation_id, machine_code);
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_status
      ON work_report_entries (form_id, generation_id, status);
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_site_running
      ON work_report_entries (form_id, generation_id, site_running);
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_start_schedule
      ON work_report_entries (form_id, generation_id, start_schedule);
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_sort_order
      ON work_report_entries (form_id, generation_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_last_updated
      ON work_report_entries (form_id, generation_id, last_updated_at);
    CREATE INDEX IF NOT EXISTS idx_work_report_rows_form_date
      ON work_report_rows (form_id, generation_id, date_value);
    CREATE INDEX IF NOT EXISTS idx_work_report_rows_form_operator
      ON work_report_rows (form_id, generation_id, operator_id);
  `);
}

async function ensureSyncStateColumns(db: Database): Promise<void> {
  const rows = await db.all<Array<{ name: string }>>("PRAGMA table_info(sync_state)");
  const existingColumns = new Set(rows.map((row) => String(row.name)));
  if (!existingColumns.has("read_model_version")) {
    await db.exec("ALTER TABLE sync_state ADD COLUMN read_model_version INTEGER");
  }
  if (!existingColumns.has("active_generation_id")) {
    await db.exec("ALTER TABLE sync_state ADD COLUMN active_generation_id TEXT");
    await db.exec(`
      UPDATE sync_state
      SET active_generation_id = snapshot_at
      WHERE active_generation_id IS NULL
        AND snapshot_at IS NOT NULL
    `);
  }
}

async function ensureBatchCreateRowKeyColumns(db: Database): Promise<void> {
  const rows = await db.all<Array<{ name: string }>>("PRAGMA table_info(batch_create_row_keys)");
  const existingColumns = new Set(rows.map((row) => String(row.name)));
  if (!existingColumns.has("status")) {
    await db.exec("ALTER TABLE batch_create_row_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'");
  }
  if (!existingColumns.has("error_message")) {
    await db.exec("ALTER TABLE batch_create_row_keys ADD COLUMN error_message TEXT");
  }
  if (!existingColumns.has("updated_at")) {
    await db.exec("ALTER TABLE batch_create_row_keys ADD COLUMN updated_at TEXT");
    await db.exec(`
      UPDATE batch_create_row_keys
      SET updated_at = created_at
      WHERE updated_at IS NULL
    `);
  }
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_batch_create_row_keys_status
      ON batch_create_row_keys (status, updated_at)
  `);
}

async function ensureForm16ClientRowKeyColumns(db: Database): Promise<void> {
  const rows = await db.all<Array<{ name: string }>>("PRAGMA table_info(form16_client_row_keys)");
  const existingColumns = new Set(rows.map((row) => String(row.name)));
  if (!existingColumns.has("status")) {
    await db.exec("ALTER TABLE form16_client_row_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'");
  }
  if (!existingColumns.has("error_message")) {
    await db.exec("ALTER TABLE form16_client_row_keys ADD COLUMN error_message TEXT");
  }
  if (!existingColumns.has("updated_at")) {
    await db.exec("ALTER TABLE form16_client_row_keys ADD COLUMN updated_at TEXT");
    await db.exec(`
      UPDATE form16_client_row_keys
      SET updated_at = created_at
      WHERE updated_at IS NULL
    `);
  }
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_form16_client_row_keys_status
      ON form16_client_row_keys (status, updated_at)
  `);
}
