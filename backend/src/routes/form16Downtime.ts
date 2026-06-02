import { randomUUID } from "crypto";
import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { HttpError } from "../utils/httpError";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { form16DowntimeService } from "../services/form16/form16DowntimeService";
import { form16DowntimeCallbackRefreshService } from "../services/form16/form16DowntimeCallbackRefreshService";
import { workReportTaskRegistryService } from "../services/work-report/workReportTaskRegistryService";
import {
  assertRagicCallbackToken,
  parseRagicCallbackPayload,
} from "./workReportRequest";
import { readTaskActorContext } from "./taskActorContext";
import { safeInsertRecordAudit } from "../services/audit/recordAuditLogger";
import { readDowntimeSnapshot } from "../services/audit/recordAuditSnapshotResolver";

const form16DowntimeRouter = Router();
const DEFAULT_DOWNTIME_RECORD_LIMIT = 20;
const MAX_DOWNTIME_RECORD_LIMIT = 200;

function readOptionalPositiveInt(
  value: unknown,
  fallback: number,
  fieldName: string,
  options: { min?: number; max?: number } = {}
): number {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return fallback;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < (options.min ?? 0)) {
    throw new HttpError(400, `${fieldName} 必須是有效整數`, "INVALID_QUERY_PARAM");
  }
  if (options.max !== undefined && parsed > options.max) {
    return options.max;
  }
  return parsed;
}

function readRequiredText(body: Record<string, unknown>, fieldName: string): string {
  const value = String(body[fieldName] ?? "").trim();
  if (!value) {
    throw new HttpError(400, `缺少必要欄位：${fieldName}`, "INVALID_PAYLOAD");
  }
  return value;
}

function readOptionalText(body: Record<string, unknown>, fieldName: string): string | undefined {
  const value = String(body[fieldName] ?? "").trim();
  return value || undefined;
}

function readOptionalNonNegativeNumber(
  body: Record<string, unknown>,
  fieldName: string
): number | undefined {
  const raw = body[fieldName];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(400, `${fieldName} 需為 0 以上數字`, "INVALID_PAYLOAD");
  }
  return Math.trunc(parsed);
}

form16DowntimeRouter.get(
  "/downtime/options",
  asyncHandler(async (_req, res) => {
    const data = await form16DowntimeService.getOptions();
    res.json({
      data,
      meta: {
        fields: Object.keys(data),
      },
    });
  })
);

form16DowntimeRouter.get(
  "/downtime/records",
  asyncHandler(async (req, res) => {
    const refresh = String(req.query.refresh ?? "").trim() === "1";
    const limit = readOptionalPositiveInt(
      req.query.limit,
      DEFAULT_DOWNTIME_RECORD_LIMIT,
      "limit",
      {
        min: 1,
        max: MAX_DOWNTIME_RECORD_LIMIT,
      }
    );
    const offset = readOptionalPositiveInt(req.query.offset, 0, "offset", { min: 0 });
    const result = await form16DowntimeService.listRecords({
      refresh,
      limit,
      offset,
    });
    res.json({
      data: result.records,
      meta: {
        count: result.records.length,
        totalCount: result.totalCount,
        limit,
        offset,
        hasMore: offset + result.records.length < result.totalCount,
        source: result.source,
        refreshed: result.refreshed,
        refreshTriggered: result.refreshTriggered ?? false,
      },
    });
  })
);

// Form 16 在 Ragic 端的 JavaScript Workflow Callback 會 POST 到這裡
// （headers: x-ragic-callback-token + Content-Type: application/json）
// body 格式：{ entryId, eventType, source }
// 用途：接住別人在 Ragic UI 直接改/刪/新增 Form 16 entry 的事件，
// 將本地 SQLite snapshot 同步到最新狀態。
// 路徑跟 104/105 的 `/api/forms/:formId/ragic-callback` 對齊；
// 由於 form16DowntimeRouter 在 server.ts 比 workReportRouter 先 mount，
// `POST /api/forms/16/ragic-callback` 會先被這裡攔到，不會走到 work-report 的 `/:formId` 路由。
form16DowntimeRouter.post(
  "/forms/16/ragic-callback",
  asyncHandler(async (req, res) => {
    assertRagicCallbackToken(req.header("x-ragic-callback-token"));
    const payload = parseRagicCallbackPayload(req.body);
    const actor = readTaskActorContext(req);
    const task = form16DowntimeCallbackRefreshService.enqueue({
      entryId: payload.entryId,
      eventType: payload.eventType,
      ...(payload.source ? { source: payload.source } : {}),
      ...(actor.actorIp ? { actorIp: actor.actorIp } : {}),
      ...(actor.actorLabel ? { actorLabel: actor.actorLabel } : {}),
    });
    res.status(202).json({
      data: {
        accepted: true,
        entryId: task.entryId,
        eventType: task.eventType,
        taskId: task.taskId,
        status: task.status,
        createdAt: task.createdAt,
      },
    });
  })
);

