import { randomUUID } from "crypto";
import { Router, type Response } from "express";
import { asyncHandler } from "./asyncHandler";
import { HttpError } from "../utils/httpError";
import { form16DowntimeService } from "../services/form16/form16DowntimeService";
import { form16DowntimeCreateTaskService } from "../services/form16/form16DowntimeCreateTaskService";
import { form16DowntimeCallbackRefreshService } from "../services/form16/form16DowntimeCallbackRefreshService";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskStatus,
  type WorkReportQueueTaskType,
} from "../services/work-report/workReportTaskRegistryService";
import {
  assertRagicCallbackToken,
  parseRagicCallbackPayload,
} from "./workReportRequest";
import { readTaskActorContext } from "./taskActorContext";
import { safeInsertRecordAudit } from "../services/audit/recordAuditLogger";
import {
  FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
  runForm16DowntimeMutationExclusive,
} from "../services/form16/form16DowntimeMutationQueue";
import { createReportTaskService } from "../services/createReportTaskService";
import { createStableJsonFingerprint } from "../utils/stableJsonFingerprint";

const form16DowntimeRouter = Router();
const DEFAULT_DOWNTIME_RECORD_LIMIT = 20;
const MAX_DOWNTIME_RECORD_LIMIT = 200;
const DEFAULT_DOWNTIME_TASK_LIMIT = 50;
const MAX_DOWNTIME_TASK_LIMIT = 200;
const DOWNTIME_TASK_TYPES: WorkReportQueueTaskType[] = [
  "create-downtime",
  "update-downtime",
  "delete-downtime",
];
const DOWNTIME_TASK_STATUSES: WorkReportQueueTaskStatus[] = [
  "pending",
  "running",
  "success",
  "failed",
];

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

