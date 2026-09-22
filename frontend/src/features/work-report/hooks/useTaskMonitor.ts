import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { message } from "antd";
import { createTaskEventWakeup } from "../workReportTaskEvents";
import { createEntryFieldSettlementReader, EntryFieldSettlementRetry, settlementReadRequiresManualRetry } from "../entryFieldSettlementRetry";
import { useTranslation } from "react-i18next";
import {
  fetchCreateReportTask,
  fetchWorkReportEntry,
  fetchWorkReportQueueTask,
  type CreateReportTaskResult,
  type WorkReportRecord,
  type WorkReportQueueTask,
} from "../../../api/workReport";
import {
  CREATE_TASK_AUTO_CLEAR_MS,
  CREATE_TASK_POLL_INTERVAL_MS,
  CREATE_TASK_POLL_TIMEOUT_MS,
  CREATE_TASK_STALE_POLL_INTERVAL_MS,
  CREATE_TASK_STALE_AUTO_CLEAR_MS,
  MAX_CREATE_TASK_MONITORS,
  WORK_REPORT_TASK_MONITOR_STORAGE_KEY,
} from "../constants";
import type {
  CreateTaskMonitor,
  WorkReportEntryFieldMutationOperation,
  WorkReportFormId,
} from "../types";
import { getApiErrorCode, getErrorMessage, getWorkReportTaskErrorMessage } from "../utils";
import type { WorkReportMutationTaskKind } from "../types";
import { deleteRetryableMutationRecord } from "../taskRetryStore";
import { normalizeRecord } from "../utils/recordUtils";
import { resolveTaskMutationLifecycleState } from "../mutationLifecycle";
import { deleteRetryableBatchCreateRecordChain } from "../taskBatchRetryStore";
import {
  isStoredWorkReportOptimisticMutation,
  reconcileWorkReportOptimisticMutation,
} from "../workReportOptimisticMutation";
import {
  ENTRY_FIELD_TASK_RETRY_TTL_MS,
  deleteRetryableEntryFieldMutationByClientMutationId,
  deleteRetryableEntryFieldMutationByTaskId,
  getRetryableEntryFieldMutationByClientMutationId,
  getRetryableEntryFieldMutationByTaskId,
  isEntryFieldMutationOperation,
  isEntryFieldMutationSettlementTerminal,
  isRetryableEntryFieldMutationBlocking,
  listRetryableEntryFieldMutations,
  markRetryableEntryFieldMutationSupersededByClientMutationId,
  subscribeEntryFieldTaskRetryStore,
  updateRetryableEntryFieldMutationLifecycleByTaskId,
  type RetryableEntryFieldMutation,
} from "../entryFieldTaskRetryStore";
import {
  type EntryFieldMutationSettlement,
  isEntryFieldConfirmationPending,
  settleEntryFieldMutationWithAuthority,
  shouldSettleEntryFieldMutationTask,
} from "../entryFieldMutationSettlement";

export interface EntryFieldSettlementConsumer {
  getCurrentRecord: (entryId: string) => WorkReportRecord | null | undefined;
  applySettlement?: (input: {
    taskId: string;
    authoritativeRecord: WorkReportRecord;
    expectedPatch?: Partial<WorkReportRecord>;
  }) => void;
}

export async function settleTerminalEntryFieldTask(input: {
  monitor: CreateTaskMonitor;
  consumer?: EntryFieldSettlementConsumer;
  getRetryMutation?: typeof getRetryableEntryFieldMutationByTaskId;
  getRetryMutationByClientMutationId?: typeof getRetryableEntryFieldMutationByClientMutationId;
  fetchEntry?: typeof fetchWorkReportEntry;
  upsertMonitor: (monitor: CreateTaskMonitor) => void;
  deleteRetryMutation?: typeof deleteRetryableEntryFieldMutationByTaskId;
  deleteRetryMutationByClientMutationId?: typeof deleteRetryableEntryFieldMutationByClientMutationId;
  markRetryMutationSupersededByClientMutationId?: typeof markRetryableEntryFieldMutationSupersededByClientMutationId;
  successMessage: string;
  supersededMessage: string;
}): Promise<EntryFieldMutationSettlement | null> {
  if (!shouldSettleEntryFieldMutationTask(input.monitor)) {
    return null;
  }
  const operation =
    input.monitor.entryFieldOperation ??
    input.monitor.optimisticMutation?.lifecycle.operation;
  const clientMutationId =
    input.monitor.entryFieldClientMutationId ??
    input.monitor.optimisticMutation?.lifecycle.mutationId;
  const getRetryMutation =
    input.getRetryMutation ?? getRetryableEntryFieldMutationByTaskId;
  const retryMutationByTaskId = getRetryMutation(input.monitor.taskId);
  const retryMutationByClientMutationId =
    !retryMutationByTaskId &&
    isEntryFieldMutationOperation(operation) &&
    clientMutationId
      ? (
          input.getRetryMutationByClientMutationId ??
          getRetryableEntryFieldMutationByClientMutationId
        )(operation, clientMutationId)
      : null;
  const retryMutation =
    retryMutationByTaskId ??
    (retryMutationByClientMutationId?.taskId === undefined ||
    retryMutationByClientMutationId?.taskId === input.monitor.taskId
      ? retryMutationByClientMutationId
      : null);
  let settlement: EntryFieldMutationSettlement;
  if (retryMutation) {
    settlement = await settleEntryFieldMutationWithAuthority({
      monitor: input.monitor,
      retryMutation,
      currentRecord:
        input.consumer?.getCurrentRecord(retryMutation.entryId) ?? null,
      fetchEntry: input.fetchEntry,
      successMessage: input.successMessage,
      supersededMessage: input.supersededMessage,
    });
  } else {
    const refreshStartedAt = Date.now();
    const authoritativeRecord = normalizeRecord(await (input.fetchEntry ?? fetchWorkReportEntry)(
      input.monitor.formId,
      input.monitor.entryId,
      true,
      { strictRefresh: true }
    ), true);
    const observedAt = new Date().toISOString();
    settlement = {
      authoritativeRecord,
      shouldDeleteRetryMutation: false,
      monitor: {
        ...input.monitor,
        confirmedAt: input.monitor.confirmedAt ?? observedAt,
        authoritativeRefreshMs: Math.max(0, Date.now() - refreshStartedAt),
        message:
          input.monitor.status === "success"
            ? input.successMessage
            : input.monitor.message,
        updatedAt: observedAt,
      },
    };
  }
  const settledMonitor: CreateTaskMonitor = {
    ...settlement.monitor,
    entryFieldSettlementOutcome:
      settlement.monitor.entryFieldSettlementOutcome ?? "settled",
    entryFieldSettlementRecord: settlement.authoritativeRecord,
    entryFieldSettlementRetryAt: undefined,
    entryFieldSettlementAttempts: undefined,
    entryFieldSettlementErrorCode: undefined,
  };
  const expectedPatch = settledMonitor.confirmedEntry?.patch ??
    (settledMonitor.optimisticMutation?.patch.kind === "update-entry"
      ? settledMonitor.optimisticMutation.patch.patch
      : undefined);
  if (retryMutation && settledMonitor.entryFieldSettlementOutcome === "superseded") {
    (input.markRetryMutationSupersededByClientMutationId ?? markRetryableEntryFieldMutationSupersededByClientMutationId)(
      retryMutation.operation, retryMutation.clientMutationId, settledMonitor.optimisticMutation?.lifecycle
    );
  }
  input.consumer?.applySettlement?.({
    taskId: input.monitor.taskId,
    authoritativeRecord: settlement.authoritativeRecord,
    expectedPatch,
  });
  input.upsertMonitor(settledMonitor);
  if (settlement.shouldDeleteRetryMutation) {
    if (retryMutation?.taskId === input.monitor.taskId) {
      (input.deleteRetryMutation ?? deleteRetryableEntryFieldMutationByTaskId)(
        input.monitor.taskId
      );
    } else if (isEntryFieldMutationOperation(operation) && clientMutationId) {
      (
        input.deleteRetryMutationByClientMutationId ??
        deleteRetryableEntryFieldMutationByClientMutationId
      )(operation, clientMutationId);
    }
  } else if (
    !retryMutation &&
    isEntryFieldMutationOperation(operation) &&
    clientMutationId
  ) {
    (
      input.deleteRetryMutationByClientMutationId ??
      deleteRetryableEntryFieldMutationByClientMutationId
    )(operation, clientMutationId);
  }
  return {
    ...settlement,
    monitor: settledMonitor,
  };
}

