import { randomUUID } from "node:crypto";
import type { Database } from "sqlite";
import { createConnectionSerializer, sqliteClient } from "./sqliteClient";
import type {
  RagicFieldIndexEntry,
  RagicFieldIndexState,
  RagicFieldIndexStatus,
  RagicFieldScope,
} from "../../types/ragicFieldIndex";
import { createLogger } from "../../observability/logger";

const log = createLogger("ragic-field-index-repository");

function createGenerationId(refreshedAt: string): string {
  return `${refreshedAt}#${randomUUID()}`;
}

interface RagicFieldIndexRow {
  id: number;
  form_path: string;
  form_name: string;
  scope: string;
  subtable_name: string | null;
  subtable_key: string | null;
  field_pos: string | null;
  field_name: string;
  field_id: string;
  field_type: string | null;
  field_note: string | null;
  refreshed_at: string;
  generation_id: string;
}

interface RagicFieldIndexStateRow {
  status: string;
  refreshed_at: string | null;
  total_forms: number;
  total_fields: number;
  message: string | null;
  updated_at: string;
  doc_hash: string | null;
  active_generation_id: string | null;
}

const VALID_STATUSES: ReadonlySet<RagicFieldIndexStatus> = new Set([
  "idle",
  "refreshing",
  "ready",
  "error",
]);

function mapEntry(row: RagicFieldIndexRow): RagicFieldIndexEntry {
  const scope: RagicFieldScope = row.scope === "subtable" ? "subtable" : "main";
  return {
    id: row.id,
    formPath: row.form_path,
    formName: row.form_name,
    scope,
    subtableName: row.subtable_name,
    subtableKey: row.subtable_key,
    fieldPos: row.field_pos,
    fieldName: row.field_name,
    fieldId: row.field_id,
    fieldType: row.field_type,
    fieldNote: row.field_note,
    refreshedAt: row.refreshed_at,
  };
}

function mapState(row: RagicFieldIndexStateRow): RagicFieldIndexState {
  const status: RagicFieldIndexStatus = VALID_STATUSES.has(row.status as RagicFieldIndexStatus)
    ? (row.status as RagicFieldIndexStatus)
    : "idle";
  return {
    status,
    refreshedAt: row.refreshed_at,
    totalForms:
      typeof row.total_forms === "number" && Number.isFinite(row.total_forms)
        ? row.total_forms
        : 0,
    totalFields:
      typeof row.total_fields === "number" && Number.isFinite(row.total_fields)
        ? row.total_fields
        : 0,
    message: row.message,
    updatedAt: row.updated_at,
    // Repository 不知道 in-memory progress；由 route handler 在回應時注入
    progress: null,
    lastDocHash: row.doc_hash ?? null,
  };
}

export interface RagicFieldIndexInsertInput {
  formPath: string;
  formName: string;
  scope: RagicFieldScope;
  subtableName?: string | null;
  subtableKey?: string | null;
  fieldPos?: string | null;
  fieldName: string;
  fieldId: string;
  fieldType?: string | null;
  fieldNote?: string | null;
}

export interface RagicFieldIndexSearchParams {
  q?: string;
  formPath?: string;
  fieldId?: string;
  limit?: number;
}

export interface RagicFieldIndexRepository {
  replaceAll(
    entries: RagicFieldIndexInsertInput[],
    refreshedAt: string
  ): Promise<{ totalForms: number; totalFields: number }>;
  search(params: RagicFieldIndexSearchParams): Promise<RagicFieldIndexEntry[]>;
  countAll(): Promise<{ totalForms: number; totalFields: number }>;

  getState(): Promise<RagicFieldIndexState>;
  setState(input: {
    status: RagicFieldIndexStatus;
    refreshedAt?: string | null;
    totalForms?: number;
    totalFields?: number;
    message?: string | null;
    /**
     * 上次成功 refresh 的 parsed entries canonical sha1（存於 doc_hash 欄位，
     * 非 raw HTML hash）。undefined = 不動（沿用舊值）；null = 顯式清掉；
     * string = 寫新 hash。跟 message / refreshedAt 同樣 patch 語意。
     */
    lastDocHash?: string | null;
  }): Promise<RagicFieldIndexState>;
  /**
   * Atomic 取得「執行 refresh 的權」：
   *   - 若當前 status 已是 'refreshing' → 不變更，回 false
   *   - 否則一併把 status 設成 'refreshing'，回 true
   * 由 SQLite 單寫線（runSerializedWrite）保證原子性。
   */
  claimRefresh(message?: string | null): Promise<boolean>;
  /**
   * 部署時補救：把 stuck 在 'refreshing' 的狀態（例如 backend
   * 上次跑到一半 crash）重設成 'idle'。回傳是否真的有重設。
   */
  resetStuckRefreshing(message?: string | null): Promise<boolean>;

