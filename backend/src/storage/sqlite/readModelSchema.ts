import type { Database } from "sqlite";

export const READ_MODEL_SCHEMA_VERSION = 5;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_report_entries (
  form_id TEXT NOT NULL,
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
  PRIMARY KEY (form_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_id
  ON work_report_entries (form_id);
CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_work_order
  ON work_report_entries (form_id, work_order_no);
CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_customer_part
  ON work_report_entries (form_id, customer_part_no);
CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_machine_code
  ON work_report_entries (form_id, machine_code);
CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_status
  ON work_report_entries (form_id, status);
CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_site_running
  ON work_report_entries (form_id, site_running);
CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_start_schedule
  ON work_report_entries (form_id, start_schedule);
CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_sort_order
  ON work_report_entries (form_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_last_updated
  ON work_report_entries (form_id, last_updated_at);

CREATE TABLE IF NOT EXISTS work_report_rows (
  form_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  date_value TEXT,
  operator_id TEXT,
  process_code TEXT,
  machine_id TEXT,
  payload_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (form_id, entry_id, row_id),
  FOREIGN KEY (form_id, entry_id)
    REFERENCES work_report_entries(form_id, entry_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_work_report_rows_form_date
  ON work_report_rows (form_id, date_value);
CREATE INDEX IF NOT EXISTS idx_work_report_rows_form_operator
  ON work_report_rows (form_id, operator_id);

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

CREATE TABLE IF NOT EXISTS sync_state (
  form_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  task_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  snapshot_at TEXT,
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
  created_at TEXT NOT NULL
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
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_form16_client_row_keys_created_at
  ON form16_client_row_keys (created_at);
`;

export async function initializeReadModelSchema(db: Database): Promise<void> {
  await db.exec(SCHEMA_SQL);
  await ensureWorkReportEntriesColumns(db);
}

async function ensureWorkReportEntriesColumns(db: Database): Promise<void> {
  const rows = await db.all<Array<{ name: string }>>("PRAGMA table_info(work_report_entries)");
  const existingColumns = new Set(rows.map((row) => String(row.name)));
  const missingColumns = [
    { name: "site_running", sql: "ALTER TABLE work_report_entries ADD COLUMN site_running INTEGER" },
    { name: "start_schedule", sql: "ALTER TABLE work_report_entries ADD COLUMN start_schedule INTEGER" },
    { name: "sort_order", sql: "ALTER TABLE work_report_entries ADD COLUMN sort_order REAL" },
    {
      name: "filter_machine_code",
      sql: "ALTER TABLE work_report_entries ADD COLUMN filter_machine_code TEXT",
    },
    {
      name: "planned_start_date",
      sql: "ALTER TABLE work_report_entries ADD COLUMN planned_start_date TEXT",
    },
    { name: "last_updated_at", sql: "ALTER TABLE work_report_entries ADD COLUMN last_updated_at TEXT" },
    { name: "search_text", sql: "ALTER TABLE work_report_entries ADD COLUMN search_text TEXT" },
    {
      name: "ragic_unfinished_status",
      sql: "ALTER TABLE work_report_entries ADD COLUMN ragic_unfinished_status TEXT",
    },
  ].filter((column) => !existingColumns.has(column.name));

  for (const column of missingColumns) {
    await db.exec(column.sql);
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_ragic_unfinished_status
      ON work_report_entries (form_id, ragic_unfinished_status)
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_filter_machine_code
      ON work_report_entries (form_id, filter_machine_code)
  `);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_report_entries_form_planned_start
      ON work_report_entries (form_id, planned_start_date)
  `);
  await ensureSyncStateColumns(db);
}

async function ensureSyncStateColumns(db: Database): Promise<void> {
  const rows = await db.all<Array<{ name: string }>>("PRAGMA table_info(sync_state)");
  const existingColumns = new Set(rows.map((row) => String(row.name)));
  if (!existingColumns.has("read_model_version")) {
    await db.exec("ALTER TABLE sync_state ADD COLUMN read_model_version INTEGER");
  }
}
