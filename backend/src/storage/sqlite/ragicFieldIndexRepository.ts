import type { Database } from "sqlite";
import { sqliteClient } from "./sqliteClient";
import type {
  RagicFieldIndexEntry,
  RagicFieldIndexState,
  RagicFieldIndexStatus,
  RagicFieldScope,
} from "../../types/ragicFieldIndex";

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
}

interface RagicFieldIndexStateRow {
  status: string;
  refreshed_at: string | null;
  total_forms: number;
  total_fields: number;
  message: string | null;
  updated_at: string;
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
  getDb: () => Promise<Database>
): RagicFieldIndexRepository {
  let writeChain: Promise<void> = Promise.resolve();

  async function runSerializedWrite<T>(
    operation: (db: Database) => Promise<T>
  ): Promise<T> {
    const scheduled = writeChain
      .catch(() => {
        // 避免上一筆失敗讓後續寫入卡住
      })
      .then(async () => operation(await getDb()));
    writeChain = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  }

  return {
    async replaceAll(entries, refreshedAt) {
      return runSerializedWrite(async (db) => {
        await db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          await db.exec("DELETE FROM ragic_field_index");
          for (const entry of entries) {
            await db.run(
              `
              INSERT INTO ragic_field_index (
                form_path, form_name, scope, subtable_name, subtable_key,
                field_pos, field_name, field_id, field_type, field_note,
                search_text, refreshed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
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
              refreshedAt
            );
          }
          await db.exec("COMMIT");
        } catch (error) {
          await db.exec("ROLLBACK");
          throw error;
        }
        const counts = await db.get<{ form_count: number; field_count: number }>(
          "SELECT COUNT(DISTINCT form_path) AS form_count, COUNT(*) AS field_count FROM ragic_field_index"
        );
        return {
          totalForms: counts?.form_count ?? 0,
          totalFields: counts?.field_count ?? 0,
        };
      });
    },

    async search(params) {
      const db = await getDb();
      const conditions: string[] = [];
      const values: unknown[] = [];
      const q = (params.q ?? "").trim().toLowerCase();
      if (q) {
        conditions.push("search_text LIKE ?");
        values.push(`%${q}%`);
      }
      if (params.formPath && params.formPath.trim()) {
        conditions.push("form_path = ?");
        values.push(params.formPath.trim());
      }
      if (params.fieldId && params.fieldId.trim()) {
        conditions.push("field_id = ?");
        values.push(params.fieldId.trim());
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(
        Math.max(Math.trunc(params.limit ?? 200), 1),
        2000
      );
      const sql = `
        SELECT id, form_path, form_name, scope, subtable_name, subtable_key,
               field_pos, field_name, field_id, field_type, field_note, refreshed_at
        FROM ragic_field_index
        ${where}
        ORDER BY form_path ASC, scope DESC, subtable_key ASC, field_pos ASC, id ASC
        LIMIT ?
      `;
      const rows = await db.all<RagicFieldIndexRow[]>(sql, ...values, limit);
      return rows.map(mapEntry);
    },

    async countAll() {
      const db = await getDb();
      const row = await db.get<{ form_count: number; field_count: number }>(
        "SELECT COUNT(DISTINCT form_path) AS form_count, COUNT(*) AS field_count FROM ragic_field_index"
      );
      return {
        totalForms: row?.form_count ?? 0,
        totalFields: row?.field_count ?? 0,
      };
    },

    async getState() {
      const db = await getDb();
      const row = await db.get<RagicFieldIndexStateRow>(
        "SELECT status, refreshed_at, total_forms, total_fields, message, updated_at FROM ragic_field_index_state WHERE id = 1"
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
          "SELECT status, refreshed_at, total_forms, total_fields, message, updated_at FROM ragic_field_index_state WHERE id = 1"
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
        };
        await db.run(
          `
          INSERT INTO ragic_field_index_state (id, status, refreshed_at, total_forms, total_fields, message, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            refreshed_at = excluded.refreshed_at,
            total_forms = excluded.total_forms,
            total_fields = excluded.total_fields,
            message = excluded.message,
            updated_at = excluded.updated_at
          `,
          merged.status,
          merged.refreshed_at,
          merged.total_forms,
          merged.total_fields,
          merged.message,
          merged.updated_at
        );
        return mapState(merged);
      });
    },
  };
}

export const ragicFieldIndexRepository: RagicFieldIndexRepository =
  createRagicFieldIndexRepository(() => sqliteClient.getDb());
