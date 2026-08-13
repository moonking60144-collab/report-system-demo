import type { Database } from "sqlite";

const RAGIC_FIELD_INDEX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ragic_field_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_path TEXT NOT NULL,            -- 'default/forms8/104'
  form_name TEXT NOT NULL,            -- '[104] 工令單搓牙報工+排程'
  scope TEXT NOT NULL,                -- 'main' | 'subtable'
  subtable_name TEXT,                 -- subtable 才有
  subtable_key TEXT,                  -- 主表 / 子表的 Key
  field_pos TEXT,                     -- 'B1' / 'E2'
  field_name TEXT NOT NULL,
  field_id TEXT NOT NULL,
  field_type TEXT,
  field_note TEXT,
  search_text TEXT NOT NULL,          -- form_name + scope + subtable + field_name + field_id
  refreshed_at TEXT NOT NULL,
  generation_id TEXT NOT NULL DEFAULT 'legacy'
);

CREATE INDEX IF NOT EXISTS idx_ragic_field_index_form_path
  ON ragic_field_index (form_path);
CREATE INDEX IF NOT EXISTS idx_ragic_field_index_field_id
  ON ragic_field_index (field_id);
CREATE INDEX IF NOT EXISTS idx_ragic_field_index_form_scope
  ON ragic_field_index (form_path, scope);
CREATE INDEX IF NOT EXISTS idx_ragic_field_index_form_scope_subtable_key
  ON ragic_field_index (form_path, scope, subtable_key);
CREATE INDEX IF NOT EXISTS idx_ragic_field_index_scope_subtable_key
  ON ragic_field_index (scope, subtable_key);

-- FTS5 trigram 索引：substring 搜尋從 LIKE %x% full scan → 走 trigram index。
-- - 3+ 字元 query 走 FTS5 MATCH（trigram 索引命中）
-- - < 3 字元 query (e.g. "73")、FTS5 trigram 無法用 index → repository 自動 fallback
--   到原本的 LIKE 路徑
-- - 寫入路徑：唯一寫入點是 RagicFieldIndexRepository.replaceAll（一次 atomic 全替）。
--   interface 沒 export 單筆 insert/update/delete，這條 invariant 在 type 層強制。
-- standalone（非 external content）：搜尋只用 rowid，內容 join 回 ragic_field_index。
CREATE VIRTUAL TABLE IF NOT EXISTS ragic_field_index_fts USING fts5(
  search_text,
  tokenize='trigram'
);

-- 單列狀態表：前端 poll 看 status / refreshed_at / total_fields，不用猜
CREATE TABLE IF NOT EXISTS ragic_field_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,                -- 'idle' | 'refreshing' | 'ready' | 'error'
  refreshed_at TEXT,
  total_forms INTEGER NOT NULL DEFAULT 0,
  total_fields INTEGER NOT NULL DEFAULT 0,
  message TEXT,                        -- 錯誤訊息或進度提示
  updated_at TEXT NOT NULL,
  -- 上一次成功 refresh 的 parsed entries canonical sha1（非 raw HTML hash）。
  -- 對排序後 flatten rows 的 canonical string 串流計算，doc.jsp 動態雜訊不影響。
  -- 比對命中 + status=ready + total_fields>0 → 略過 replaceAll 的 DB 寫入與 FTS 重建。
  -- 欄位名沿用 doc_hash（改名要 migration，無收益）；語意已換成 entries hash。
  doc_hash TEXT,
  active_generation_id TEXT NOT NULL DEFAULT 'legacy'
);

INSERT OR IGNORE INTO ragic_field_index_state (id, status, total_forms, total_fields, updated_at)
VALUES (1, 'idle', 0, 0, '1970-01-01T00:00:00.000Z');
`;

const RAGIC_FIELD_INDEX_GENERATION_SCHEMA_SQL = `
CREATE INDEX IF NOT EXISTS idx_ragic_field_index_generation
  ON ragic_field_index (generation_id);
CREATE INDEX IF NOT EXISTS idx_ragic_field_index_generation_form_path
  ON ragic_field_index (generation_id, form_path);
CREATE INDEX IF NOT EXISTS idx_ragic_field_index_generation_field_id
  ON ragic_field_index (generation_id, field_id);

CREATE VIEW IF NOT EXISTS ragic_field_index_active AS
SELECT fi.*
FROM ragic_field_index fi
JOIN ragic_field_index_state state
  ON state.id = 1 AND fi.generation_id = state.active_generation_id;