function isTaskRunning(status: CreateTaskMonitor["status"]): boolean {
  return status === "pending" || status === "running";
}

function isMonitorRunning(monitor: CreateTaskMonitor): boolean {
  return isTaskRunning(monitor.status) && monitor.stale !== true;
}

function isMonitorTrackable(monitor: CreateTaskMonitor): boolean {
  return (
    isMonitorRunning(monitor) ||
    (isTaskRunning(monitor.status) &&
      monitor.stale === true &&
      monitor.retryableStale === true)
  );
}

export function isTaskMonitorClearable(
  monitor: CreateTaskMonitor,
  getRetryMutation = getRetryableEntryFieldMutationByTaskId
): boolean {
  const retryMutation = getRetryMutation(monitor.taskId);
  const settlementTerminal = isEntryFieldMutationSettlementTerminal(monitor);
  return (
    !isEntryFieldConfirmationPending(monitor) &&
    !isMonitorTrackable(monitor) &&
    (settlementTerminal ||
      (monitor.lifecycleState !== "indeterminate" &&
        monitor.lifecycleState !== "unknown")) &&
    (!retryMutation ||
      !isRetryableEntryFieldMutationBlocking(retryMutation, monitor)) &&
    (settlementTerminal ||
      monitor.optimisticMutation?.lifecycle.optimisticState !== "frozen")
  );
}

export function clearFinishedTaskMonitorsAndEvidence(
  monitors: CreateTaskMonitor[],
  getRetryMutation = getRetryableEntryFieldMutationByTaskId,
  deleteRetryMutation = deleteRetryableEntryFieldMutationByTaskId,
  deleteRetryMutationByClientMutationId = deleteRetryableEntryFieldMutationByClientMutationId
): CreateTaskMonitor[] {
  const clearableTaskIds = new Set<string>();
  for (const monitor of monitors) {
    if (!isTaskMonitorClearable(monitor, getRetryMutation)) {
      continue;
    }
    clearableTaskIds.add(monitor.taskId);
    if (monitor.entryFieldSettlementOutcome) {
      const operation = resolveTaskMonitorEntryFieldOperation(monitor);
      const clientMutationId =
        monitor.entryFieldClientMutationId ??
        monitor.optimisticMutation?.lifecycle.mutationId;
      if (operation && clientMutationId && !getRetryMutation(monitor.taskId)) {
        deleteRetryMutationByClientMutationId(operation, clientMutationId);
      } else {
        deleteRetryMutation(monitor.taskId);
      }
    }
  }
  return monitors.filter((monitor) => !clearableTaskIds.has(monitor.taskId));
}

export function limitTaskMonitorHistory(monitors: CreateTaskMonitor[]): CreateTaskMonitor[] {
  const pendingCount = monitors.filter(monitor => !isTaskMonitorClearable(monitor)).length;
  let historySlots = Math.max(0, MAX_CREATE_TASK_MONITORS - pendingCount);
  return monitors.filter(monitor => !isTaskMonitorClearable(monitor) || historySlots-- > 0);
}

function isQueueTask(kind: WorkReportMutationTaskKind): boolean {
  return kind === "create-batch" || kind === "delete" || kind === "delete-batch";
}

function isTaskNotFoundError(error: unknown): boolean {
  return getApiErrorCode(error) === "TASK_NOT_FOUND";
}

function isWorkReportQueueTask(task: CreateReportTaskResult | WorkReportQueueTask): task is WorkReportQueueTask {
  return "rowId" in task;
}

function getTaskRowId(task: CreateReportTaskResult | WorkReportQueueTask): string | undefined {
  return isWorkReportQueueTask(task) ? task.rowId ?? undefined : task.result?.rowId;
}

function getTaskConfirmedEntry(
  task: CreateReportTaskResult | WorkReportQueueTask
): CreateTaskMonitor["confirmedEntry"] {
  return isWorkReportQueueTask(task) ? undefined : task.result?.confirmedEntry;
}

