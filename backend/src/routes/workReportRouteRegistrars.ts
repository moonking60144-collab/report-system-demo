import type { Router } from "express";
import { env } from "../config/env";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import type {
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
  parseRagicCallbackPayload,
  parseRawLimit,
  parseRefreshFlag,
  parseReportsQuery,
  parseRequestedFields,
} from "./workReportRequest";
import {
  assertFullMutationPreconditions,
  parseMutationRequestContext,
  readTaskActorContext,
  runPostMutationHooks,
} from "./workReportMutationRouteHelpers";
import { safeInsertRecordAudit } from "../services/audit/recordAuditLogger";
import { readWorkReportRowSnapshot } from "../services/audit/recordAuditSnapshotResolver";

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
  //   A) legacy: [{ field1, field2, ... }] → 整個 row 當 payload，無 clientRowKey
  //   B) new:    [{ payload: {...}, clientRowKey?: "..." }]
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
      normalized.push({ payload: { ...(maybePayload as Record<string, unknown>) }, clientRowKey });
    } else {
      normalized.push({ payload: { ...rawRecord } });
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

      const data = await deps.getReportByEntryId(formId, entryId, { refresh });
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
      await assertFullMutationPreconditions(deps, ctx);

      const { formId, entryId, editSessionId, editLockVersion, expectedEntryLastUpdatedAt } = ctx;
      const createOptions = {
        expectedEntryLastUpdatedAt,
        editSessionId,
        editLockVersion,
        // 傳 clientMutationId 給 createReport 做 Form 16 寫入的 idempotency
        // （跟 enqueueCreateTask 的 task-level dedup 是不同層保護）
        ...(ctx.clientMutationId ? { clientMutationId: ctx.clientMutationId } : {}),
      };

      if (!useAsync) {
        const result = await deps.createReport(formId, entryId, payload, createOptions);
        await runPostMutationHooks(deps, formId, entryId, "create");
        res.status(201).json({
          data: result,
          meta: { formId, entryId },
        });
        return;
      }

      const task = deps.enqueueCreateTask({
        taskType: "create-report",
        formId,
        entryId,
        workOrderNo: ctx.actor.workOrderNo ?? undefined,
        queueKey: `${formId}:${entryId}`,
        clientMutationId: ctx.clientMutationId,
        actorClientId: ctx.actor.actorClientId ?? undefined,
        actorTabId: ctx.actor.actorTabId ?? undefined,
        actorIp: ctx.actor.actorIp ?? undefined,
        actorLabel: ctx.actor.actorLabel ?? undefined,
        worker: async () => {
          const result = await deps.createReport(formId, entryId, payload, createOptions);
          await runPostMutationHooks(deps, formId, entryId, "create");
          return result;
        },
      });

      res.status(202).json({
        data: {
          taskId: task.taskId,
          status: task.status,
          createdAt: task.createdAt,
          ...(task.result?.rowId ? { rowId: task.result.rowId } : {}),
        },
        meta: {
          formId,
          entryId,
          accepted: true,
        },
      });
    })
  );

  router.post(
    "/:formId/reports/:entryId/batch-create",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const payload = parseBatchCreatePayload(req.body);
      await deps.assertEntryEditableBySession({
        formId: ctx.formId,
        entryId: ctx.entryId,
        editSessionId: ctx.editSessionId,
      });

      const task = await deps.requestBatchCreate({
        formId: ctx.formId,
        entryId: ctx.entryId,
        workOrderNo: ctx.actor.workOrderNo ?? undefined,
        rows: payload.rows,
        actorClientId: ctx.actor.actorClientId ?? undefined,
        actorTabId: ctx.actor.actorTabId ?? undefined,
        actorIp: ctx.actor.actorIp ?? undefined,
        actorLabel: ctx.actor.actorLabel ?? undefined,
      });

      res.status(202).json({
        data: task,
        meta: {
          formId: ctx.formId,
          entryId: ctx.entryId,
          accepted: true,
          requestedCount: task.requestedCount ?? payload.rows.length,
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
        data: task,
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

      const task = deps.getCreateTask(taskId);
      if (!task || task.formId !== formId) {
        throw new HttpError(404, `找不到任務：${taskId}`, "TASK_NOT_FOUND");
      }

      res.json({
        data: task,
        meta: { formId, taskId },
      });
    })
  );

  router.put(
    "/:formId/reports/:entryId/main-machine",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const payload = parseMainMachineUpdatePayload(req.body);
      await assertFullMutationPreconditions(deps, ctx);
      const result = await deps.updateMainMachine(ctx.formId, ctx.entryId, payload.machineCode, {
        expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
        editSessionId: ctx.editSessionId,
        editLockVersion: ctx.editLockVersion,
      });
      await runPostMutationHooks(deps, ctx.formId, ctx.entryId, "update");

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
      await assertFullMutationPreconditions(deps, ctx);
      const result = await deps.manualCloseWorkOrder(ctx.formId, ctx.entryId, "close", {
        expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
        editSessionId: ctx.editSessionId,
        editLockVersion: ctx.editLockVersion,
      });
      // 不等 post-mutation hook 再回 response：projection / SSE 對使用者感知不重要，
      // 背景跑即可，讓使用者儘早看到 close 完成。失敗有 projectSqliteAfterMutationSafe 的 try/catch 擋著。
      runBackgroundTask("post-mutation-hook:close", () =>
        runPostMutationHooks(deps, ctx.formId, ctx.entryId, "update")
      );

      res.json({ data: result, meta: { formId: ctx.formId, entryId: ctx.entryId } });
    })
  );

  router.post(
    "/:formId/reports/:entryId/reopen",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      await assertFullMutationPreconditions(deps, ctx);
      const result = await deps.manualCloseWorkOrder(ctx.formId, ctx.entryId, "reopen", {
        expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
        editSessionId: ctx.editSessionId,
        editLockVersion: ctx.editLockVersion,
      });
      runBackgroundTask("post-mutation-hook:reopen", () =>
        runPostMutationHooks(deps, ctx.formId, ctx.entryId, "update")
      );

      res.json({ data: result, meta: { formId: ctx.formId, entryId: ctx.entryId } });
    })
  );

  router.put(
    "/:formId/reports/:entryId/:rowId",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req, { includeRowId: true });
      const payload = req.body as Record<string, unknown>;
      const useAsync = parseAsyncFlag(req.query as Record<string, unknown>);
      await assertFullMutationPreconditions(deps, ctx);

      const { formId, entryId, rowId, editSessionId, editLockVersion, expectedEntryLastUpdatedAt } = ctx;
      const updateOptions = {
        expectedEntryLastUpdatedAt,
        editSessionId,
        editLockVersion,
      };

      // 在 mutation 之前抓 before snapshot；之後抓會抓到新值
      const beforeSnapshot = await readWorkReportRowSnapshot(formId, entryId, rowId!);

      if (useAsync) {
        const task = deps.enqueueCreateTask({
          taskType: "update-report",
          formId,
          entryId,
          workOrderNo: ctx.actor.workOrderNo ?? undefined,
          queueKey: `${formId}:${entryId}`,
          clientMutationId: ctx.clientMutationId,
          actorClientId: ctx.actor.actorClientId ?? undefined,
          actorTabId: ctx.actor.actorTabId ?? undefined,
          actorIp: ctx.actor.actorIp ?? undefined,
          actorLabel: ctx.actor.actorLabel ?? undefined,
          worker: async () => {
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
            ...(task.result?.rowId ? { rowId: task.result.rowId } : {}),
          },
          meta: {
            formId,
            entryId,
            rowId,
            accepted: true,
          },
        });
        return;
      }

      const result = await deps.updateReport(formId, entryId, rowId!, payload, updateOptions);
      // audit 放在 Ragic 寫入成功之後、projection hook 之前：
      // hook 拋錯（projection/SSE 問題）不會吃掉真正已經成功的操作紀錄。
      // sync branch 沒 taskId 概念（task registry 僅 async branch 才發），audit 的 task_id 為 null；
      // 這是預期的 asymmetry — 要追該次操作可用 clientId + occurredAt 組合
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
      await assertFullMutationPreconditions(deps, ctx);
      const beforeSnapshot = await readWorkReportRowSnapshot(ctx.formId, ctx.entryId, ctx.rowId!);
      const result = await deps.deleteReport(ctx.formId, ctx.entryId, ctx.rowId!, {
        expectedEntryLastUpdatedAt: ctx.expectedEntryLastUpdatedAt,
        editSessionId: ctx.editSessionId,
        editLockVersion: ctx.editLockVersion,
      });
      // audit 搬到 hooks 之前，跟 sync PUT / async worker 的順序一致，避免 hook 失敗吃掉真刪除紀錄
      void safeInsertRecordAudit({
        scope: "work-report",
        formId: ctx.formId,
        entryId: ctx.entryId,
        rowId: ctx.rowId!,
        action: "delete",
        actorClientId: ctx.actor.actorClientId,
        actorTabId: ctx.actor.actorTabId,
        actorIp: ctx.actor.actorIp,
        actorLabel: ctx.actor.actorLabel,
        beforeSnapshot,
      });
      await runPostMutationHooks(deps, ctx.formId, ctx.entryId, "delete");

      res.json({
        data: result,
        meta: { formId: ctx.formId, entryId: ctx.entryId, rowId: ctx.rowId },
      });
    })
  );

  router.post(
    "/:formId/reports/:entryId/batch-delete",
    asyncHandler(async (req, res) => {
      const ctx = parseMutationRequestContext(req);
      const payload = parseBatchDeletePayload(req.body);
      await deps.assertEntryEditableBySession({
        formId: ctx.formId,
        entryId: ctx.entryId,
        editSessionId: ctx.editSessionId,
      });

      // 先把每列的 snapshot 抓起來存 map；實際 Ragic 刪掉那列時才寫 audit
      // 這樣 audit 能精準反映「真的刪成功了哪幾筆」，跟 task registry 的成功列吻合
      const snapshotByRowId = new Map<string, unknown | null>();
      await Promise.all(
        payload.rowIds.map(async (rowId) => {
          snapshotByRowId.set(
            rowId,
            await readWorkReportRowSnapshot(ctx.formId, ctx.entryId, rowId)
          );
        })
      );

      const task = await deps.requestBatchDelete({
        formId: ctx.formId,
        entryId: ctx.entryId,
        workOrderNo: ctx.actor.workOrderNo ?? undefined,
        rowIds: payload.rowIds,
        actorClientId: ctx.actor.actorClientId ?? undefined,
        actorTabId: ctx.actor.actorTabId ?? undefined,
        actorIp: ctx.actor.actorIp ?? undefined,
        actorLabel: ctx.actor.actorLabel ?? undefined,
        onRowDeleted: (rowId, taskId) => {
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
            taskId: taskId ?? null,
            beforeSnapshot: snapshotByRowId.get(rowId) ?? null,
          });
        },
      });

      res.status(202).json({
        data: task,
        meta: {
          formId: ctx.formId,
          entryId: ctx.entryId,
          accepted: true,
          requestedCount: payload.rowIds.length,
        },
      });
    })
  );
}
