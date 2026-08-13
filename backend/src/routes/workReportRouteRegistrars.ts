import type { Router } from "express";
import { env } from "../config/env";
import type {
  WorkReportQueueTaskRecord,
  WorkReportQueueTaskStatus,
  WorkReportQueueTaskType,
} from "../services/work-report/workReportTaskRegistryService";
import { HttpError } from "../utils/httpError";
import { asyncHandler } from "./asyncHandler";
import type { WorkReportRouterDeps } from "./workReportRouterTypes";
import {
  assertRagicCallbackToken,
  assertReadableFormId,
  assertRequiredPathValue,
  assertWritableFormId,
  parseAnalysisQuery,
  parseAsyncFlag,
  parseEditingPresencePayload,
  parseMainMachineUpdatePayload,
  parseSortOrderUpdatePayload,
  parseRagicCallbackPayload,
  parseRawLimit,
  parseRefreshFlag,
  parseReportsQuery,
  parseRequestedFields,
  parseStrictRefreshFlag,
} from "./workReportRequest";
import {
  assertFullMutationPreconditions,
  assertLocalMutationPreconditions,
  parseMutationRequestContext,
  readTaskActorContext,
  runRequestEntryMutationExclusive,
  runPostMutationHooks,
  runPostSortOrderMutationHooks,
} from "./workReportMutationRouteHelpers";
import { safeInsertRecordAudit } from "../services/audit/recordAuditLogger";
import { readWorkReportRowSnapshot } from "../services/audit/recordAuditSnapshotResolver";
import { createStableJsonFingerprint } from "../utils/stableJsonFingerprint";
import {
  getWorkReportTaskStatusMergeRank,
  parseWorkReportTaskTimestamp,
} from "../services/work-report/workReportTaskStatusMerge";
import type { RagicRecord } from "../ragic/client";

const CREATE_REPORT_STATUS_CHECK_RETRY_DELAYS_MS = [5_000, 10_000, 20_000];

type CreateTaskRouteResponse = {
  taskId?: string;
  taskType?: "create-report" | "update-report";
  formId: string;
  entryId?: string;
  queueKey?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: {
    rowId?: string;
  };
  error?: {
    code?: string;
    message: string;
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCreateTaskRouteResponseFromRegistry(
  task: WorkReportQueueTaskRecord | null
): CreateTaskRouteResponse | null {
  if (!task || (task.taskType !== "create-report" && task.taskType !== "update-report")) {
    return null;
  }

  const entryId = String(task.entryId ?? "").trim();
  const queueKey = String(task.queueKey ?? "").trim();
  if (!entryId || !queueKey) {
    return null;
  }

  return {
    taskId: task.taskId,
    taskType: task.taskType,
    formId: task.formId,
    entryId,
    queueKey,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.rowId ? { result: { rowId: task.rowId } } : {}),
    ...(task.errorMessage
      ? {
          error: {
            ...(task.errorCode ? { code: task.errorCode } : {}),
            message: task.errorMessage,
          },
        }
      : {}),
  };
}

function selectCreateTaskRouteResponse(
  localTask: CreateTaskRouteResponse | null,
  registryTask: WorkReportQueueTaskRecord | null
): CreateTaskRouteResponse | null {
  const registryResponse = toCreateTaskRouteResponseFromRegistry(registryTask);
  if (!localTask) {
    return registryResponse;
  }
  if (!registryResponse) {
    return localTask;
  }

  const localRank = getWorkReportTaskStatusMergeRank(localTask.status);
  const registryRank = getWorkReportTaskStatusMergeRank(registryResponse.status);
  if (localRank !== registryRank) {
    return registryRank > localRank ? registryResponse : localTask;
  }

  return parseWorkReportTaskTimestamp(registryResponse.updatedAt) >
    parseWorkReportTaskTimestamp(localTask.updatedAt)
    ? registryResponse
    : localTask;
}

function isEntryStatusUnknownError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.statusCode === 409 &&
    error.code === "ENTRY_STATUS_UNKNOWN"
  );
}

async function assertCreateEntryAcceptsReportsWithRetry(
  deps: WorkReportRouterDeps,
  formId: string,
  entryId: string
): Promise<RagicRecord> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deps.assertCreateEntryAcceptsReports(formId, entryId);
    } catch (error) {
      const delayMs = CREATE_REPORT_STATUS_CHECK_RETRY_DELAYS_MS[attempt];
      if (!isEntryStatusUnknownError(error) || delayMs === undefined) {
        throw error;
      }

      console.warn("[work-report-create][entry-status-precheck-retry]", {
        formId,
        entryId,
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        waitMs: delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await (deps.sleep ?? sleep)(delayMs);
    }
  }
}

function parseBatchDeletePayload(body: unknown): {
  rowIds: string[];
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "批次刪除資料格式錯誤", "BATCH_DELETE_PAYLOAD_INVALID");
  }
  const payload = body as { rowIds?: unknown };
  if (!Array.isArray(payload.rowIds)) {
    throw new HttpError(400, "缺少 rowIds", "BATCH_DELETE_ROW_IDS_REQUIRED");
  }
  const rowIds = Array.from(
    new Set(
      payload.rowIds
        .map((rowId) => String(rowId ?? "").trim())
        .filter((rowId) => /^\d+$/.test(rowId))
    )
  );
  if (rowIds.length === 0) {
    throw new HttpError(400, "至少要選擇一筆可刪除的明細", "BATCH_DELETE_ROW_IDS_REQUIRED");
  }
  return { rowIds };
}

