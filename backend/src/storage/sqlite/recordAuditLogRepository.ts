import type { Database } from "sqlite";
import { sqliteClient } from "./sqliteClient";

export type RecordAuditScope = "work-report" | "downtime";
export type RecordAuditAction = "update" | "delete";

export interface RecordAuditLogEntry {
  id: number;
  scope: RecordAuditScope;
  formId: string;
  entryId: string;
  rowId: string | null;
  action: RecordAuditAction;
  actorClientId: string | null;
  actorTabId: string | null;
  actorIp: string | null;
  actorLabel: string | null;
  taskId: string | null;
  beforeSnapshot: unknown | null;
  afterPatch: unknown | null;
  occurredAt: string;
}

export interface RecordAuditLogInsertInput {
  scope: RecordAuditScope;
  formId: string;
  entryId: string;
  rowId?: string | null;
  action: RecordAuditAction;
  actorClientId?: string | null;
  actorTabId?: string | null;
  actorIp?: string | null;
  actorLabel?: string | null;
  taskId?: string | null;
  beforeSnapshot?: unknown;
  afterPatch?: unknown;
  occurredAt?: string;
}

export interface RecordAuditLogListParams {
  scope: RecordAuditScope;
  formId: string;
  /** 不指定時列出該 scope+formId 全部 entry 的歷史 */
  entryId?: string;
  rowId?: string | null;
  limit?: number;
}

interface RowShape {
  id: number;
  scope: string;
  form_id: string;
  entry_id: string;
  row_id: string | null;
  action: string;
  actor_client_id: string | null;
  actor_tab_id: string | null;
  actor_ip: string | null;
  actor_label: string | null;
  task_id: string | null;
  before_snapshot_json: string | null;
  after_patch_json: string | null;
  occurred_at: string;
}

function safeParse(json: string | null): unknown | null {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function safeStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function mapRow(row: RowShape): RecordAuditLogEntry {
  return {
    id: row.id,
    scope: row.scope as RecordAuditScope,
    formId: row.form_id,
    entryId: row.entry_id,
    rowId: row.row_id,
    action: row.action as RecordAuditAction,
    actorClientId: row.actor_client_id,
    actorTabId: row.actor_tab_id,
    actorIp: row.actor_ip,
    actorLabel: row.actor_label,
    taskId: row.task_id,
    beforeSnapshot: safeParse(row.before_snapshot_json),
    afterPatch: safeParse(row.after_patch_json),
    occurredAt: row.occurred_at,
  };
}

export interface RecordAuditLogRepository {
  insert(input: RecordAuditLogInsertInput): Promise<void>;
  listByRecord(params: RecordAuditLogListParams): Promise<RecordAuditLogEntry[]>;
  cleanupOlderThan(thresholdIso: string): Promise<number>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function createRecordAuditLogRepository(
  dbProvider: () => Promise<Database>
): RecordAuditLogRepository {
  return {
    async insert(input) {
      const db = await dbProvider();
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      await db.run(
        `INSERT INTO record_audit_log
           (scope, form_id, entry_id, row_id, action,
            actor_client_id, actor_tab_id, actor_ip, actor_label,
            task_id, before_snapshot_json, after_patch_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.scope,
        input.formId,
        input.entryId,
        input.rowId ?? null,
        input.action,
        input.actorClientId ?? null,
        input.actorTabId ?? null,
        input.actorIp ?? null,
        input.actorLabel ?? null,
        input.taskId ?? null,
        safeStringify(input.beforeSnapshot),
        safeStringify(input.afterPatch),
        occurredAt
      );
    },

    async listByRecord(params) {
      const db = await dbProvider();
      const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
      const hasEntryId = typeof params.entryId === "string" && params.entryId.length > 0;
      const hasRowId = params.rowId !== null && params.rowId !== undefined;
      const conditions: string[] = ["scope = ?", "form_id = ?"];
      const args: (string | number)[] = [params.scope, params.formId];
      if (hasEntryId) {
        conditions.push("entry_id = ?");
        args.push(params.entryId as string);
      }
      if (hasRowId) {
        conditions.push("row_id = ?");
        args.push(params.rowId as string);
      }
      args.push(limit);
      const sql = `
        SELECT id, scope, form_id, entry_id, row_id, action,
               actor_client_id, actor_tab_id, actor_ip, actor_label,
               task_id, before_snapshot_json, after_patch_json, occurred_at
        FROM record_audit_log
        WHERE ${conditions.join(" AND ")}
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?
      `;
      const rows = await db.all<RowShape[]>(sql, ...args);
      return rows.map(mapRow);
    },

    async cleanupOlderThan(thresholdIso) {
      const db = await dbProvider();
      const result = await db.run(
        `DELETE FROM record_audit_log WHERE occurred_at < ?`,
        thresholdIso
      );
      return typeof result.changes === "number" ? result.changes : 0;
    },
  };
}

export const recordAuditLogRepository: RecordAuditLogRepository =
  createRecordAuditLogRepository(() => sqliteClient.getDb());
