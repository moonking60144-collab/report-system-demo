import type { Database } from "sqlite";

const IT_DUTY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS it_duty_member (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_it_duty_member_active_order
  ON it_duty_member (active, sort_order);

CREATE TABLE IF NOT EXISTS it_duty_assignment_override (
  iso_week TEXT NOT NULL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES it_duty_member(id) ON DELETE CASCADE,
  note TEXT,
  propagate_forward INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by_label TEXT
);

CREATE INDEX IF NOT EXISTS idx_it_duty_override_week
  ON it_duty_assignment_override (iso_week);

-- anchor_iso_week / anchor_member_id：rotation 演算法的「初始條件」
-- 第一次有 member 時 seed，之後固定不動 → 解決時間漂移
-- 不加 FK on anchor_member_id（SQLite ALTER TABLE 加 FK 行為不可靠）
-- 改用 application-level invalidation：getSetting() 偵測 anchor_member_id
-- 不在 active members 內就 refill 成最早 active member，保留 anchor_iso_week
CREATE TABLE IF NOT EXISTS it_duty_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  weeks_per_slot INTEGER NOT NULL DEFAULT 1,
  anchor_iso_week TEXT,
  anchor_member_id INTEGER,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO it_duty_setting (id, weeks_per_slot, updated_at)
VALUES (1, 1, '1970-01-01T00:00:00.000Z');

-- 日級代班：A 請假某天 → B 代班 (reason='leave')；之後 A 還 B (reason='repay')
-- 用 paired_swap_id 雙向 link 起來 → 一筆 leave 跟一筆 repay 配對清算 1 天債
-- UNIQUE(cover_date) 限制：同一天只能有一筆代班紀錄（避免代班鏈混亂）
CREATE TABLE IF NOT EXISTS it_duty_day_swap (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cover_date TEXT NOT NULL,
  original_member_id INTEGER NOT NULL REFERENCES it_duty_member(id) ON DELETE CASCADE,
  cover_member_id INTEGER NOT NULL REFERENCES it_duty_member(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('leave', 'repay')),
  paired_swap_id INTEGER REFERENCES it_duty_day_swap(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(cover_date)
);

CREATE INDEX IF NOT EXISTS idx_it_duty_day_swap_date
  ON it_duty_day_swap (cover_date);
CREATE INDEX IF NOT EXISTS idx_it_duty_day_swap_paired
  ON it_duty_day_swap (paired_swap_id);
CREATE INDEX IF NOT EXISTS idx_it_duty_day_swap_debt
  ON it_duty_day_swap (original_member_id, cover_member_id, reason, paired_swap_id);

-- 純日備註：跟代班 / 債務系統完全解耦。
-- 一天一筆（UNIQUE 自帶索引）、CHECK 禁止空字串、updated_by_label 對齊 override 表的 audit 模式。
CREATE TABLE IF NOT EXISTS it_duty_day_note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_date TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  updated_by_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

async function ensureItDutyOverrideColumns(db: Database): Promise<void> {
  const rows = await db.all<Array<{ name: string }>>(
    "PRAGMA table_info(it_duty_assignment_override)"
  );
  const existingCols = new Set(rows.map((r) => r.name));
  if (!existingCols.has("propagate_forward")) {
    await db.exec(
      "ALTER TABLE it_duty_assignment_override ADD COLUMN propagate_forward INTEGER NOT NULL DEFAULT 1"
    );
  }
}

async function ensureItDutyDayNoteColumns(db: Database): Promise<void> {
  const rows = await db.all<Array<{ name: string }>>(
    "PRAGMA table_info(it_duty_day_note)"
  );
  const existingCols = new Set(rows.map((r) => r.name));
  if (!existingCols.has("updated_by_label")) {
    await db.exec(
      "ALTER TABLE it_duty_day_note ADD COLUMN updated_by_label TEXT"
    );
  }
}

async function ensureItDutySettingColumns(db: Database): Promise<void> {
  const rows = await db.all<Array<{ name: string }>>(
    "PRAGMA table_info(it_duty_setting)"
  );
  const existingCols = new Set(rows.map((r) => r.name));
  if (!existingCols.has("anchor_iso_week")) {
    await db.exec(
      "ALTER TABLE it_duty_setting ADD COLUMN anchor_iso_week TEXT"
    );
  }
  if (!existingCols.has("anchor_member_id")) {
    await db.exec(
      "ALTER TABLE it_duty_setting ADD COLUMN anchor_member_id INTEGER"
    );
  }
}

export async function ensureItDutySchema(db: Database): Promise<void> {
  await db.exec(IT_DUTY_SCHEMA_SQL);
  await ensureItDutyOverrideColumns(db);
  await ensureItDutyDayNoteColumns(db);
  await ensureItDutySettingColumns(db);
}