function parseBatchCreatePayload(body: unknown): {
  rows: Array<{ payload: Record<string, unknown>; clientRowKey?: string }>;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "批次新增資料格式錯誤", "BATCH_CREATE_PAYLOAD_INVALID");
  }
  const payload = body as { rows?: unknown };
  if (!Array.isArray(payload.rows)) {
    throw new HttpError(400, "缺少 rows", "BATCH_CREATE_ROWS_REQUIRED");
  }
  // 支援兩種 shape：
  //   A) legacy: [{ field1, field2, ... }] → 仍可解析 payload，但會因缺 clientRowKey 被拒絕
  //   B) new:    [{ payload: {...}, clientRowKey: "..." }]
  const normalized: Array<{ payload: Record<string, unknown>; clientRowKey?: string }> = [];
  for (const raw of payload.rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rawRecord = raw as Record<string, unknown>;
    const maybePayload = rawRecord.payload;
    if (
      maybePayload &&
      typeof maybePayload === "object" &&
      !Array.isArray(maybePayload)
    ) {
      const clientRowKey =
        typeof rawRecord.clientRowKey === "string" && rawRecord.clientRowKey.trim().length > 0
          ? rawRecord.clientRowKey.trim()
          : undefined;
      if (!clientRowKey) {
        throw new HttpError(
          400,
          "批次新增每列都必須提供 clientRowKey",
          "BATCH_CREATE_ROW_KEY_REQUIRED"
        );
      }
      normalized.push({ payload: { ...(maybePayload as Record<string, unknown>) }, clientRowKey });
    } else {
      throw new HttpError(
        400,
        "批次新增每列都必須使用 { payload, clientRowKey } 格式",
        "BATCH_CREATE_ROW_KEY_REQUIRED"
      );
    }
  }
  if (normalized.length === 0) {
    throw new HttpError(400, "至少要送出一筆可建立的明細", "BATCH_CREATE_ROWS_REQUIRED");
  }
  return { rows: normalized };
}

export function registerWorkReportSyncRoutes(router: Router, deps: WorkReportRouterDeps): void {
  router.post(
    "/:formId/sync",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      assertReadableFormId(formId);
      const useAsync = parseAsyncFlag(req.query as Record<string, unknown>);
      const triggeredBy = String(req.header("x-sync-triggered-by") ?? "manual").trim() || "manual";
      const actor = readTaskActorContext(req);

      const task = await deps.requestSync(formId, {
        triggeredBy,
        waitForCompletion: !useAsync,
        actorClientId: actor.actorClientId ?? undefined,
        actorTabId: actor.actorTabId ?? undefined,
        actorIp: actor.actorIp ?? undefined,
        actorLabel: actor.actorLabel ?? undefined,
      });

      res.status(useAsync ? 202 : 200).json({
        data: task,
        meta: {
          formId,
          accepted: task.accepted,
          async: useAsync,
        },
      });
    })
  );

  router.get(
    "/:formId/sync/status",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      assertReadableFormId(formId);

      const data = await deps.getSyncStatus(formId);
      res.json({
        data,
        meta: { formId },
      });
    })
  );
}