function getTaskErrorMessage(task: CreateReportTaskResult | WorkReportQueueTask): string {
  if (isWorkReportQueueTask(task)) {
    return getWorkReportTaskErrorMessage(task);
  }
  return getWorkReportTaskErrorMessage(task);
}

function getDeleteTaskOutcome(
  task: CreateReportTaskResult | WorkReportQueueTask
): Pick<
  CreateTaskMonitor,
  "deletedCount" | "deleteFinalizeFailed" | "batchCreatedRowIds"
> {
  if (!isWorkReportQueueTask(task)) {
    return {};
  }
  return {
    ...(typeof task.deletedCount === "number"
      ? { deletedCount: task.deletedCount }
      : {}),
    ...(typeof task.deleteFinalizeFailed === "boolean"
      ? { deleteFinalizeFailed: task.deleteFinalizeFailed }
      : {}),
    ...(Array.isArray(task.batchCreatedRowIds)
      ? { batchCreatedRowIds: task.batchCreatedRowIds }
      : {}),
  };
}

function getFailedTaskMessage(
  kind: WorkReportMutationTaskKind,
  task: CreateReportTaskResult | WorkReportQueueTask,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (
    (kind === "delete" || kind === "delete-batch") &&
    isWorkReportQueueTask(task) &&
    (task.deletedCount ?? 0) > 0
  ) {
    return (
      task.message ||
      t("workReport:messages.deletePartiallyCompleted", {
        count: task.deletedCount,
      })
    );
  }

  const detail =
    getTaskErrorMessage(task) ||
    t("workReport:messages.backgroundProcessingFailedDefault");
  return t("workReport:messages.backgroundProcessingFailedWithError", { error: detail });
}

function getRunningTaskMessage(
  kind: WorkReportMutationTaskKind,
  status: CreateTaskMonitor["status"],
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (kind === "create" || kind === "create-batch") {
    return status === "pending"
      ? t("workReport:messages.createTaskQueuedContinue")
      : t("workReport:messages.createTaskBackgroundRunning");
  }
  if (kind === "delete" || kind === "delete-batch") {
    return status === "pending"
      ? t("workReport:messages.taskQueuedWaitingPrevious")
      : t("workReport:messages.deleteTaskBackgroundRunning");
  }
  return status === "pending"
    ? t("workReport:messages.taskQueuedWaitingPrevious")
    : t("workReport:messages.taskBackgroundRecalcRunning");
}

function getSuccessTaskMessage(
  kind: WorkReportMutationTaskKind,
  task: CreateReportTaskResult | WorkReportQueueTask,
  rowId: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (kind === "create-batch" && "message" in task && task.message) {
    return task.message;
  }
  if ((kind === "delete" || kind === "delete-batch") && "message" in task && task.message) {
    return task.message;
  }
  if (kind === "update") {
    if (!rowId || rowId === "-") {
      return t("workReport:messages.taskBackgroundUpdateCompleted");
    }
    return t("workReport:messages.taskBackgroundUpdatedWithRow", { rowId });
  }
  return t("workReport:messages.taskBackgroundCompletedWithRow", { rowId });
}

function getSuccessToastMessage(
  monitor: CreateTaskMonitor,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (monitor.kind === "create-batch") {
    return monitor.message;
  }
  if (monitor.kind === "delete" || monitor.kind === "delete-batch") {
    return monitor.message;
  }
  if (monitor.kind === "update") {
    if (!monitor.rowId) {
      return t("workReport:messages.toastEntryUpdateSuccess");
    }
    return t("workReport:messages.toastUpdateSuccess", {
      rowId: monitor.rowId,
    });
  }
  return t("workReport:messages.toastCreateSuccess", {
    rowId: monitor.rowId ?? "-",
  });
}

export function resolveTaskMonitorResult(
  baseMonitor: CreateTaskMonitor,
  task: CreateReportTaskResult | WorkReportQueueTask,
  t: (key: string, options?: Record<string, unknown>) => string
): CreateTaskMonitor {
  const kind: WorkReportMutationTaskKind = baseMonitor.kind ?? "create";
  const deleteOutcome = getDeleteTaskOutcome(task);
  const lifecycleState = resolveTaskMutationLifecycleState({
    status: task.status,
    lifecycleState: task.lifecycleState,
    errorCode: "errorCode" in task ? task.errorCode : task.error?.code,
    writeIndeterminate: task.writeIndeterminate,
    batchWriteIndeterminate:
      "batchWriteIndeterminate" in task ? task.batchWriteIndeterminate : undefined,
  });
  const acceptedAt = task.acceptedAt ?? baseMonitor.acceptedAt ?? null;
  const confirmedAt = task.confirmedAt ?? baseMonitor.confirmedAt ?? null;
  const optimisticMutation = baseMonitor.optimisticMutation
    ? reconcileWorkReportOptimisticMutation(baseMonitor.optimisticMutation, {
        lifecycleState,
        confirmedAt,
      })
    : undefined;
  if (task.status === "pending" || task.status === "running") {
    return {
      ...baseMonitor,
      kind,
      status: task.status,
      lifecycleState,
      acceptedAt,
      confirmedAt: null,
      confirmedEntry: undefined,
      stale: undefined,
      retryableStale: undefined,
      message: getRunningTaskMessage(kind, task.status, t),
      updatedAt: task.updatedAt ?? new Date().toISOString(),
      ...(optimisticMutation ? { optimisticMutation } : {}),
      ...deleteOutcome,
    };
  }

  if (task.status === "success") {
    const rowId =
      getTaskRowId(task) ??
      baseMonitor.rowId ??
      (kind === "update" ? undefined : "-");
    return {
      ...baseMonitor,
      kind,
      status: "success",
      lifecycleState,
      acceptedAt,
      confirmedAt,
      confirmedEntry: getTaskConfirmedEntry(task),
      stale: undefined,
      retryableStale: undefined,
      ...(rowId ? { rowId } : {}),
      message: getSuccessTaskMessage(kind, task, rowId ?? "-", t),
      updatedAt: task.updatedAt ?? new Date().toISOString(),
      ...(optimisticMutation ? { optimisticMutation } : {}),
      ...deleteOutcome,
    };
  }

  return {
    ...baseMonitor,
    kind,
    status: "failed",
    lifecycleState,
    acceptedAt,
    confirmedAt:
      lifecycleState === "indeterminate" || lifecycleState === "unknown"
        ? null
        : confirmedAt,
    confirmedEntry: undefined,
    stale: undefined,
    retryableStale: undefined,
    message: getFailedTaskMessage(kind, task, t),
    updatedAt: task.updatedAt ?? new Date().toISOString(),
    ...(optimisticMutation ? { optimisticMutation } : {}),
    ...deleteOutcome,
  };
}