`;

async function rebuildFtsFromMain(db: Database): Promise<void> {
  await db.exec("DELETE FROM ragic_field_index_fts");
  await db.exec(
    "INSERT INTO ragic_field_index_fts (rowid, search_text) SELECT id, search_text FROM ragic_field_index"
  );
}

/**
 * Startup integrity check（sample-based, not count-based）：
 *   單純 count 對齊不足以證明 FTS 跟 main 一致——若過去 bug 寫壞 search_text、
 *   或 ALTER 後資料 drift，count 仍可能匹配但內容對不上。
 *   抽 20 筆 main 用 rowid 去 FTS 撈，byte equal 比對 search_text，
 *   任一筆不一致即視為「FTS 不可信」整個重建。
 *   主要 cost：random sample 20 筆 + 20 個 rowid lookup，啟動成本可忽略。
 */
async function ensureFtsConsistentWithMain(db: Database): Promise<void> {
  const mainRow = await db.get<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM ragic_field_index"
  );
  const mainCount = mainRow?.cnt ?? 0;
  if (mainCount === 0) {
    // 連 main 都空，連帶確保 FTS 也空（避免 FTS 殘留孤兒 row 影響 search）
    const ftsRow = await db.get<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM ragic_field_index_fts"
    );
    if ((ftsRow?.cnt ?? 0) > 0) {
      await db.exec("DELETE FROM ragic_field_index_fts");
    }
    return;
  }

  const ftsRow = await db.get<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM ragic_field_index_fts"
  );
  if ((ftsRow?.cnt ?? 0) !== mainCount) {
    await rebuildFtsFromMain(db);
    return;
  }

  // Count 對得上才 sample byte-equal 抽查
  const samples = await db.all<{ id: number; search_text: string }[]>(
    "SELECT id, search_text FROM ragic_field_index ORDER BY RANDOM() LIMIT 20"
  );
  for (const sample of samples) {
    const hit = await db.get<{ search_text: string }>(
      "SELECT search_text FROM ragic_field_index_fts WHERE rowid = ?",
      sample.id
    );
    if (!hit || hit.search_text !== sample.search_text) {
      await rebuildFtsFromMain(db);
      return;
    }
  }
}

/**
 * 舊部署的 ragic_field_index_state 沒有 doc_hash 欄位 → ALTER TABLE 補上。
 * SQLite 3.2+ ADD COLUMN 是 O(1) metadata-only，安全。
 * 用 PRAGMA table_info 先查、有才略過，避免 duplicate column 拋錯。
 */
async function ensureStateDocHashColumn(db: Database): Promise<void> {
  const cols = await db.all<{ name: string }[]>(
    "PRAGMA table_info(ragic_field_index_state)"
  );
  const has = cols.some((c) => c.name === "doc_hash");
  if (!has) {
    await db.exec(
      "ALTER TABLE ragic_field_index_state ADD COLUMN doc_hash TEXT"
    );
  }
}

async function ensureFieldIndexGenerationColumns(db: Database): Promise<void> {
  const indexCols = await db.all<{ name: string }[]>(
    "PRAGMA table_info(ragic_field_index)"
  );
  if (!indexCols.some((c) => c.name === "generation_id")) {
    await db.exec(
      "ALTER TABLE ragic_field_index ADD COLUMN generation_id TEXT NOT NULL DEFAULT 'legacy'"
    );
  }

  const stateCols = await db.all<{ name: string }[]>(
    "PRAGMA table_info(ragic_field_index_state)"
  );
  if (!stateCols.some((c) => c.name === "active_generation_id")) {
    await db.exec(
      "ALTER TABLE ragic_field_index_state ADD COLUMN active_generation_id TEXT NOT NULL DEFAULT 'legacy'"
    );
  }
}

async function ensureFieldIndexActiveGeneration(db: Database): Promise<void> {
  const state = await db.get<{
    active_generation_id: string | null;
    refreshed_at: string | null;
  }>(
    "SELECT active_generation_id, refreshed_at FROM ragic_field_index_state WHERE id = 1"
  );
  const currentActive = state?.active_generation_id?.trim();
  if (currentActive) {
    return;
  }
  const fallback =
    state?.refreshed_at?.trim() ||
    (
      await db.get<{ refreshed_at: string | null }>(
        "SELECT MAX(refreshed_at) AS refreshed_at FROM ragic_field_index"
      )
    )?.refreshed_at?.trim() ||
    "legacy";
  await db.run(
    "UPDATE ragic_field_index_state SET active_generation_id = ? WHERE id = 1",
    fallback
  );
  await db.run(
    "UPDATE ragic_field_index SET generation_id = ? WHERE generation_id IS NULL OR generation_id = ''",
    fallback
  );
}

export async function ensureRagicFieldIndexSchema(db: Database): Promise<void> {
  await db.exec(RAGIC_FIELD_INDEX_SCHEMA_SQL);
  await ensureFieldIndexGenerationColumns(db);
  await ensureStateDocHashColumn(db);
  await ensureFieldIndexActiveGeneration(db);
  await db.exec(RAGIC_FIELD_INDEX_GENERATION_SCHEMA_SQL);
  await ensureFtsConsistentWithMain(db);
}