export function registerWorkReportReadRoutes(router: Router, deps: WorkReportRouterDeps): void {
  router.get(
    "/:formId/reports",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      assertReadableFormId(formId);

      const query = parseReportsQuery(req.query as Record<string, unknown>);
      const result = await deps.getReports(formId, query);

      res.json({
        data: result.data,
        meta: {
          formId,
          count: result.count,
          totalCount: result.totalCount,
          hasMore: result.hasMore,
          limit: query.limit,
          offset: query.offset,
          keyword: query.keyword ?? "",
          workOrderKeyword: query.workOrderKeyword ?? "",
          customerPartKeyword: query.customerPartKeyword ?? "",
          status: query.status ?? "",
          ragicUnfinishedStatus: query.ragicUnfinishedStatus ?? "",
          machineCode: query.machineCode ?? "",
          filterMachineCode: query.filterMachineCode ?? "",
          siteRunning: query.siteRunning ?? "all",
          startSchedule: query.startSchedule ?? "all",
          updatedDateFrom: query.updatedDateFrom ?? "",
          updatedDateTo: query.updatedDateTo ?? "",
          sort: (query.sortRules ?? []).map((rule) => `${rule.key}:${rule.direction}`).join(","),
          refresh: query.refresh,
        },
      });
    })
  );

  router.get(
    "/:formId/reports/full",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      assertReadableFormId(formId);
      const refresh = parseRefreshFlag(req.query as Record<string, unknown>);

      const result = await deps.getFullReports(formId, { refresh });
      res.json({
        data: result.data,
        meta: result.meta,
      });
    })
  );

  router.get(
    "/:formId/reports/facets",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      assertReadableFormId(formId);

      const fields = parseRequestedFields(req.query as Record<string, unknown>) ?? [];
      const query = parseReportsQuery(req.query as Record<string, unknown>);
      const data = await deps.getReportFacets(formId, fields, query);

      res.json({
        data,
        meta: { formId, fields },
      });
    })
  );

  router.get(
    "/:formId/reports/analysis",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      assertReadableFormId(formId);

      const reportsQuery = parseReportsQuery(req.query as Record<string, unknown>);
      const analysisQuery = parseAnalysisQuery(req.query as Record<string, unknown>);
      const data = await deps.getReportAnalysis(formId, {
        ...reportsQuery,
        ...analysisQuery,
      });

      res.json({
        data,
        meta: {
          formId,
          field: analysisQuery.field,
          columnType: analysisQuery.columnType,
        },
      });
    })
  );

  router.get(
    "/:formId/options",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      assertReadableFormId(formId);

      const fields = parseRequestedFields(req.query as Record<string, unknown>);
      const data = await deps.getFormOptions(formId, fields);
      res.json({
        data,
        meta: {
          formId,
          fields: Object.keys(data),
        },
      });
    })
  );

  router.get(
    "/:formId/raw",
    asyncHandler(async (req, res) => {
      if (env.NODE_ENV === "production") {
        throw new HttpError(403, "正式環境不開放 raw 預覽端點", "RAW_ENDPOINT_DISABLED");
      }

      const formId = req.params.formId;
      assertReadableFormId(formId);

      const limit = parseRawLimit(req.query as Record<string, unknown>);
      const data = await deps.getRawPreview(formId, limit);
      res.json({ data, meta: { formId, count: data.length } });
    })
  );

  router.get(
    "/:formId/reports/:entryId",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      const entryId = req.params.entryId;
      assertReadableFormId(formId);
      assertRequiredPathValue(entryId, "entryId");
      const refresh = parseRefreshFlag(req.query as Record<string, unknown>);
      const strictRefresh = parseStrictRefreshFlag(req.query as Record<string, unknown>);

      const data = await deps.getReportByEntryId(formId, entryId, {
        refresh,
        allowSqliteFallbackOnRefresh: refresh && !strictRefresh,
        ...(strictRefresh
          ? {
              ragicReadTimeoutMs: Math.min(env.RAGIC_MUTATION_READ_TIMEOUT_MS, 10_000),
              ragicReadMaxRetries: 1,
            }
          : { ragicReadMaxRetries: 0 }),
        persistRefreshToSqlite: refresh,
      });
      res.json({ data });
    })
  );

  router.get(
    "/:formId/tasks",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      assertReadableFormId(formId);

      const status = String(req.query.status ?? "").trim() || undefined;
      const taskType = String(req.query.taskType ?? "").trim() || undefined;
      const taskTypesRaw = String(req.query.taskTypes ?? "").trim();
      const entryId = String(req.query.entryId ?? "").trim() || undefined;
      const actorClientId = String(req.query.actorClientId ?? "").trim() || undefined;
      const rawLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.trunc(rawLimit))) : 50;

      const allowedStatuses: WorkReportQueueTaskStatus[] = ["pending", "running", "success", "failed"];
      const allowedTaskTypes: WorkReportQueueTaskType[] = [
        "create-report",
        "create-report-batch",
        "update-report",
        "delete-report",
        "delete-report-batch",
        "sync",
        "callback-refresh",
      ];

      if (status && !allowedStatuses.includes(status as WorkReportQueueTaskStatus)) {
        throw new HttpError(400, `不支援的任務狀態：${status}`, "TASK_STATUS_INVALID");
      }
      if (taskType && !allowedTaskTypes.includes(taskType as WorkReportQueueTaskType)) {
        throw new HttpError(400, `不支援的任務類型：${taskType}`, "TASK_TYPE_INVALID");
      }

      const taskTypes = taskTypesRaw
        ? Array.from(
            new Set(
              taskTypesRaw
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            )
          )
        : [];
      for (const value of taskTypes) {
        if (!allowedTaskTypes.includes(value as WorkReportQueueTaskType)) {
          throw new HttpError(400, `不支援的任務類型：${value}`, "TASK_TYPE_INVALID");
        }
      }

      const tasks = deps.listTasks({
        formId,
        entryId,
        status: status as WorkReportQueueTaskStatus | undefined,
        taskType: taskType as WorkReportQueueTaskType | undefined,
        taskTypes: taskTypes.length > 0 ? (taskTypes as WorkReportQueueTaskType[]) : undefined,
        actorClientId,
        limit,
      });

      res.json({
        data: tasks,
        meta: {
          formId,
          count: tasks.length,
          entryId: entryId ?? null,
          status: status ?? null,
          taskType: taskType ?? null,
          taskTypes: taskTypes.length > 0 ? taskTypes : null,
          actorClientId: actorClientId ?? null,
          limit,
        },
      });
    })
  );

  router.get(
    "/:formId/tasks/:taskId",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      const taskId = req.params.taskId;
      assertReadableFormId(formId);
      assertRequiredPathValue(taskId, "taskId");

      const task = deps.getTaskRecord(taskId);
      if (!task || task.formId !== formId) {
        throw new HttpError(404, `找不到任務：${taskId}`, "TASK_NOT_FOUND");
      }

      res.json({
        data: task,
        meta: { formId, taskId },
      });
    })
  );
}