function readStoredTaskMonitors(): CreateTaskMonitor[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(WORK_REPORT_TASK_MONITOR_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const now = Date.now();
    return limitTaskMonitorHistory(parsed
      .filter((item): item is CreateTaskMonitor => {
        if (!item || typeof item !== "object") {
          return false;
        }
        const candidate = item as Partial<CreateTaskMonitor>;
        return (
          typeof candidate.taskId === "string" &&
          typeof candidate.formId === "string" &&
          typeof candidate.entryId === "string" &&
          typeof candidate.workOrderNo === "string" &&
          typeof candidate.status === "string" &&
          typeof candidate.message === "string" &&
          typeof candidate.updatedAt === "string" &&
          (candidate.retryableStale === undefined ||
            typeof candidate.retryableStale === "boolean") &&
          (candidate.entryFieldSettlementRetryAt === undefined ||
            (Number.isFinite(candidate.entryFieldSettlementRetryAt) && candidate.entryFieldSettlementRetryAt! >= 0)) &&
          (candidate.entryFieldSettlementAttempts === undefined ||
            (Number.isSafeInteger(candidate.entryFieldSettlementAttempts) && candidate.entryFieldSettlementAttempts! >= 0)) &&
          (candidate.entryFieldSettlementErrorCode === undefined || candidate.entryFieldSettlementErrorCode === "REPORT_NOT_FOUND") &&
          (candidate.entryFieldOperation === undefined ||
            isEntryFieldMutationOperation(candidate.entryFieldOperation)) &&
          (candidate.entryFieldClientMutationId === undefined ||
            typeof candidate.entryFieldClientMutationId === "string") &&
          (candidate.entryFieldSettlementOutcome === undefined ||
            candidate.entryFieldSettlementOutcome === "settled" ||
            candidate.entryFieldSettlementOutcome === "superseded") &&
          (candidate.optimisticMutation === undefined ||
            isStoredWorkReportOptimisticMutation(candidate.optimisticMutation))
        );
      })
      .map((item) => {
        const restoredItem = { ...item };
        delete restoredItem.entryFieldSettlementRecord;
        return {
          ...restoredItem,
          kind: item.kind ?? "create",
          lifecycleState:
            item.stale === true
              ? "unknown"
              : item.lifecycleState ??
                resolveTaskMutationLifecycleState({ status: item.status }),
          ...(item.stale === true ? { confirmedAt: null } : {}),
        };
      })
      .filter((item) => shouldKeepTaskMonitor(item, now)));
  } catch {
    return [];
  }
}

function writeStoredTaskMonitors(monitors: CreateTaskMonitor[]): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (monitors.length === 0) {
      window.localStorage.removeItem(WORK_REPORT_TASK_MONITOR_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      WORK_REPORT_TASK_MONITOR_STORAGE_KEY,
      JSON.stringify(
        monitors.map((monitor) => {
          const storedMonitor = { ...monitor };
          delete storedMonitor.entryFieldSettlementRecord;
          return storedMonitor;
        })
      )
    );
  } catch {
    // NOTE: localStorage 寫入失敗不阻塞主流程
  }
}

function shouldKeepTaskMonitor(item: CreateTaskMonitor, now: number): boolean {
  if (isEntryFieldConfirmationPending(item)) return true;
  if (isEntryFieldMutationSettlementTerminal(item)) {
    const updatedAt = Date.parse(item.updatedAt);
    return (
      !Number.isNaN(updatedAt) &&
      now - updatedAt < CREATE_TASK_AUTO_CLEAR_MS
    );
  }
  const retryMutation = getRetryableEntryFieldMutationByTaskId(item.taskId);
  if (
    retryMutation &&
    isRetryableEntryFieldMutationBlocking(retryMutation, item)
  ) {
    const updatedAt = Date.parse(item.updatedAt);
    return (
      Number.isNaN(updatedAt) ||
      now - updatedAt < ENTRY_FIELD_TASK_RETRY_TTL_MS
    );
  }
  if (
    item.stale === true &&
    item.retryableStale === true &&
    isTaskRunning(item.status)
  ) {
    return true;
  }
  if (
    item.optimisticMutation?.lifecycle.optimisticState === "frozen" &&
    isEntryFieldMutationOperation(
      item.entryFieldOperation ?? item.optimisticMutation.lifecycle.operation
    )
  ) {
    const updatedAt = Date.parse(item.updatedAt);
    return (
      !Number.isNaN(updatedAt) &&
      now - updatedAt < ENTRY_FIELD_TASK_RETRY_TTL_MS
    );
  }
  if (
    item.stale === true ||
    item.lifecycleState === "indeterminate" ||
    item.lifecycleState === "unknown" ||
    item.optimisticMutation?.lifecycle.optimisticState === "frozen"
  ) {
    const updatedAt = Date.parse(item.updatedAt);
    return !Number.isNaN(updatedAt) && now - updatedAt < CREATE_TASK_STALE_AUTO_CLEAR_MS;
  }
  if (isTaskRunning(item.status)) {
    return true;
  }
  const updatedAt = Date.parse(item.updatedAt);
  return !Number.isNaN(updatedAt) && now - updatedAt < CREATE_TASK_AUTO_CLEAR_MS;
}

export function pruneExpiredTaskMonitors(
  monitors: CreateTaskMonitor[],
  now = Date.now()
): CreateTaskMonitor[] {
  const next = monitors.filter((item) => shouldKeepTaskMonitor(item, now));
  return next.length === monitors.length ? monitors : next;
}

export function hasTerminalTaskMonitors(monitors: CreateTaskMonitor[]): boolean {
  return monitors.some((item) => !isTaskRunning(item.status));
}

export function hasAutoClearableTaskMonitors(monitors: CreateTaskMonitor[]): boolean {
  return monitors.some((item) => !isEntryFieldConfirmationPending(item) &&
    (item.stale === true || !isTaskRunning(item.status)));
}