form16DowntimeRouter.get(
  "/downtime/planned-idle-summary",
  asyncHandler(async (req, res) => {
    // month 選填（YYYY/MM）；不帶就「當月」。回每機台當月 (P)計畫停機分加總（含部分停機）。
    const monthParam = String(req.query.month ?? "").trim() || undefined;
    const refresh = String(req.query.refresh ?? "").trim() === "1";
    const result = await form16DowntimeService.summarizePlannedIdleByMachine(monthParam, refresh);
    res.json({
      data: result.machines,
      meta: {
        month: result.month,
        machineCount: result.machines.length,
        source: result.source,
        refreshed: result.refreshed,
        refreshTriggered: result.refreshTriggered,
        snapshotAt: result.snapshotAt,
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
    const clientRowKey = String(body.clientRowKey ?? "").trim();
    if (!clientRowKey) {
      throw new HttpError(
        400,
        "停機紀錄背景建立必須提供 clientRowKey，才能安全處理重送。",
        "DOWNTIME_CLIENT_ROW_KEY_REQUIRED"
      );
    }
    const input = {
      date: readRequiredText(body, "date"),
      machineId: readRequiredText(body, "machineId"),
      processCode: readRequiredText(body, "processCode"),
      operatorId: readOptionalText(body, "operatorId"),
      plannedIdleMinutes: readOptionalNonNegativeNumber(body, "plannedIdleMinutes"),
      remark: String(body.remark ?? "").trim() || undefined,
      clientRowKey,
    };
    const actor = readTaskActorContext(req);
    await form16DowntimeCreateTaskService.initialize();
    const task = form16DowntimeCreateTaskService.enqueue({
      payload: input,
      actorClientId: actor.actorClientId,
      actorTabId: actor.actorTabId,
      actorIp: actor.actorIp,
      actorLabel: actor.actorLabel,
    });

    await workReportTaskRegistryService.flush();
    const registryTask = workReportTaskRegistryService.getTask(task.taskId);
    const isTaskUnconfirmed = task.status === "pending" || task.status === "running";

    res.status(202).json({
      data: {
        taskId: task.taskId,
        status: task.status,
        createdAt: task.createdAt,
        lifecycleState:
          task.status === "pending"
            ? "accepted"
            : registryTask?.lifecycleState ?? task.status,
        acceptedAt: registryTask?.acceptedAt ?? task.createdAt,
        confirmedAt: isTaskUnconfirmed ? null : registryTask?.confirmedAt ?? null,
        ...(task.entryId ? { entryId: task.entryId } : {}),
      },
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

function readOptionalSnapshotHash(body: Record<string, unknown>, fieldName: string): string | null {
  if (!(fieldName in body)) return null;
  const value = String(body[fieldName] ?? "").trim();
  return value || null;
}

function readHeaderSnapshotHash(req: { header(name: string): string | undefined }): string | null {
  const value = String(req.header("x-downtime-snapshot-hash") ?? "").trim();
  return value || null;
}

function readAsyncMutationFlag(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readRequiredClientMutationId(req: {
  header(name: string): string | undefined;
}): string {
  const clientMutationId = String(req.header("x-client-mutation-id") ?? "").trim();
  if (!clientMutationId) {
    throw new HttpError(
      400,
      "背景停機紀錄異動必須提供 x-client-mutation-id，才能安全處理重試與服務重啟。",
      "CLIENT_MUTATION_ID_REQUIRED"
    );
  }
  return clientMutationId;
}

function sendAcceptedDowntimeTask(
  res: Response,
  task: ReturnType<typeof createReportTaskService.enqueue>,
  entryId: string
): void {
  res.status(202).json({
    data: {
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
      lifecycleState: task.lifecycleState ?? "accepted",
      acceptedAt: task.acceptedAt ?? task.createdAt,
      confirmedAt: task.confirmedAt ?? null,
      entryId,
    },
  });
}

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
    const expectedSnapshotHash = readOptionalSnapshotHash(body, "expectedSnapshotHash");
    const actor = readTaskActorContext(req);
    if (readAsyncMutationFlag(req.query.async)) {
      const clientMutationId = readRequiredClientMutationId(req);
      await createReportTaskService.initialize();
      const task = createReportTaskService.enqueue({
        taskType: "update-downtime",
        formId: "16",
        entryId,
        queueKey: FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
        clientMutationId,
        operationFingerprint: createStableJsonFingerprint({
          operation: "update-downtime",
          entryId,
          patch,
          expectedSnapshotHash,
        }),
        actorClientId: actor.actorClientId ?? undefined,
        actorTabId: actor.actorTabId ?? undefined,
        actorIp: actor.actorIp ?? undefined,
        actorLabel: actor.actorLabel ?? undefined,
        worker: async () => {
          const updated = await form16DowntimeService.updateRecord(entryId, patch, {
            expectedSnapshotHash,
            deferProjection: true,
          });
          await safeInsertRecordAudit({
            scope: "downtime",
            formId: "16",
            entryId,
            action: "update",
            actorClientId: actor.actorClientId,
            actorTabId: actor.actorTabId,
            actorIp: actor.actorIp,
            actorLabel: actor.actorLabel,
            taskId: task.taskId,
            beforeSnapshot: updated.beforeSnapshot,
            afterPatch: patch,
          });
        },
      });
      sendAcceptedDowntimeTask(res, task, entryId);
      return;
    }
    const taskId = randomUUID();
    const now = new Date().toISOString();

    workReportTaskRegistryService.upsertTask({
      taskId,
      taskType: "update-downtime",
      status: "running",
      formId: "16",
      entryId,
      queueKey: FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
      createdAt: now,
      startedAt: now,
      acceptedAt: now,
      updatedAt: now,
      message: "停機紀錄更新中",
      actorClientId: actor.actorClientId,
      actorTabId: actor.actorTabId,
      actorIp: actor.actorIp,
      actorLabel: actor.actorLabel,
    });

    try {
      await runForm16DowntimeMutationExclusive(async () => {
        const updated = await form16DowntimeService.updateRecord(entryId, patch, {
          expectedSnapshotHash,
        });
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
          beforeSnapshot: updated.beforeSnapshot,
          afterPatch: patch,
        });
      });
      const confirmedAt = new Date().toISOString();
      workReportTaskRegistryService.upsertTask({
        taskId,
        taskType: "update-downtime",
        status: "success",
        formId: "16",
        entryId,
        queueKey: FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
        // downtime 是 entry-level，registry 的 rowId 保持 null；updated.id 本來就是 entryId
        finishedAt: confirmedAt,
        confirmedAt,
        updatedAt: confirmedAt,
        message: "停機紀錄已更新",
      });
    } catch (error) {
      const confirmedAt = new Date().toISOString();
      workReportTaskRegistryService.upsertTask({
        taskId,
        taskType: "update-downtime",
        status: "failed",
        formId: "16",
        entryId,
        queueKey: FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
        finishedAt: confirmedAt,
        confirmedAt,
        updatedAt: confirmedAt,
        message: error instanceof Error ? error.message : "更新失敗",
        errorCode: error instanceof HttpError ? error.code : "UPDATE_DOWNTIME_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const task = workReportTaskRegistryService.getTask(taskId);
    res.status(200).json({
      data: {
        taskId,
        status: "success",
        createdAt: now,
        lifecycleState: task?.lifecycleState ?? "success",
        acceptedAt: task?.acceptedAt ?? now,
        confirmedAt: task?.confirmedAt ?? task?.finishedAt ?? null,
        entryId,
      },
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
    const expectedSnapshotHash = readHeaderSnapshotHash(req);
    if (readAsyncMutationFlag(req.query.async)) {
      const clientMutationId = readRequiredClientMutationId(req);
      await createReportTaskService.initialize();
      const task = createReportTaskService.enqueue({
        taskType: "delete-downtime",
        formId: "16",
        entryId,
        queueKey: FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
        clientMutationId,
        operationFingerprint: createStableJsonFingerprint({
          operation: "delete-downtime",
          entryId,
          expectedSnapshotHash,
        }),
        actorClientId: actor.actorClientId ?? undefined,
        actorTabId: actor.actorTabId ?? undefined,
        actorIp: actor.actorIp ?? undefined,
        actorLabel: actor.actorLabel ?? undefined,
        worker: async () => {
          const deleted = await form16DowntimeService.deleteRecord(entryId, {
            expectedSnapshotHash,
            deferProjection: true,
          });
          await safeInsertRecordAudit({
            scope: "downtime",
            formId: "16",
            entryId,
            action: "delete",
            actorClientId: actor.actorClientId,
            actorTabId: actor.actorTabId,
            actorIp: actor.actorIp,
            actorLabel: actor.actorLabel,
            taskId: task.taskId,
            beforeSnapshot: deleted.beforeSnapshot,
          });
        },
      });
      sendAcceptedDowntimeTask(res, task, entryId);
      return;
    }
    const taskId = randomUUID();
    const now = new Date().toISOString();

    workReportTaskRegistryService.upsertTask({
      taskId,
      taskType: "delete-downtime",
      status: "running",
      formId: "16",
      entryId,
      queueKey: FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
      createdAt: now,
      startedAt: now,
      acceptedAt: now,
      updatedAt: now,
      message: "停機紀錄刪除中",
      actorClientId: actor.actorClientId,
      actorTabId: actor.actorTabId,
      actorIp: actor.actorIp,
      actorLabel: actor.actorLabel,
    });

    try {
      await runForm16DowntimeMutationExclusive(async () => {
        const deleted = await form16DowntimeService.deleteRecord(entryId, {
          expectedSnapshotHash,
        });
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
          beforeSnapshot: deleted.beforeSnapshot,
        });
      });
      const confirmedAt = new Date().toISOString();
      workReportTaskRegistryService.upsertTask({
        taskId,
        taskType: "delete-downtime",
        status: "success",
        formId: "16",
        entryId,
        queueKey: FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
        finishedAt: confirmedAt,
        confirmedAt,
        updatedAt: confirmedAt,
        message: `停機紀錄 ${entryId} 已刪除`,
      });
    } catch (error) {
      const confirmedAt = new Date().toISOString();
      workReportTaskRegistryService.upsertTask({
        taskId,
        taskType: "delete-downtime",
        status: "failed",
        formId: "16",
        entryId,
        queueKey: FORM16_DOWNTIME_MUTATION_QUEUE_KEY,
        finishedAt: confirmedAt,
        confirmedAt,
        updatedAt: confirmedAt,
        message: error instanceof Error ? error.message : "刪除失敗",
        errorCode: error instanceof HttpError ? error.code : "DELETE_DOWNTIME_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const task = workReportTaskRegistryService.getTask(taskId);
    res.status(200).json({
      data: {
        taskId,
        status: "success",
        createdAt: now,
        lifecycleState: task?.lifecycleState ?? "success",
        acceptedAt: task?.acceptedAt ?? now,
        confirmedAt: task?.confirmedAt ?? task?.finishedAt ?? null,
        entryId,
      },
    });
  })
);

form16DowntimeRouter.get(
  "/downtime/tasks",
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? "").trim() || undefined;
    const taskType = String(req.query.taskType ?? "").trim() || undefined;
    const actorClientIdQuery = String(req.query.actorClientId ?? "").trim();
    const actor = readTaskActorContext(req);
    const actorClientId = actorClientIdQuery || actor.actorClientId || null;
    const limit = readOptionalPositiveInt(
      req.query.limit,
      DEFAULT_DOWNTIME_TASK_LIMIT,
      "limit",
      {
        min: 1,
        max: MAX_DOWNTIME_TASK_LIMIT,
      }
    );

    if (status && !DOWNTIME_TASK_STATUSES.includes(status as WorkReportQueueTaskStatus)) {
      throw new HttpError(400, `不支援的任務狀態：${status}`, "TASK_STATUS_INVALID");
    }
    if (taskType && !DOWNTIME_TASK_TYPES.includes(taskType as WorkReportQueueTaskType)) {
      throw new HttpError(400, `不支援的任務類型：${taskType}`, "TASK_TYPE_INVALID");
    }

    const tasks = actorClientId
      ? workReportTaskRegistryService.listTasks({
          formId: "16",
          status: status as WorkReportQueueTaskStatus | undefined,
          taskType: taskType as WorkReportQueueTaskType | undefined,
          taskTypes: taskType ? undefined : DOWNTIME_TASK_TYPES,
          actorClientId,
          limit,
        })
      : [];

    res.json({
      data: tasks,
      meta: {
        formId: "16",
        count: tasks.length,
        status: status ?? null,
        taskType: taskType ?? null,
        actorClientId: actorClientId ?? null,
        limit,
      },
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
    if (!task || task.formId !== "16" || !DOWNTIME_TASK_TYPES.includes(task.taskType)) {
      throw new HttpError(404, "找不到此任務", "TASK_NOT_FOUND");
    }
    res.json({ data: task });
  })
);

export default form16DowntimeRouter;