export function registerWorkReportCallbackAndPresenceRoutes(
  router: Router,
  deps: WorkReportRouterDeps
): void {
  router.post(
    "/:formId/ragic-callback",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      assertWritableFormId(formId);
      assertRagicCallbackToken(req.header("x-ragic-callback-token"));
      const payload = parseRagicCallbackPayload(req.body);
      const actor = readTaskActorContext(req);

      const task = await deps.requestRagicCallbackRefresh({
        formId,
        entryId: payload.entryId,
        eventType: payload.eventType,
        ...(payload.rowId ? { rowId: payload.rowId } : {}),
        // source 給事件來源、actorLabel 給真正裝置名；不再用 payload.source 冒充 actorLabel
        ...(payload.source ? { source: payload.source } : {}),
        ...(actor.actorIp ? { actorIp: actor.actorIp } : {}),
        ...(actor.actorLabel ? { actorLabel: actor.actorLabel } : {}),
      });

      res.status(202).json({
        data: {
          accepted: true,
          formId,
          entryId: payload.entryId,
          eventType: payload.eventType,
          taskId: task.taskId,
          status: task.status,
          createdAt: task.createdAt,
        },
      });
    })
  );

  router.put(
    "/:formId/reports/:entryId/editing-presence",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      const entryId = req.params.entryId;
      assertReadableFormId(formId);
      assertRequiredPathValue(entryId, "entryId");

      const payload = parseEditingPresencePayload(req.body);
      const result = await deps.upsertEditingPresence({
        formId,
        entryId,
        rowId: payload.rowId,
        sessionId: payload.sessionId,
        active: payload.active,
        state: payload.state,
      });

      res.json({
        data: result,
        meta: { formId, entryId },
      });
    })
  );

  router.get(
    "/:formId/reports/:entryId/editing-presence",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      const entryId = req.params.entryId;
      assertReadableFormId(formId);
      assertRequiredPathValue(entryId, "entryId");

      const result = await deps.getEditingPresenceSnapshot({
        formId,
        entryId,
        rowId: String(req.query.rowId ?? "").trim() || undefined,
        sessionId: String(req.query.sessionId ?? "").trim() || undefined,
      });

      res.json({
        data: result,
        meta: { formId, entryId },
      });
    })
  );
}