export async function pollCreateTaskMonitor(options: {
  seedMonitor: CreateTaskMonitor;
  fetchTask: (monitor: CreateTaskMonitor) => Promise<CreateReportTaskResult | WorkReportQueueTask>;
  buildMonitorFromTaskResult: (
    baseMonitor: CreateTaskMonitor,
    task: CreateReportTaskResult | WorkReportQueueTask
  ) => CreateTaskMonitor;
  upsertTaskMonitorState: (monitor: CreateTaskMonitor) => void;
  onSuccess: (
    monitor: CreateTaskMonitor
  ) => boolean | "retry" | void | Promise<boolean | "retry" | void>;
  onFailed: (
    monitor: CreateTaskMonitor
  ) => boolean | "retry" | void | Promise<boolean | "retry" | void>;
  buildPollingRetryMessage: (error: unknown) => string;
  buildPollingUnavailableMessage: (error: unknown) => string;
  buildTaskNotFoundMessage: () => string;
  buildTimedOutMessage: () => string;
  nowMs?: () => number;
  nowIso?: () => string;
  sleepMs?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  staleIntervalMs?: number;
  shouldContinue?: () => boolean;
}): Promise<void> {
  const nowMs = options.nowMs ?? Date.now;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const sleepMs =
    options.sleepMs ??
    ((ms) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      }));
  const timeoutMs = options.timeoutMs ?? CREATE_TASK_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? CREATE_TASK_POLL_INTERVAL_MS;
  const staleIntervalMs =
    options.staleIntervalMs ?? CREATE_TASK_STALE_POLL_INTERVAL_MS;
  const startedAt = nowMs();
  let currentMonitor = options.seedMonitor;
  let lastPollingError: unknown = null;
  let stalePolling =
    currentMonitor.stale === true && currentMonitor.retryableStale === true;
  const wakeup = options.sleepMs ? null : createTaskEventWakeup(
    options.seedMonitor.formId, options.seedMonitor.taskId,
  );

  try {
  while (options.shouldContinue?.() ?? true) {
    let allowEvents = true;
    try {
      const task = await options.fetchTask(currentMonitor);
      lastPollingError = null;
      const nextMonitor = options.buildMonitorFromTaskResult(currentMonitor, task);

      if (!isMonitorRunning(nextMonitor)) {
        let terminalHandled: boolean | "retry" | void = false;
        if (nextMonitor.status === "success") {
          terminalHandled = await options.onSuccess(nextMonitor);
        } else if (nextMonitor.status === "failed") {
          terminalHandled = await options.onFailed(nextMonitor);
        }
        if (terminalHandled !== "retry") {
          if (terminalHandled !== true) {
            options.upsertTaskMonitorState(nextMonitor);
          }
          return;
        }
        allowEvents = false;
      } else {
        currentMonitor = nextMonitor;
        options.upsertTaskMonitorState(nextMonitor);
      }
    } catch (error) {
      allowEvents = false;
      const taskNotFound = isTaskNotFoundError(error);
      const nextMonitor: CreateTaskMonitor = {
        ...currentMonitor,
        kind: currentMonitor.kind ?? "create",
        status: currentMonitor.status,
        lifecycleState: taskNotFound
          ? "unknown"
          : currentMonitor.lifecycleState,
        ...(taskNotFound ? { confirmedAt: null } : {}),
        stale: taskNotFound ? true : currentMonitor.stale,
        retryableStale: taskNotFound
          ? false
          : currentMonitor.retryableStale,
        message: taskNotFound
          ? options.buildTaskNotFoundMessage()
          : options.buildPollingRetryMessage(error),
        updatedAt: nowIso(),
        ...(currentMonitor.optimisticMutation && taskNotFound
          ? {
              optimisticMutation: reconcileWorkReportOptimisticMutation(
                currentMonitor.optimisticMutation,
                { lifecycleState: "unknown" }
              ),
            }
          : {}),
      };
      options.upsertTaskMonitorState(nextMonitor);
      currentMonitor = nextMonitor;
      if (taskNotFound) {
        return;
      }
      lastPollingError = error;
    }

    if (!stalePolling && nowMs() - startedAt > timeoutMs) {
      const retryableStale =
        resolveTaskMonitorEntryFieldOperation(currentMonitor) !== null;
      currentMonitor = {
        ...currentMonitor,
        kind: currentMonitor.kind ?? "create",
        status: currentMonitor.status,
        lifecycleState: "unknown",
        confirmedAt: null,
        stale: true,
        retryableStale,
        message: lastPollingError
          ? options.buildPollingUnavailableMessage(lastPollingError)
          : options.buildTimedOutMessage(),
        updatedAt: nowIso(),
        ...(currentMonitor.optimisticMutation
          ? {
              optimisticMutation: reconcileWorkReportOptimisticMutation(
                currentMonitor.optimisticMutation,
                { lifecycleState: "unknown" }
              ),
            }
          : {}),
      };
      options.upsertTaskMonitorState(currentMonitor);
      if (!retryableStale) {
        return;
      }
      stalePolling = true;
    }

    const delay = stalePolling ? staleIntervalMs
      : allowEvents && wakeup?.connected() ? 30_000 : intervalMs;
    if (wakeup) await wakeup.wait(delay, allowEvents);
    else await sleepMs(delay);
  }
  } finally { wakeup?.dispose(); }
}

export function persistTaskMonitorEntryFieldLifecycle(
  monitor: Pick<
    CreateTaskMonitor,
    "taskId" | "entryFieldSettlementOutcome" | "optimisticMutation"
  >,
  persistLifecycle = updateRetryableEntryFieldMutationLifecycleByTaskId
): void {
  if (!monitor.optimisticMutation) {
    return;
  }
  const operation = monitor.optimisticMutation.lifecycle.operation;
  if (!isEntryFieldMutationOperation(operation)) {
    return;
  }
  if (monitor.entryFieldSettlementOutcome === "superseded") {
    persistLifecycle(
      monitor.taskId,
      monitor.optimisticMutation.lifecycle,
      monitor.entryFieldSettlementOutcome
    );
    return;
  }
  persistLifecycle(monitor.taskId, monitor.optimisticMutation.lifecycle);
}

