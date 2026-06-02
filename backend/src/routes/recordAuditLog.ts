import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { HttpError } from "../utils/httpError";
import {
  recordAuditLogRepository,
  type RecordAuditLogEntry,
  type RecordAuditScope,
} from "../storage/sqlite/recordAuditLogRepository";

const recordAuditLogRouter = Router();

const VALID_SCOPES: RecordAuditScope[] = ["work-report", "downtime"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseLimit(raw: unknown): number {
  const value = String(raw ?? "").trim();
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, "limit 必須是 1..500 的整數", "INVALID_QUERY_PARAM");
  }
  return Math.min(MAX_LIMIT, parsed);
}

/**
 * Update 動作 patch 跟 before snapshot 比對，回傳實際變動的 top-level 欄位名稱。
 * delete 一律回空陣列。
 */
function computeChangedFields(entry: RecordAuditLogEntry): string[] {
  if (entry.action !== "update") return [];
  const patch = entry.afterPatch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return [];
  const before = entry.beforeSnapshot;
  const beforeIsObject = before && typeof before === "object" && !Array.isArray(before);
  const beforeMap = beforeIsObject ? (before as Record<string, unknown>) : {};
  const changed: string[] = [];
  for (const [key, nextValue] of Object.entries(patch as Record<string, unknown>)) {
    const prevValue = beforeMap[key];
    if (JSON.stringify(prevValue) !== JSON.stringify(nextValue)) {
      changed.push(key);
    }
  }
  return changed;
}

recordAuditLogRouter.get(
  "/audit/records",
  asyncHandler(async (req, res) => {
    const scope = String(req.query.scope ?? "").trim() as RecordAuditScope;
    if (!VALID_SCOPES.includes(scope)) {
      throw new HttpError(400, "scope 必須是 work-report 或 downtime", "INVALID_QUERY_PARAM");
    }
    const formId = String(req.query.formId ?? "").trim();
    const entryId = String(req.query.entryId ?? "").trim();
    if (!formId) {
      throw new HttpError(400, "缺少 formId", "INVALID_QUERY_PARAM");
    }
    // entryId 不指定時：列出該 scope+formId 全部 entry 的歷史（停機紀錄一頁看完用）
    // rowId 不指定時：work-report 列出該工令所有 row 的歷史（包括已刪掉的）
    //                   downtime 本來就不需要 rowId
    const rowIdRaw = String(req.query.rowId ?? "").trim();
    const rowId = rowIdRaw || undefined;
    const limit = parseLimit(req.query.limit);

    const entries = await recordAuditLogRepository.listByRecord({
      scope,
      formId,
      entryId: entryId || undefined,
      rowId,
      limit,
    });

    const data = entries.map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      formId: entry.formId,
      entryId: entry.entryId,
      rowId: entry.rowId,
      action: entry.action,
      actor: {
        clientId: entry.actorClientId,
        tabId: entry.actorTabId,
        ip: entry.actorIp,
        label: entry.actorLabel,
      },
      taskId: entry.taskId,
      beforeSnapshot: entry.beforeSnapshot,
      afterPatch: entry.afterPatch,
      changedFields: computeChangedFields(entry),
      occurredAt: entry.occurredAt,
    }));

    res.json({
      data,
      meta: {
        count: data.length,
        limit,
        scope,
        formId,
        entryId: entryId || null,
        rowId: rowId ?? null,
      },
    });
  })
);

export default recordAuditLogRouter;
