import type { Database } from "sqlite";

const RAGIC_FIELD_INDEX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ragic_field_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_path TEXT NOT NULL,            -- 'default/forms8/104'
  form_name TEXT NOT NULL,            -- '[104] Work Order Report — Process A'
  scope TEXT NOT NULL,                -- 'main' | 'subtable'
  subtable_name TEXT,                 -- subtable 才有
  subtable_key TEXT,                  -- 主表 / 子表的 Key
  field_pos TEXT,                     -- 'B1' / 'E2'
  field_name TEXT NOT NULL,
  field_id TEXT NOT NULL,
  field_type TEXT,
  field_note TEXT,
  search_text TEXT NOT NULL,          -- form_name + scope + subtable + field_name + field_id
  refreshed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ragic_field_index_form_path
  ON ragic_field_index (form_path);
CREATE INDEX IF NOT EXISTS idx_ragic_field_index_field_id
  ON ragic_field_index (field_id);
CREATE INDEX IF NOT EXISTS idx_ragic_field_index_form_scope
  ON ragic_field_index (form_path, scope);

-- 單列狀態表：前端 poll 看 status / refreshed_at / total_fields，不用猜
CREATE TABLE IF NOT EXISTS ragic_field_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,                -- 'idle' | 'refreshing' | 'ready' | 'error'
  refreshed_at TEXT,
  total_forms INTEGER NOT NULL DEFAULT 0,
  total_fields INTEGER NOT NULL DEFAULT 0,
  message TEXT,                        -- 錯誤訊息或進度提示
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO ragic_field_index_state (id, status, total_forms, total_fields, updated_at)
VALUES (1, 'idle', 0, 0, '1970-01-01T00:00:00.000Z');
`;

export async function ensureRagicFieldIndexSchema(db: Database): Promise<void> {
  await db.exec(RAGIC_FIELD_INDEX_SCHEMA_SQL);
}