export function persistTaskMonitorEntryFieldLifecycles(
  monitors: Array<
    Pick<
      CreateTaskMonitor,
      "taskId" | "entryFieldSettlementOutcome" | "optimisticMutation"
    >
  >,
  persistLifecycle = updateRetryableEntryFieldMutationLifecycleByTaskId
): void {
  for (const monitor of monitors) {
    persistTaskMonitorEntryFieldLifecycle(monitor, persistLifecycle);
  }
}

export function resolveTaskMonitorEntryFieldOperation(
  monitor: Pick<CreateTaskMonitor, "entryFieldOperation" | "optimisticMutation">
): WorkReportEntryFieldMutationOperation | null {
  const operation =
    monitor.entryFieldOperation ??
    monitor.optimisticMutation?.lifecycle.operation;
  return isEntryFieldMutationOperation(operation) ? operation : null;
}

function getEntryFieldQueuedMessageKey(
  operation: WorkReportEntryFieldMutationOperation
): string {
  if (operation === "work-report-start-schedule") {
    return "workReport:table.startScheduleQueued";
  }
  if (operation === "work-report-main-machine") {
    return "workReport:table.mainMachineQueued";
  }
  if (operation === "work-report-planned-end-date") {
    return "workReport:table.plannedEndDateQueued";
  }
  if (operation === "work-report-urgent") {
    return "workReport:table.urgentQueued";
  }
  return "workReport:table.sortOrderQueued";
}

export function mergeRetryableEntryFieldTaskMonitors(
  monitors: CreateTaskMonitor[],
  retryMutations: RetryableEntryFieldMutation[],
  translate: (key: string) => string
): CreateTaskMonitor[] {
  const existingTaskIds = new Set(monitors.map((monitor) => monitor.taskId));
  const restored = retryMutations
    .filter(
      (mutation) =>
        Boolean(mutation.taskId) && !existingTaskIds.has(mutation.taskId!)
    )
    .map((mutation): CreateTaskMonitor => {
      const lifecycleState = mutation.settlementOutcome === "superseded" ? "conflict" : mutation.lifecycle?.lifecycleState ?? "accepted";
      const terminal =
        lifecycleState === "success" ||
        lifecycleState === "failed" ||
        lifecycleState === "conflict" ||
        lifecycleState === "indeterminate" ||
        lifecycleState === "unknown";
      return {
        taskId: mutation.taskId!,
        kind: "update",
        formId: mutation.formId,
        entryId: mutation.entryId,
        workOrderNo: String(mutation.workOrderNo ?? mutation.entryId),
        status: lifecycleState === "success" ? "success" : terminal ? "failed" : "pending",
        lifecycleState,
        acceptedAt: mutation.lifecycle?.acceptedAt ?? mutation.createdAt,
        confirmedAt: mutation.lifecycle?.confirmedAt ?? null,
        entryFieldOperation: mutation.operation,
        entryFieldClientMutationId: mutation.clientMutationId,
        entryFieldSettlementOutcome: mutation.settlementOutcome,
        message: translate(getEntryFieldQueuedMessageKey(mutation.operation)),
        updatedAt: mutation.createdAt,
        ...(mutation.lifecycle
          ? {
              optimisticMutation: {
                lifecycle: mutation.lifecycle,
                patch: {
                  kind: "update-entry" as const,
                  patch: mutation.successPatch,
                },
              },
            }
          : {}),
      };
    })
    .reverse();
  const combined = [...restored, ...monitors];
  const retryTaskIds = new Set(
    retryMutations
      .map((mutation) => mutation.taskId)
      .filter((taskId): taskId is string => Boolean(taskId))
  );
  const retryMonitors = combined.filter((monitor) =>
    retryTaskIds.has(monitor.taskId)
  );
  const regularMonitors = combined.filter(
    (monitor) => !retryTaskIds.has(monitor.taskId)
  );
  return limitTaskMonitorHistory([
    ...retryMonitors,
    ...regularMonitors,
  ]);
}