form16DowntimeRouter.post(
  "/downtime/records",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientRowKey = String(body.clientRowKey ?? "").trim() || undefined;
    const input = {
      date: readRequiredText(body, "date"),
      machineId: readRequiredText(body, "machineId"),
      processCode: readRequiredText(body, "processCode"),
      operatorId: readOptionalText(body, "operatorId"),
      plannedIdleMinutes: readOptionalNonNegativeNumber(body, "plannedIdleMinutes"),
      remark: String(body.remark ?? "").trim() || undefined,
      ...(clientRowKey ? { clientRowKey } : {}),
    };
    const actor = readTaskActorContext(req);
    const taskId = randomUUID();
    const now = new Date().toISOString();

    workReportTaskRegistryService.upsertTask({
      taskId,
      taskType: "create-downtime",
      status: "running",
      formId: "16",
      entryId: null,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      message: "停機紀錄建立中",
      actorClientId: actor.actorClientId,
      actorTabId: actor.actorTabId,
      actorIp: actor.actorIp,
      actorLabel: actor.actorLabel,
    });

    runBackgroundTask(
      `create-downtime:${taskId}`,
      async () => {
        const result = await form16DowntimeService.createRecord(input);
        workReportTaskRegistryService.upsertTask({
          taskId,
          taskType: "create-downtime",
          status: "success",
          formId: "16",
          // downtime 是 entry-level，registry 的 rowId 保持 null；建好後才知道 entryId 就填 entryId 欄
          entryId: result.entryId ?? null,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: result.entryId
            ? `停機紀錄已建立（Entry ${result.entryId}）`
            : "停機紀錄已建立",
        });
      },
      (error) => {
        workReportTaskRegistryService.upsertTask({
          taskId,
          taskType: "create-downtime",
          status: "failed",
          formId: "16",
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : "建立失敗",
          errorCode: "CREATE_DOWNTIME_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    );

    res.status(202).json({
      data: { taskId, status: "running" },
    });
  })
);

function readOptionalEntryId(body: Record<string, unknown>, fieldName: string): string | undefined {
  if (!(fieldName in body)) return undefined;
  const raw = body[fieldName];
  // 明確傳 null 表示清空；其他情況轉字串 trim
  if (raw === null) return "";
  return String(raw ?? "").trim();
}

function readOptionalPatchText(
  body: Record<string, unknown>,
  fieldName: string
): string | undefined {
  if (!(fieldName in body)) return undefined;
  return String(body[fieldName] ?? "").trim();
}

// TODO(concurrency): 目前沒有 expectedEntryLastUpdatedAt / editLockVersion 併發控制。
// 兩人同時編輯同一筆會後者覆蓋前者。待補 auth 時一起處理 ACL + optimistic locking。
form16DowntimeRouter.patch(
  "/downtime/records/:entryId",
  asyncHandler(async (req, res) => {
    const entryId = String(req.params.entryId ?? "").trim();
    if (!/^\d+$/.test(entryId)) {
      throw new HttpError(400, "非法的 entryId", "INVALID_ENTRY_ID");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch = {
      date: readOptionalPatchText(body, "date"),
      machineId: readOptionalPatchText(body, "machineId"),
      processCode: readOptionalPatchText(body, "processCode"),
      operatorId: readOptionalEntryId(body, "operatorId"),
      plannedIdleMinutes: readOptionalNonNegativeNumber(body, "plannedIdleMinutes"),
      remark: readOptionalPatchText(body, "remark"),
    };
    const actor = readTaskActorContext(req);
    const taskId = randomUUID();
    const now = new Date().toISOString();
    // 在 mutation 之前抓 before snapshot；之後抓會抓到新值
    const beforeSnapshot = await readDowntimeSnapshot(entryId);

    workReportTaskRegistryService.upsertTask({
      taskId,
      taskType: "update-downtime",
      status: "running",
      formId: "16",
      entryId,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      message: "停機紀錄更新中",
      actorClientId: actor.actorClientId,
      actorTabId: actor.actorTabId,
      actorIp: actor.actorIp,
      actorLabel: actor.actorLabel,
    });

    runBackgroundTask(
      `update-downtime:${taskId}`,
      async () => {
        await form16DowntimeService.updateRecord(entryId, patch);
        await safeInsertRecordAudit({
          scope: "downtime",
          formId: "16",
          entryId,
          action: "update",
          actorClientId: actor.actorClientId,
          actorTabId: actor.actorTabId,
          actorIp: actor.actorIp,
          actorLabel: actor.actorLabel,
          taskId,
          beforeSnapshot,
          afterPatch: patch,
        });
        workReportTaskRegistryService.upsertTask({
          taskId,
          taskType: "update-downtime",
          status: "success",
          formId: "16",
          entryId,
          // downtime 是 entry-level，registry 的 rowId 保持 null；updated.id 本來就是 entryId
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: "停機紀錄已更新",
        });
      },
      (error) => {
        workReportTaskRegistryService.upsertTask({
          taskId,
          taskType: "update-downtime",
          status: "failed",
          formId: "16",
          entryId,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : "更新失敗",
          errorCode: "UPDATE_DOWNTIME_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    );

    res.status(202).json({
      data: { taskId, status: "running" },
    });
  })
);

form16DowntimeRouter.delete(
  "/downtime/records/:entryId",
  asyncHandler(async (req, res) => {
    const entryId = String(req.params.entryId ?? "").trim();
    if (!/^\d+$/.test(entryId)) {
      throw new HttpError(400, "非法的 entryId", "INVALID_ENTRY_ID");
    }
    const actor = readTaskActorContext(req);
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const beforeSnapshot = await readDowntimeSnapshot(entryId);

    workReportTaskRegistryService.upsertTask({
      taskId,
      taskType: "delete-downtime",
      status: "running",
      formId: "16",
      entryId,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      message: "停機紀錄刪除中",
      actorClientId: actor.actorClientId,
      actorTabId: actor.actorTabId,
      actorIp: actor.actorIp,
      actorLabel: actor.actorLabel,
    });

    runBackgroundTask(
      `delete-downtime:${taskId}`,
      async () => {
        await form16DowntimeService.deleteRecord(entryId);
        await safeInsertRecordAudit({
          scope: "downtime",
          formId: "16",
          entryId,
          action: "delete",
          actorClientId: actor.actorClientId,
          actorTabId: actor.actorTabId,
          actorIp: actor.actorIp,
          actorLabel: actor.actorLabel,
          taskId,
          beforeSnapshot,
        });
        workReportTaskRegistryService.upsertTask({
          taskId,
          taskType: "delete-downtime",
          status: "success",
          formId: "16",
          entryId,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: `停機紀錄 ${entryId} 已刪除`,
        });
      },
      (error) => {
        workReportTaskRegistryService.upsertTask({
          taskId,
          taskType: "delete-downtime",
          status: "failed",
          formId: "16",
          entryId,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : "刪除失敗",
          errorCode: "DELETE_DOWNTIME_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    );

    res.status(202).json({
      data: { taskId, status: "running" },
    });
  })
);

form16DowntimeRouter.get(
  "/downtime/tasks/:taskId",
  asyncHandler(async (req, res) => {
    const taskId = String(req.params.taskId ?? "").trim();
    if (!taskId) {
      throw new HttpError(400, "缺少 taskId", "INVALID_PAYLOAD");
    }
    const task = workReportTaskRegistryService.getTask(taskId);
    if (!task) {
      throw new HttpError(404, "找不到此任務", "TASK_NOT_FOUND");
    }
    res.json({ data: task });
  })
);

export default form16DowntimeRouter;