  /**
   * 同 mainKey（main scope 的 subtable_key）的多版本兄弟表單，排除自己。
   * 單一版本表單回空陣列；公式跨版本連動用。
   */
  listVersionSiblingForms(
    formPath: string
  ): Promise<Array<{ formPath: string; formName: string }>>;
  /**
   * 單一表單全部欄位的 position 映射（含子表格欄位；公式 cell ref 共用同一
   * 座標空間）。公式位置翻譯器的對應表來源。
   */
  listFormFieldPositions(
    formPath: string
  ): Promise<Array<{ fieldId: string; fieldName: string; position: string; scope: RagicFieldScope }>>;
}

function buildSearchText(input: RagicFieldIndexInsertInput): string {
  return [
    input.formName,
    input.scope,
    input.subtableName ?? "",
    input.fieldPos ?? "",
    input.fieldName,
    input.fieldId,
    input.fieldType ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function createRagicFieldIndexRepository(
  getDb: () => Promise<Database>,
  getReadDb: () => Promise<Database> = getDb
): RagicFieldIndexRepository {
  const { runSerializedWrite, withWriteTransaction } =
    createConnectionSerializer(getDb);

  return {
    async replaceAll(entries, refreshedAt) {
      const normalizedRefreshedAt = refreshedAt || new Date().toISOString();
      const generationId = createGenerationId(normalizedRefreshedAt);

      const cleanupGeneration = async (targetGenerationId: string) => {
        await runSerializedWrite(async (db) => {
          await db.run(
            "DELETE FROM ragic_field_index_fts WHERE rowid IN (SELECT id FROM ragic_field_index WHERE generation_id = ?)",
            targetGenerationId
          );
          await db.run(
            "DELETE FROM ragic_field_index WHERE generation_id = ?",
            targetGenerationId
          );
        });
      };

      try {
        await cleanupGeneration(generationId);

        // Batched multi-row INSERT — 改 chunk 1000，prepare/bind 次數減半。
        // 寫到 inactive generation；active_generation_id 未切換前，reader 仍看舊索引。
        // 每個 chunk 獨立排進 SQLite 單寫線，不用一個長 transaction 佔住 writer。
        const CHUNK_SIZE = 1000;
        const colCount = 13;
        const singleRowPlaceholders =
          "(" + new Array(colCount).fill("?").join(", ") + ")";
        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
          const chunk = entries.slice(i, i + CHUNK_SIZE);
          const placeholders = chunk
            .map(() => singleRowPlaceholders)
            .join(", ");
          await runSerializedWrite(async (db) => {
            const params: unknown[] = [];
            for (const entry of chunk) {
              params.push(
                entry.formPath,
                entry.formName,
                entry.scope,
                entry.subtableName ?? null,
                entry.subtableKey ?? null,
                entry.fieldPos ?? null,
                entry.fieldName,
                entry.fieldId,
                entry.fieldType ?? null,
                entry.fieldNote ?? null,
                buildSearchText(entry),
                normalizedRefreshedAt,
                generationId
              );
            }
            await db.run(
              `INSERT INTO ragic_field_index (
                form_path, form_name, scope, subtable_name, subtable_key,
                field_pos, field_name, field_id, field_type, field_note,
                search_text, refreshed_at, generation_id
              ) VALUES ${placeholders}`,
              ...params
            );
          });
        }

        await runSerializedWrite(async (db) => {
          await db.run(
            "INSERT INTO ragic_field_index_fts (rowid, search_text) SELECT id, search_text FROM ragic_field_index WHERE generation_id = ?",
            generationId
          );
        });

        await withWriteTransaction(async (db) => {
          await db.run(
            "UPDATE ragic_field_index_state SET active_generation_id = ? WHERE id = 1",
            generationId
          );
        });
      } catch (error) {
        await cleanupGeneration(generationId).catch((cleanupError) => {
          log.warn({
            event: "cleanup-failed-generation-failed",
            generationId,
            error:
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        });
        throw error;
      }

      try {
        await runSerializedWrite(async (db) => {
          await db.run(
            "DELETE FROM ragic_field_index_fts WHERE rowid IN (SELECT id FROM ragic_field_index WHERE generation_id != ?)",
            generationId
          );
          await db.run(
            "DELETE FROM ragic_field_index WHERE generation_id != ?",
            generationId
          );
        });
      } catch (error) {
        log.warn({
          event: "cleanup-old-generations-failed",
          generationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // COUNT 在 promote 後讀 active view；cleanup 失敗也不影響 active generation。
      const db = await getReadDb();
      const counts = await db.get<{ form_count: number; field_count: number }>(
        "SELECT COUNT(DISTINCT form_path) AS form_count, COUNT(*) AS field_count FROM ragic_field_index_active"
      );
      return {
        totalForms: counts?.form_count ?? 0,
        totalFields: counts?.field_count ?? 0,
      };
    },

    async search(params) {
      const db = await getReadDb();
      const q = (params.q ?? "").trim().toLowerCase();
      const formPath = params.formPath?.trim() ?? "";
      const fieldId = params.fieldId?.trim() ?? "";
      const limit = Math.min(
        Math.max(Math.trunc(params.limit ?? 200), 1),
        2000
      );

      // FTS5 trigram 需要 query >= 3 字元才能用 trigram index；< 3 字元 trigram
      // 內部會 full scan FTS table 反而比 main table LIKE 慢、且行為不對等。
      // 短 query 走原本 LIKE。
      const useFts = q.length >= 3;

      const conditions: string[] = [];
      const values: unknown[] = [];

      if (q) {
        if (useFts) {
          // FTS5 phrase syntax：用 "..." 包住確保 query 被當成 literal substring，
          // 不會被解讀成 FTS operator (AND/OR/NOT/NEAR)。內部 " 要 double 跳脫。
          conditions.push(
            "id IN (SELECT rowid FROM ragic_field_index_fts WHERE search_text MATCH ?)"
          );
          values.push(`"${q.replace(/"/g, '""')}"`);
        } else {
          conditions.push("search_text LIKE ?");
          values.push(`%${q}%`);
        }
      }
      if (formPath) {
        conditions.push("form_path = ?");
        values.push(formPath);
      }
      if (fieldId) {
        conditions.push("field_id = ?");
        values.push(fieldId);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `
        SELECT id, form_path, form_name, scope, subtable_name, subtable_key,
               field_pos, field_name, field_id, field_type, field_note, refreshed_at
        FROM ragic_field_index_active
        ${where}
        ORDER BY form_path ASC, scope DESC, subtable_key ASC, field_pos ASC, id ASC
        LIMIT ?
      `;
      const rows = await db.all<RagicFieldIndexRow[]>(sql, ...values, limit);
      return rows.map(mapEntry);
    },

    async countAll() {
      const db = await getReadDb();
      const row = await db.get<{ form_count: number; field_count: number }>(
        "SELECT COUNT(DISTINCT form_path) AS form_count, COUNT(*) AS field_count FROM ragic_field_index_active"
      );
      return {
        totalForms: row?.form_count ?? 0,
        totalFields: row?.field_count ?? 0,
      };
    },

    async listVersionSiblingForms(formPath) {
      const db = await getReadDb();
      const rows = await db.all<Array<{ form_path: string; form_name: string }>>(
        `
        SELECT DISTINCT t.form_path AS form_path, t.form_name AS form_name
        FROM ragic_field_index_active AS s
        JOIN ragic_field_index_active AS t
          ON t.scope = 'main' AND t.subtable_key = s.subtable_key
        WHERE s.form_path = ?
          AND s.scope = 'main'
          AND s.subtable_key IS NOT NULL
          AND s.subtable_key != ''
          AND t.form_path != s.form_path
        ORDER BY t.form_name ASC, t.form_path ASC
        `,
        formPath
      );
      return rows.map((row) => ({
        formPath: row.form_path,
        formName: row.form_name,
      }));
    },

    async listFormFieldPositions(formPath) {
      const db = await getReadDb();
      const rows = await db.all<
        Array<{ field_id: string; field_name: string; field_pos: string; scope: RagicFieldScope }>
      >(
        `
        SELECT field_id, field_name, field_pos, scope
        FROM ragic_field_index_active
        WHERE form_path = ?
          AND field_pos IS NOT NULL
          AND field_pos != ''
        ORDER BY id ASC
        `,
        formPath
      );
      return rows.map((row) => ({
        fieldId: row.field_id,
        fieldName: row.field_name,
        position: row.field_pos,
        scope: row.scope,
      }));
    },

    async getState() {
      const db = await getReadDb();
      const row = await db.get<RagicFieldIndexStateRow>(
        "SELECT status, refreshed_at, total_forms, total_fields, message, updated_at, doc_hash, active_generation_id FROM ragic_field_index_state WHERE id = 1"
      );
      if (!row) {
        return {
          status: "idle",
          refreshedAt: null,
          totalForms: 0,
          totalFields: 0,
          message: null,
          updatedAt: "1970-01-01T00:00:00.000Z",
          progress: null,
          lastDocHash: null,
        };
      }
      return mapState(row);
    },

    async claimRefresh(message) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        // 用 WHERE status != 'refreshing' 確保原子性：
        // 兩個並發呼叫只有一個會 update changes>0，另一個 changes=0 視為失去 race
        const result = await db.run(
          `
          UPDATE ragic_field_index_state
          SET status = 'refreshing', message = ?, updated_at = ?
          WHERE id = 1 AND status != 'refreshing'
          `,
          message ?? null,
          now
        );
        const changes = typeof result.changes === "number" ? result.changes : 0;
        return changes > 0;
      });
    },

    async resetStuckRefreshing(message) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        const result = await db.run(
          `
          UPDATE ragic_field_index_state
          SET status = 'idle', message = ?, updated_at = ?
          WHERE id = 1 AND status = 'refreshing'
          `,
          message ?? null,
          now
        );
        const changes = typeof result.changes === "number" ? result.changes : 0;
        return changes > 0;
      });
    },

    async setState(input) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        // 讀回舊的，patch 沒指定的欄位
        const existing = await db.get<RagicFieldIndexStateRow>(
          "SELECT status, refreshed_at, total_forms, total_fields, message, updated_at, doc_hash, active_generation_id FROM ragic_field_index_state WHERE id = 1"
        );
        const merged: RagicFieldIndexStateRow = {
          status: input.status,
          refreshed_at:
            input.refreshedAt !== undefined
              ? input.refreshedAt
              : existing?.refreshed_at ?? null,
          total_forms:
            input.totalForms !== undefined
              ? input.totalForms
              : existing?.total_forms ?? 0,
          total_fields:
            input.totalFields !== undefined
              ? input.totalFields
              : existing?.total_fields ?? 0,
          message:
            input.message !== undefined ? input.message : existing?.message ?? null,
          updated_at: now,
          doc_hash:
            input.lastDocHash !== undefined
              ? input.lastDocHash
              : existing?.doc_hash ?? null,
          active_generation_id: existing?.active_generation_id ?? "legacy",
        };
        await db.run(
          `
          INSERT INTO ragic_field_index_state (id, status, refreshed_at, total_forms, total_fields, message, updated_at, doc_hash)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            refreshed_at = excluded.refreshed_at,
            total_forms = excluded.total_forms,
            total_fields = excluded.total_fields,
            message = excluded.message,
            updated_at = excluded.updated_at,
            doc_hash = excluded.doc_hash
          `,
          merged.status,
          merged.refreshed_at,
          merged.total_forms,
          merged.total_fields,
          merged.message,
          merged.updated_at,
          merged.doc_hash
        );
        return mapState(merged);
      });
    },
  };
}

export const ragicFieldIndexRepository: RagicFieldIndexRepository =
  createRagicFieldIndexRepository(
    () => sqliteClient.getDb(),
    () => sqliteClient.getReadDb()
  );