export function useTaskMonitor() {
  const { t } = useTranslation(["workReport", "common"]);
  const [createTaskMonitors, setCreateTaskMonitors] = useState<CreateTaskMonitor[]>(
    () =>
      mergeRetryableEntryFieldTaskMonitors(
        readStoredTaskMonitors(),
        listRetryableEntryFieldMutations(),
        t
      )
  );
  const [taskMonitorExpanded, setTaskMonitorExpanded] = useState(false);
  const trackingTaskIdsRef = useRef(new Set<string>());
  const settlementRetryRef = useRef(new EntryFieldSettlementRetry(Date.now, createTaskMonitors));
  const retainedTerminalTaskIdsRef = useRef(new Set<string>());
  const settledEntryFieldTaskIdsRef = useRef(new Set<string>());
  const entryFieldSettlementConsumersRef = useRef(
    new Map<WorkReportFormId, EntryFieldSettlementConsumer>()
  );
  const [entryFieldSettlementRetryEpoch, setEntryFieldSettlementRetryEpoch] =
    useState(0);
  const mountedRef = useRef(true);

  useEffect(
    () =>
      subscribeEntryFieldTaskRetryStore(() => {
        setCreateTaskMonitors((current) =>
          mergeRetryableEntryFieldTaskMonitors(
            current,
            listRetryableEntryFieldMutations(),
            t
          )
        );
      }),
    [t]
  );

  const registerEntryFieldSettlementConsumer = useCallback(
    (
      formId: WorkReportFormId,
      consumer: EntryFieldSettlementConsumer
    ): (() => void) => {
      entryFieldSettlementConsumersRef.current.set(formId, consumer);
      return () => {
        if (entryFieldSettlementConsumersRef.current.get(formId) === consumer) {
          entryFieldSettlementConsumersRef.current.delete(formId);
        }
      };
    },
    []
  );

  const upsertTaskMonitorState = useCallback(
    (nextMonitor: CreateTaskMonitor): void => {
      setCreateTaskMonitors((prev) => {
        const index = prev.findIndex((item) => item.taskId === nextMonitor.taskId);
        const next = index === -1 ? [nextMonitor, ...prev] : [...prev];
        if (index !== -1) {
          next[index] = {
            ...next[index],
            ...nextMonitor,
          };
        }
        return mergeRetryableEntryFieldTaskMonitors(
          next,
          listRetryableEntryFieldMutations(),
          t
        );
      });
    },
    [t]
  );

  const buildMonitorFromTaskResult = useCallback(
    (
      baseMonitor: CreateTaskMonitor,
      task: CreateReportTaskResult | WorkReportQueueTask
    ): CreateTaskMonitor => resolveTaskMonitorResult(baseMonitor, task, t),
    [t]
  );

  const settleTrackedEntryFieldTask = useCallback(
    async (monitor: CreateTaskMonitor, fetchEntry = fetchWorkReportEntry): Promise<boolean | "retry"> => {
      if (!resolveTaskMonitorEntryFieldOperation(monitor)) {
        return false;
      }
      if (settledEntryFieldTaskIdsRef.current.has(monitor.taskId)) {
        return true;
      }
      const retry = settlementRetryRef.current;
      const pendingMonitor: CreateTaskMonitor = {
        ...monitor,
        entryFieldSettlementRetryAt: retry.retryAt(monitor),
      };
      if (!retainedTerminalTaskIdsRef.current.has(monitor.taskId)) {
        retainedTerminalTaskIdsRef.current.add(monitor.taskId);
        upsertTaskMonitorState(pendingMonitor);
      }
      if (!retry.begin(monitor)) return true;
      const consumer =
        monitor.formId === "901" || monitor.formId === "902"
          ? entryFieldSettlementConsumersRef.current.get(monitor.formId)
          : undefined;
      try {
        const settlement = await settleTerminalEntryFieldTask({
          monitor,
          consumer,
          fetchEntry,
          upsertMonitor: upsertTaskMonitorState,
          successMessage: t("workReport:messages.taskBackgroundUpdateCompleted"),
          supersededMessage: t("workReport:messages.entryFieldMutationSuperseded"),
        });
        if (!settlement) {
          return false;
        }
        settledEntryFieldTaskIdsRef.current.add(monitor.taskId);
        retry.settled(monitor.taskId);
        if (settlement.monitor.entryFieldSettlementOutcome === "superseded") {
          void message.warning(settlement.monitor.message);
        } else if (settlement.monitor.status === "success") {
          void message.success(settlement.monitor.message);
        } else {
          void message.error(settlement.monitor.message);
        }
        return true;
      } catch (error) {
        if (settlementReadRequiresManualRetry(error)) {
          retry.pause(monitor.taskId);
          upsertTaskMonitorState({
            ...pendingMonitor,
            entryFieldSettlementRetryAt: retry.retryAt(monitor),
            entryFieldSettlementErrorCode: "REPORT_NOT_FOUND",
          });
          return true;
        }
        const deferred = retry.defer(monitor, error);
        upsertTaskMonitorState({
          ...pendingMonitor,
          entryFieldSettlementRetryAt: deferred.retryAt,
          entryFieldSettlementAttempts: deferred.attempts,
        });
        if (deferred.notify) void message.warning({
          key: "work-report-confirmation-unavailable",
          content: t("workReport:messages.entryFieldConfirmationUnavailable"),
        });
        // The retained terminal result is now owned by the confirmation retry effect.
        return true;
      } finally {
        retry.finish(monitor.taskId);
        if (mountedRef.current) setEntryFieldSettlementRetryEpoch(current => current + 1);
      }
    },
    [t, upsertTaskMonitorState]
  );

  const trackCreateTask = useCallback(
    (seedMonitor: CreateTaskMonitor): void => {
      if (!isMonitorTrackable(seedMonitor)) {
        return;
      }
      if (trackingTaskIdsRef.current.has(seedMonitor.taskId)) {
        return;
      }
      if (retainedTerminalTaskIdsRef.current.has(seedMonitor.taskId) || settledEntryFieldTaskIdsRef.current.has(seedMonitor.taskId)) {
        return;
      }

      trackingTaskIdsRef.current.add(seedMonitor.taskId);

      const run = async () => {
        try {
          await pollCreateTaskMonitor({
            seedMonitor,
            fetchTask: (monitor) =>
              isQueueTask(monitor.kind)
                ? fetchWorkReportQueueTask(monitor.formId, monitor.taskId)
                : fetchCreateReportTask(monitor.formId, monitor.taskId),
            buildMonitorFromTaskResult,
            upsertTaskMonitorState,
            onSuccess: async (nextMonitor) => {
              deleteRetryableMutationRecord(nextMonitor.taskId);
              if (nextMonitor.kind === "create-batch") {
                deleteRetryableBatchCreateRecordChain(nextMonitor.taskId);
              }
              if (resolveTaskMonitorEntryFieldOperation(nextMonitor)) {
                return settleTrackedEntryFieldTask(nextMonitor);
              }
              void message.success(getSuccessToastMessage(nextMonitor, t));
              return false;
            },
            onFailed: async (nextMonitor) => {
              if (resolveTaskMonitorEntryFieldOperation(nextMonitor)) {
                return settleTrackedEntryFieldTask(nextMonitor);
              }
              if (
                nextMonitor.lifecycleState === "indeterminate" ||
                nextMonitor.lifecycleState === "unknown"
              ) {
                return false;
              }
              if (
                (nextMonitor.kind === "delete" || nextMonitor.kind === "delete-batch") &&
                (nextMonitor.deletedCount ?? 0) > 0
              ) {
                void message.warning(nextMonitor.message);
                return false;
              }
              void message.error(nextMonitor.message);
              return false;
            },
            buildPollingRetryMessage: (error) =>
              t("workReport:messages.backgroundPollingRetrying", {
                error: getErrorMessage(error),
              }),
            buildPollingUnavailableMessage: (error) =>
              t("workReport:messages.backgroundPollingUnavailable", {
                error: getErrorMessage(error),
              }),
            buildTaskNotFoundMessage: () => t("workReport:messages.backgroundTaskStatusUnknown"),
            buildTimedOutMessage: () => t("workReport:messages.backgroundProcessingTimedOut"),
            shouldContinue: () => mountedRef.current,
          });
        } finally {
          trackingTaskIdsRef.current.delete(seedMonitor.taskId);
        }
      };

      void run();
    },
    [
      buildMonitorFromTaskResult,
      settleTrackedEntryFieldTask,
      t,
      upsertTaskMonitorState,
    ]
  );

  const upsertCreateTaskMonitor = useCallback(
    (nextMonitor: CreateTaskMonitor): void => {
      upsertTaskMonitorState(nextMonitor);
      trackCreateTask(nextMonitor);
    },
    [trackCreateTask, upsertTaskMonitorState]
  );

  const clearFinishedTaskMonitors = useCallback((): void => {
    const remainingTaskIds = new Set(
      clearFinishedTaskMonitorsAndEvidence(createTaskMonitors).map(
        (monitor) => monitor.taskId
      )
    );
    const clearedTaskIds = new Set(
      createTaskMonitors
        .filter((monitor) => !remainingTaskIds.has(monitor.taskId))
        .map((monitor) => monitor.taskId)
    );
    setCreateTaskMonitors((current) =>
      current.filter((monitor) => !clearedTaskIds.has(monitor.taskId))
    );
  }, [createTaskMonitors]);

  const retryEntryFieldConfirmation = useCallback((taskId: string): void => {
    const monitor = createTaskMonitors.find(item => item.taskId === taskId);
    if (!monitor || !isEntryFieldConfirmationPending(monitor) || !monitor.entryFieldSettlementErrorCode) return;
    settlementRetryRef.current.resume(taskId);
    upsertTaskMonitorState({ ...monitor, entryFieldSettlementErrorCode: undefined });
  }, [createTaskMonitors, upsertTaskMonitorState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hasPendingEntryFieldSettlement = useMemo(
    () =>
      createTaskMonitors.some((monitor) =>
        shouldSettleEntryFieldMutationTask(monitor)
      ),
    [createTaskMonitors]
  );

  useEffect(() => {
    if (!hasPendingEntryFieldSettlement) {
      settlementRetryRef.current.recovered();
      return;
    }
    const pending = createTaskMonitors.filter(shouldSettleEntryFieldMutationTask);
    const nextAttemptAt = Math.min(...pending.map(monitor => settlementRetryRef.current.retryAt(monitor)));
    const timer = window.setTimeout(() => {
      setEntryFieldSettlementRetryEpoch((current) => current + 1);
    }, Math.max(1_000, nextAttemptAt - Date.now()));
    return () => {
      window.clearTimeout(timer);
    };
  }, [hasPendingEntryFieldSettlement, createTaskMonitors, entryFieldSettlementRetryEpoch]);

  useEffect(() => {
    const fetchEntry = createEntryFieldSettlementReader(fetchWorkReportEntry);
    const pending = createTaskMonitors.filter(shouldSettleEntryFieldMutationTask)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const monitor of pending) {
      if (
        settledEntryFieldTaskIdsRef.current.has(monitor.taskId) ||
        !shouldSettleEntryFieldMutationTask(monitor)
      ) {
        continue;
      }
      void settleTrackedEntryFieldTask(monitor, fetchEntry);
    }
  }, [
    createTaskMonitors,
    entryFieldSettlementRetryEpoch,
    settleTrackedEntryFieldTask,
  ]);

  useEffect(() => {
    for (const taskIds of [retainedTerminalTaskIdsRef.current, settledEntryFieldTaskIdsRef.current]) {
      settlementRetryRef.current.retainTaskIds(taskIds, createTaskMonitors, trackingTaskIdsRef.current);
    }
  }, [createTaskMonitors, entryFieldSettlementRetryEpoch]);

  useEffect(() => {
    persistTaskMonitorEntryFieldLifecycles(createTaskMonitors);
  }, [createTaskMonitors]);

  useEffect(() => {
    if (!hasAutoClearableTaskMonitors(createTaskMonitors)) {
      return;
    }

    const timer = window.setInterval(() => {
      setCreateTaskMonitors((prev) => pruneExpiredTaskMonitors(prev));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [createTaskMonitors]);

  useEffect(() => {
    writeStoredTaskMonitors(createTaskMonitors);
  }, [createTaskMonitors]);

  useEffect(() => {
    for (const monitor of createTaskMonitors) {
      if (isMonitorTrackable(monitor)) {
        trackCreateTask(monitor);
      }
    }
  }, [createTaskMonitors, trackCreateTask]);

  const hasFinishedTaskMonitors = useMemo(
    () => createTaskMonitors.some((monitor) => isTaskMonitorClearable(monitor)),
    [createTaskMonitors]
  );
  const taskRunningCount = useMemo(
    () => createTaskMonitors.filter((item) => isMonitorTrackable(item)).length,
    [createTaskMonitors]
  );
  const taskFailedCount = useMemo(
    () => createTaskMonitors.filter((item) => item.status === "failed").length,
    [createTaskMonitors]
  );
  const latestTaskMonitor = useMemo(
    () =>
      createTaskMonitors.reduce<CreateTaskMonitor | null>((latest, current) => {
        if (!latest) {
          return current;
        }
        const latestTime = Date.parse(latest.updatedAt);
        const currentTime = Date.parse(current.updatedAt);
        if (Number.isNaN(latestTime) || Number.isNaN(currentTime)) {
          return latest;
        }
        return currentTime > latestTime ? current : latest;
      }, null),
    [createTaskMonitors]
  );

  const toggleTaskMonitorExpanded = useCallback(() => {
    setTaskMonitorExpanded((prev) => !prev);
  }, []);

  const collapseTaskMonitor = useCallback(() => {
    setTaskMonitorExpanded(false);
  }, []);

  return useMemo(
    () => ({
      createTaskMonitors,
      taskMonitorExpanded: createTaskMonitors.length > 0 && taskMonitorExpanded,
      setTaskMonitorExpanded,
      toggleTaskMonitorExpanded,
      collapseTaskMonitor,
      upsertCreateTaskMonitor,
      registerEntryFieldSettlementConsumer,
      clearFinishedTaskMonitors,
      retryEntryFieldConfirmation,
      hasFinishedTaskMonitors,
      taskRunningCount,
      taskFailedCount,
      latestTaskMonitor,
    }),
    [
      clearFinishedTaskMonitors,
      retryEntryFieldConfirmation,
      collapseTaskMonitor,
      createTaskMonitors,
      hasFinishedTaskMonitors,
      latestTaskMonitor,
      taskFailedCount,
      taskMonitorExpanded,
      taskRunningCount,
      registerEntryFieldSettlementConsumer,
      toggleTaskMonitorExpanded,
      upsertCreateTaskMonitor,
    ]
  );
}