export function registerWorkReportMutationRoutes(router: Router, deps: WorkReportRouterDeps): void {
  router.post(
    "/:formId/reports/:entryId",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const payload = req.body as Record<string, unknown>;
      const useAsync = parseAsyncFlag(req.query as Record<string, unknown>);

      const { formId, entryId, editSessionId, editLockVersion, expectedEntryLastUpdatedAt } = ctx;
      const createIdempotencyKey = ctx.createIdempotencyKey ?? ctx.clientMutationId;
      const createOptions = {
        expectedEntryLastUpdatedAt,
        editSessionId,
        editLockVersion,
        // clientMutationId 只識別本次 task attempt；createIdempotencyKey 才跨 retry 防重複寫入。
        ...(ctx.clientMutationId ? { clientMutationId: ctx.clientMutationId } : {}),
        ...(createIdempotencyKey ? { createIdempotencyKey } : {}),
        ...(createIdempotencyKey
          ? {
              clientMutationFingerprint: createStableJsonFingerprint({
                operation: "create-report",
                formId,
                entryId,
                payload,
              }),
            }
          : {}),
      };

      if (!useAsync) {
        const result = await runRequestEntryMutationExclusive({
          deps,
          ctx,
          req,
          res,
          worker: async () => {
            await assertLocalMutationPreconditions(deps, ctx);
            const createdReport = await deps.createReport(formId, entryId, payload, createOptions);
            await runPostMutationHooks(deps, formId, entryId, "create");
            return createdReport;
          },
        });
        res.status(201).json({
          data: result,
          meta: { formId, entryId },
        });
        return;
      }

      await assertLocalMutationPreconditions(deps, ctx);
      if (!ctx.clientMutationId) {
        throw new HttpError(
          400,
          "背景新增必須提供 x-client-mutation-id，才能安全處理重試與服務重啟。",
          "CLIENT_MUTATION_ID_REQUIRED"
        );
      }
      const task = deps.enqueueCreateTask({
        taskType: "create-report",
        formId,
        entryId,
        workOrderNo: ctx.actor.workOrderNo ?? undefined,
        queueKey: `${formId}:${entryId}`,
        clientMutationId: ctx.clientMutationId,
        operationFingerprint: createStableJsonFingerprint({
          operation: "create-report",
          formId,
          entryId,
          payload,
        }),
        actorClientId: ctx.actor.actorClientId ?? undefined,
        actorTabId: ctx.actor.actorTabId ?? undefined,
        actorIp: ctx.actor.actorIp ?? undefined,
        actorLabel: ctx.actor.actorLabel ?? undefined,
        worker: async () => {
          await assertLocalMutationPreconditions(deps, ctx);
          const result = await deps.createReport(formId, entryId, payload, {
            ...createOptions,
            expectedEntryLastUpdatedAt: undefined,
            skipEntryPreflight: true,
            loadPreconditionEntrySnapshot: () =>
              assertCreateEntryAcceptsReportsWithRetry(deps, formId, entryId),
          });
          await runPostMutationHooks(deps, formId, entryId, "create");
          return result;
        },
      });

      res.status(202).json({
        data: {
          taskId: task.taskId,
          status: task.status,
          createdAt: task.createdAt,
          lifecycleState: task.lifecycleState ?? "accepted",
          acceptedAt: task.acceptedAt ?? task.createdAt,
          confirmedAt: task.confirmedAt ?? null,
          ...(task.result?.rowId ? { rowId: task.result.rowId } : {}),
        },
        meta: {
          formId,
          entryId,
          accepted: true,
          preconditionCheck: "skipped",
        },
      });
    })
  );

  router.post(
    "/:formId/reports/:entryId/batch-create",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const payload = parseBatchCreatePayload(req.body);
      await assertLocalMutationPreconditions(deps, ctx);
      const routePrecheck = "skipped";

      const task = await deps.requestBatchCreate({
        formId: ctx.formId,
        entryId: ctx.entryId,
        workOrderNo: ctx.actor.workOrderNo ?? undefined,
        rows: payload.rows,
        expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
        editSessionId: ctx.editSessionId,
        editLockVersion: ctx.editLockVersion,
        actorClientId: ctx.actor.actorClientId ?? undefined,
        actorTabId: ctx.actor.actorTabId ?? undefined,
        actorIp: ctx.actor.actorIp ?? undefined,
        actorLabel: ctx.actor.actorLabel ?? undefined,
      });

      res.status(202).json({
        data: {
          ...task,
          lifecycleState: "accepted",
          acceptedAt: task.createdAt,
          confirmedAt: null,
        },
        meta: {
          formId: ctx.formId,
          entryId: ctx.entryId,
          accepted: true,
          requestedCount: task.requestedCount ?? payload.rows.length,
          preconditionCheck: routePrecheck,
        },
      });
    })
  );

  router.post(
    "/:formId/reports/:entryId/batch-create/:taskId/retry-finalize",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const taskId = req.params.taskId;
      assertRequiredPathValue(taskId, "taskId");

      const task = await deps.requestBatchCreateFinalizeRetry({
        formId: ctx.formId,
        entryId: ctx.entryId,
        taskId,
        actorClientId: ctx.actor.actorClientId ?? undefined,
        actorTabId: ctx.actor.actorTabId ?? undefined,
        actorIp: ctx.actor.actorIp ?? undefined,
        actorLabel: ctx.actor.actorLabel ?? undefined,
      });

      res.status(202).json({
        data: {
          ...task,
          lifecycleState: "accepted",
          acceptedAt: task.createdAt,
          confirmedAt: null,
        },
        meta: {
          formId: ctx.formId,
          entryId: ctx.entryId,
          accepted: true,
          retryMode: "finalize-only",
        },
      });
    })
  );

  router.get(
    "/:formId/reports/tasks/:taskId",
    asyncHandler(async (req, res) => {
      const formId = req.params.formId;
      const taskId = req.params.taskId;
      assertWritableFormId(formId);
      assertRequiredPathValue(taskId, "taskId");

      const localTask = deps.getCreateTask(taskId);
      const registryTask = deps.getTaskRecord(taskId);
      const task = selectCreateTaskRouteResponse(
        localTask?.formId === formId ? localTask : null,
        registryTask?.formId === formId ? registryTask : null
      );
      if (!task) {
        throw new HttpError(404, `找不到任務：${taskId}`, "TASK_NOT_FOUND");
      }

      res.json({
        data: task,
        meta: { formId, taskId },
      });
    })
  );

  router.put(
    "/:formId/reports/:entryId/sort-order",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const payload = parseSortOrderUpdatePayload(req.body);
      await assertLocalMutationPreconditions(deps, ctx);
      if (!ctx.clientMutationId) {
        throw new HttpError(
          400,
          "排序更新必須提供 x-client-mutation-id，才能安全處理重試與服務重啟。",
          "CLIENT_MUTATION_ID_REQUIRED"
        );
      }
      const routePrecheck = "skipped";

      const task = deps.enqueueCreateTask({
        taskType: "update-report",
        formId: ctx.formId,
        entryId: ctx.entryId,
        workOrderNo: ctx.actor.workOrderNo ?? undefined,
        queueKey: `${ctx.formId}:${ctx.entryId}`,
        clientMutationId: ctx.clientMutationId,
        operationKind: "update-sort-order",
        operationFingerprint: createStableJsonFingerprint({
          operation: "update-sort-order",
          formId: ctx.formId,
          entryId: ctx.entryId,
          payload,
        }),
        actorClientId: ctx.actor.actorClientId ?? undefined,
        actorTabId: ctx.actor.actorTabId ?? undefined,
        actorIp: ctx.actor.actorIp ?? undefined,
        actorLabel: ctx.actor.actorLabel ?? undefined,
        worker: async () => {
          await assertLocalMutationPreconditions(deps, ctx);
          const result = await deps.updateSortOrder(
            ctx.formId,
            ctx.entryId,
            payload.sortOrder,
            {
              expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
              editSessionId: ctx.editSessionId,
              editLockVersion: ctx.editLockVersion,
            }
          );
          if (result.changed) {
            void safeInsertRecordAudit({
              scope: "work-report",
              formId: ctx.formId,
              entryId: ctx.entryId,
              action: "update",
              actorClientId: ctx.actor.actorClientId,
              actorTabId: ctx.actor.actorTabId,
              actorIp: ctx.actor.actorIp,
              actorLabel: ctx.actor.actorLabel,
              taskId: task.taskId,
              beforeSnapshot: { sortOrder: result.previousSortOrder },
              afterPatch: { sortOrder: result.sortOrder },
            });
          }
          await runPostSortOrderMutationHooks(
            deps,
            ctx.formId,
            ctx.entryId,
            result.sortOrder
          );
          return result;
        },
      });

      res.status(202).json({
        data: {
          taskId: task.taskId,
          status: task.status,
          createdAt: task.createdAt,
          lifecycleState: task.lifecycleState ?? "accepted",
          acceptedAt: task.acceptedAt ?? task.createdAt,
          confirmedAt: task.confirmedAt ?? null,
        },
        meta: {
          formId: ctx.formId,
          entryId: ctx.entryId,
          accepted: true,
          preconditionCheck: routePrecheck,
        },
      });
    })
  );

  router.put(
    "/:formId/reports/:entryId/main-machine",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const payload = parseMainMachineUpdatePayload(req.body);
      const useAsync = parseAsyncFlag(req.query as Record<string, unknown>);

      if (useAsync) {
        await assertLocalMutationPreconditions(deps, ctx);
        if (!ctx.clientMutationId) {
          throw new HttpError(
            400,
            "背景更新主表機台必須提供 x-client-mutation-id，才能安全處理重試與服務重啟。",
            "CLIENT_MUTATION_ID_REQUIRED"
          );
        }
        const task = deps.enqueueCreateTask({
          taskType: "update-report",
          operationKind: "update-main-machine",
          formId: ctx.formId,
          entryId: ctx.entryId,
          workOrderNo: ctx.actor.workOrderNo ?? undefined,
          queueKey: `${ctx.formId}:${ctx.entryId}`,
          clientMutationId: ctx.clientMutationId,
          operationFingerprint: createStableJsonFingerprint({
            operation: "update-main-machine",
            formId: ctx.formId,
            entryId: ctx.entryId,
            payload,
          }),
          actorClientId: ctx.actor.actorClientId ?? undefined,
          actorTabId: ctx.actor.actorTabId ?? undefined,
          actorIp: ctx.actor.actorIp ?? undefined,
          actorLabel: ctx.actor.actorLabel ?? undefined,
          worker: async () => {
            await assertLocalMutationPreconditions(deps, ctx);
            const result = await deps.updateMainMachine(
              ctx.formId,
              ctx.entryId,
              payload.machineCode,
              {
                expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
                editSessionId: ctx.editSessionId,
                editLockVersion: ctx.editLockVersion,
              }
            );
            await runPostMutationHooks(deps, ctx.formId, ctx.entryId, "update");
            return result;
          },
        });

        res.status(202).json({
          data: {
            taskId: task.taskId,
            status: task.status,
            createdAt: task.createdAt,
            lifecycleState: task.lifecycleState ?? "accepted",
            acceptedAt: task.acceptedAt ?? task.createdAt,
            confirmedAt: task.confirmedAt ?? null,
          },
          meta: {
            formId: ctx.formId,
            entryId: ctx.entryId,
            accepted: true,
            preconditionCheck: ctx.expectedEntryLastUpdatedAt ? "deferred" : "skipped",
          },
        });
        return;
      }

      const result = await runRequestEntryMutationExclusive({
        deps,
        ctx,
        req,
        res,
        worker: async () => {
          await assertLocalMutationPreconditions(deps, ctx);
          const updatedMachine = await deps.updateMainMachine(
            ctx.formId,
            ctx.entryId,
            payload.machineCode,
            {
              expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
              editSessionId: ctx.editSessionId,
              editLockVersion: ctx.editLockVersion,
            }
          );
          await runPostMutationHooks(deps, ctx.formId, ctx.entryId, "update");
          return updatedMachine;
        },
      });

      res.json({
        data: result,
        meta: { formId: ctx.formId, entryId: ctx.entryId },
      });
    })
  );

  router.post(
    "/:formId/reports/:entryId/close",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const useAsync = parseAsyncFlag(req.query as Record<string, unknown>);

      if (useAsync) {
        await assertLocalMutationPreconditions(deps, ctx);
        if (!ctx.clientMutationId) {
          throw new HttpError(
            400,
            "背景人工結案必須提供 x-client-mutation-id，才能安全處理重試與服務重啟。",
            "CLIENT_MUTATION_ID_REQUIRED"
          );
        }
        const task = deps.enqueueCreateTask({
          taskType: "update-report",
          operationKind: "close-work-order",
          formId: ctx.formId,
          entryId: ctx.entryId,
          workOrderNo: ctx.actor.workOrderNo ?? undefined,
          queueKey: `${ctx.formId}:${ctx.entryId}`,
          clientMutationId: ctx.clientMutationId,
          operationFingerprint: createStableJsonFingerprint({
            operation: "close-work-order",
            formId: ctx.formId,
            entryId: ctx.entryId,
          }),
          actorClientId: ctx.actor.actorClientId ?? undefined,
          actorTabId: ctx.actor.actorTabId ?? undefined,
          actorIp: ctx.actor.actorIp ?? undefined,
          actorLabel: ctx.actor.actorLabel ?? undefined,
          worker: async () => {
            await assertFullMutationPreconditions(deps, ctx);
            const result = await deps.manualCloseWorkOrder(
              ctx.formId,
              ctx.entryId,
              "close",
              {
                expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
                editSessionId: ctx.editSessionId,
                editLockVersion: ctx.editLockVersion,
              }
            );
            await runPostMutationHooks(deps, ctx.formId, ctx.entryId, "update");
            return result;
          },
        });

        res.status(202).json({
          data: {
            taskId: task.taskId,
            status: task.status,
            createdAt: task.createdAt,
            lifecycleState: task.lifecycleState ?? "accepted",
            acceptedAt: task.acceptedAt ?? task.createdAt,
            confirmedAt: task.confirmedAt ?? null,
          },
          meta: {
            formId: ctx.formId,
            entryId: ctx.entryId,
            accepted: true,
            preconditionCheck: ctx.expectedEntryLastUpdatedAt ? "deferred" : "skipped",
          },
        });
        return;
      }

      const result = await runRequestEntryMutationExclusive({
        deps,
        ctx,
        req,
        res,
        worker: async () => {
          await assertFullMutationPreconditions(deps, ctx);
          const closedWorkOrder = await deps.manualCloseWorkOrder(
            ctx.formId,
            ctx.entryId,
            "close",
            {
              expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
              editSessionId: ctx.editSessionId,
              editLockVersion: ctx.editLockVersion,
            }
          );
          await runPostMutationHooks(deps, ctx.formId, ctx.entryId, "update");
          return closedWorkOrder;
        },
      });

      res.json({ data: result, meta: { formId: ctx.formId, entryId: ctx.entryId } });
    })
  );

  router.post(
    "/:formId/reports/:entryId/reopen",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const useAsync = parseAsyncFlag(req.query as Record<string, unknown>);

      if (useAsync) {
        await assertLocalMutationPreconditions(deps, ctx);
        if (!ctx.clientMutationId) {
          throw new HttpError(
            400,
            "背景重新開啟工令必須提供 x-client-mutation-id，才能安全處理重試與服務重啟。",
            "CLIENT_MUTATION_ID_REQUIRED"
          );
        }
        const task = deps.enqueueCreateTask({
          taskType: "update-report",
          operationKind: "reopen-work-order",
          formId: ctx.formId,
          entryId: ctx.entryId,
          workOrderNo: ctx.actor.workOrderNo ?? undefined,
          queueKey: `${ctx.formId}:${ctx.entryId}`,
          clientMutationId: ctx.clientMutationId,
          operationFingerprint: createStableJsonFingerprint({
            operation: "reopen-work-order",
            formId: ctx.formId,
            entryId: ctx.entryId,
          }),
          actorClientId: ctx.actor.actorClientId ?? undefined,
          actorTabId: ctx.actor.actorTabId ?? undefined,
          actorIp: ctx.actor.actorIp ?? undefined,
          actorLabel: ctx.actor.actorLabel ?? undefined,
          worker: async () => {
            await assertFullMutationPreconditions(deps, ctx);
            const result = await deps.manualCloseWorkOrder(
              ctx.formId,
              ctx.entryId,
              "reopen",
              {
                expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
                editSessionId: ctx.editSessionId,
                editLockVersion: ctx.editLockVersion,
              }
            );
            await runPostMutationHooks(deps, ctx.formId, ctx.entryId, "update");
            return result;
          },
        });

        res.status(202).json({
          data: {
            taskId: task.taskId,
            status: task.status,
            createdAt: task.createdAt,
            lifecycleState: task.lifecycleState ?? "accepted",
            acceptedAt: task.acceptedAt ?? task.createdAt,
            confirmedAt: task.confirmedAt ?? null,
          },
          meta: {
            formId: ctx.formId,
            entryId: ctx.entryId,
            accepted: true,
            preconditionCheck: ctx.expectedEntryLastUpdatedAt ? "deferred" : "skipped",
          },
        });
        return;
      }

      const result = await runRequestEntryMutationExclusive({
        deps,
        ctx,
        req,
        res,
        worker: async () => {
          await assertFullMutationPreconditions(deps, ctx);
          const reopenedWorkOrder = await deps.manualCloseWorkOrder(
            ctx.formId,
            ctx.entryId,
            "reopen",
            {
              expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
              editSessionId: ctx.editSessionId,
              editLockVersion: ctx.editLockVersion,
            }
          );
          await runPostMutationHooks(deps, ctx.formId, ctx.entryId, "update");
          return reopenedWorkOrder;
        },
      });

      res.json({ data: result, meta: { formId: ctx.formId, entryId: ctx.entryId } });
    })
  );

  router.put(
    "/:formId/reports/:entryId/:rowId",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req, { includeRowId: true });
      const payload = req.body as Record<string, unknown>;
      const useAsync = parseAsyncFlag(req.query as Record<string, unknown>);

      const { formId, entryId, rowId, editSessionId, editLockVersion, expectedEntryLastUpdatedAt } = ctx;
      const updateOptions = {
        expectedEntryLastUpdatedAt,
        editSessionId,
        editLockVersion,
      };

      if (useAsync) {
        await assertLocalMutationPreconditions(deps, ctx);
        if (!ctx.clientMutationId) {
          throw new HttpError(
            400,
            "背景更新必須提供 x-client-mutation-id，才能安全處理重試與服務重啟。",
            "CLIENT_MUTATION_ID_REQUIRED"
          );
        }
        const routePrecheck = ctx.expectedEntryLastUpdatedAt ? "deferred" : "skipped";

        const task = deps.enqueueCreateTask({
          taskType: "update-report",
          formId,
          entryId,
          workOrderNo: ctx.actor.workOrderNo ?? undefined,
          queueKey: `${formId}:${entryId}`,
          clientMutationId: ctx.clientMutationId,
          operationFingerprint: createStableJsonFingerprint({
            operation: "update-report",
            formId,
            entryId,
            rowId,
            payload,
          }),
          actorClientId: ctx.actor.actorClientId ?? undefined,
          actorTabId: ctx.actor.actorTabId ?? undefined,
          actorIp: ctx.actor.actorIp ?? undefined,
          actorLabel: ctx.actor.actorLabel ?? undefined,
          worker: async () => {
            await assertLocalMutationPreconditions(deps, ctx);
            const beforeSnapshot = await readWorkReportRowSnapshot(formId, entryId, rowId!);
            const result = await deps.updateReport(formId, entryId, rowId!, payload, updateOptions);
            // audit 放在 Ragic 寫入成功之後、projection hook 之前；
            // 若 updateReport 拋錯 / worker 整個 fail，這筆 audit 不會被寫出來，避免「假的更新紀錄」
            void safeInsertRecordAudit({
              scope: "work-report",
              formId,
              entryId,
              rowId: rowId!,
              action: "update",
              actorClientId: ctx.actor.actorClientId,
              actorTabId: ctx.actor.actorTabId,
              actorIp: ctx.actor.actorIp,
              actorLabel: ctx.actor.actorLabel,
              taskId: task.taskId,
              beforeSnapshot,
              afterPatch: payload,
            });
            await runPostMutationHooks(deps, formId, entryId, "update");
            return result;
          },
        });

        res.status(202).json({
          data: {
            taskId: task.taskId,
            status: task.status,
            createdAt: task.createdAt,
            lifecycleState: task.lifecycleState ?? "accepted",
            acceptedAt: task.acceptedAt ?? task.createdAt,
            confirmedAt: task.confirmedAt ?? null,
            ...(task.result?.rowId ? { rowId: task.result.rowId } : {}),
          },
          meta: {
            formId,
            entryId,
            rowId,
            accepted: true,
            preconditionCheck: routePrecheck,
          },
        });
        return;
      }

      const result = await runRequestEntryMutationExclusive({
        deps,
        ctx,
        req,
        res,
        worker: async () => {
          await assertLocalMutationPreconditions(deps, ctx);
          const beforeSnapshot = await readWorkReportRowSnapshot(formId, entryId, rowId!);
          const updatedReport = await deps.updateReport(
            formId,
            entryId,
            rowId!,
            payload,
            updateOptions
          );
          // sync branch 沒 taskId；可用 clientId + occurredAt 追查該次操作。
          void safeInsertRecordAudit({
            scope: "work-report",
            formId,
            entryId,
            rowId: rowId!,
            action: "update",
            actorClientId: ctx.actor.actorClientId,
            actorTabId: ctx.actor.actorTabId,
            actorIp: ctx.actor.actorIp,
            actorLabel: ctx.actor.actorLabel,
            beforeSnapshot,
            afterPatch: payload,
          });
          await runPostMutationHooks(deps, formId, entryId, "update");
          return updatedReport;
        },
      });

      res.json({
        data: result,
        meta: { formId, entryId, rowId },
      });
    })
  );

  router.delete(
    "/:formId/reports/:entryId/:rowId",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req, { includeRowId: true });
      await assertLocalMutationPreconditions(deps, ctx);
      const routePrecheck = ctx.expectedEntryLastUpdatedAt ? "deferred" : "skipped";

      const task = await deps.requestBatchDelete({
        taskType: "delete-report",
        formId: ctx.formId,
        entryId: ctx.entryId,
        workOrderNo: ctx.actor.workOrderNo ?? undefined,
        rowIds: [ctx.rowId!],
        expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
        editSessionId: ctx.editSessionId,
        editLockVersion: ctx.editLockVersion,
        actorClientId: ctx.actor.actorClientId ?? undefined,
        actorTabId: ctx.actor.actorTabId ?? undefined,
        actorIp: ctx.actor.actorIp ?? undefined,
        actorLabel: ctx.actor.actorLabel ?? undefined,
        onRowDeleted: (rowId, taskId, beforeSnapshot) => {
          void safeInsertRecordAudit({
            scope: "work-report",
            formId: ctx.formId,
            entryId: ctx.entryId,
            rowId,
            action: "delete",
            actorClientId: ctx.actor.actorClientId,
            actorTabId: ctx.actor.actorTabId,
            actorIp: ctx.actor.actorIp,
            actorLabel: ctx.actor.actorLabel,
            taskId,
            beforeSnapshot,
          });
        },
      });

      res.status(202).json({
        data: {
          ...task,
          lifecycleState: "accepted",
          acceptedAt: task.createdAt,
          confirmedAt: null,
        },
        meta: {
          formId: ctx.formId,
          entryId: ctx.entryId,
          rowId: ctx.rowId,
          accepted: true,
          requestedCount: task.requestedCount ?? 1,
          preconditionCheck: routePrecheck,
        },
      });
    })
  );

  router.post(
    "/:formId/reports/:entryId/batch-delete",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const payload = parseBatchDeletePayload(req.body);
      await assertLocalMutationPreconditions(deps, ctx);
      const routePrecheck = ctx.expectedEntryLastUpdatedAt ? "deferred" : "skipped";

      const task = await deps.requestBatchDelete({
        formId: ctx.formId,
        entryId: ctx.entryId,
        workOrderNo: ctx.actor.workOrderNo ?? undefined,
        rowIds: payload.rowIds,
        expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
        editSessionId: ctx.editSessionId,
        editLockVersion: ctx.editLockVersion,
        actorClientId: ctx.actor.actorClientId ?? undefined,
        actorTabId: ctx.actor.actorTabId ?? undefined,
        actorIp: ctx.actor.actorIp ?? undefined,
        actorLabel: ctx.actor.actorLabel ?? undefined,
        onRowDeleted: (rowId, taskId, beforeSnapshot) => {
          void safeInsertRecordAudit({
            scope: "work-report",
            formId: ctx.formId,
            entryId: ctx.entryId,
            rowId,
            action: "delete",
            actorClientId: ctx.actor.actorClientId,
            actorTabId: ctx.actor.actorTabId,
            actorIp: ctx.actor.actorIp,
            actorLabel: ctx.actor.actorLabel,
            taskId,
            beforeSnapshot,
          });
        },
      });

      res.status(202).json({
        data: {
          ...task,
          lifecycleState: "accepted",
          acceptedAt: task.createdAt,
          confirmedAt: null,
        },
        meta: {
          formId: ctx.formId,
          entryId: ctx.entryId,
          accepted: true,
          requestedCount: payload.rowIds.length,
          preconditionCheck: routePrecheck,
        },
      });
    })
  );
}
