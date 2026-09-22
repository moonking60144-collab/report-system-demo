import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import { HttpError } from "../utils/httpError";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskOperationKind,
  type WorkReportQueueTaskType,
} from "./work-report/workReportTaskRegistryService";
import { workReportEntryMutationQueue } from "./work-report/workReportEntryMutationQueue";
import { isActivityLogMutationWriteIndeterminateError } from "./activityLog/activityLogIdempotencyService";
import {
  isConfirmedMutationLifecycleState,
  isMutationLifecycleState,
  resolveMutationLifecycleState,
  type MutationLifecycleState,
} from "../types/mutationLifecycle";
import {
  normalizeWorkReportMutationTimings,
  type WorkReportMutationFailurePhase,
  type WorkReportMutationTimings,
} from "../types/workReportMutationTiming";
import type {
  WorkReportConfirmedEntryFieldObservation,
  WorkReportEntryFieldMutationOperation,
} from "../types/workReportConfirmedEntry";

const TASK_SNAPSHOT_VERSION = "v1";

export type CreateReportTaskStatus = "pending" | "running" | "success" | "failed";

export interface CreateReportTaskResult {
  rowId?: string;
  writeStartedAt?: string | null;
  mutationTimings?: Partial<WorkReportMutationTimings>;
  confirmedEntry?: WorkReportConfirmedEntryFieldObservation;
}

export interface CreateReportTaskError {
  code?: string;
  message: string;
}

export interface CreateReportTask {
  taskId: string;
  taskType?: Extract<
    WorkReportQueueTaskType,
    "create-report" | "update-report" | "update-downtime" | "delete-downtime"
  >;
  formId: string;
  entryId: string;
  workOrderNo?: string;
  queueKey: string;
  clientMutationId?: string;
  operationFingerprint?: string;
  operationKind?: WorkReportQueueTaskOperationKind;
  writeIndeterminate?: boolean;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  status: CreateReportTaskStatus;
  createdAt: string;
  lifecycleState?: MutationLifecycleState;
  acceptedAt?: string;
  confirmedAt?: string;
  scheduleMutationObservedAt?: string;
  updatedAt: string;
  startedAt?: string;
  syncWaitStartedAt?: string;
  slotAcquiredAt?: string;
  writeStartedAt?: string | null;
  finishedAt?: string;
  timings?: WorkReportMutationTimings;
  result?: CreateReportTaskResult;
  error?: CreateReportTaskError;
  runningMessage?: string;
}

interface EnqueueCreateReportTaskInput {
  taskType?: Extract<
    WorkReportQueueTaskType,
    "create-report" | "update-report" | "update-downtime" | "delete-downtime"
  >;
  formId: string;
  entryId: string;
  workOrderNo?: string;
  queueKey: string;
  clientMutationId?: string;
  operationFingerprint?: string;
  operationKind?: WorkReportQueueTaskOperationKind;
  actorClientId?: string;
  actorTabId?: string;
  actorIp?: string;
  actorLabel?: string;
  worker: (context?: CreateReportTaskWorkerContext) => Promise<unknown>;
}

export interface CreateReportTaskWorkerContext {
  updateMutationTiming(input: {
    writeStartedAt?: string | null;
    mutationTimings: Partial<WorkReportMutationTimings>;
  }): void;
  markFailurePhase(phase: WorkReportMutationFailurePhase): void;
}

interface TaskSnapshotPayload {
  version: string;
  savedAt: string;
  tasks: CreateReportTask[];
}

function resolveTaskBaseMessage(
  task: Pick<CreateReportTask, "taskType" | "operationKind">
): string {
  if (task.taskType === "update-downtime") {
    return "更新停機紀錄任務";
  }
  if (task.taskType === "delete-downtime") {
    return "刪除停機紀錄任務";
  }
  switch (task.operationKind) {
    case "update-report-row":
      return "更新報工明細任務";
    case "update-sort-order":
      return "修改工令排序任務";
    case "update-start-schedule":
      return "修改開始排程狀態任務";
    case "update-urgent":
      return "修改急件狀態任務";
    case "update-main-machine":
      return "更新主表機台任務";
    case "update-planned-end-date":
      return "修改指定結束日期任務";
    case "close-work-order":
      return "人工結案工令任務";
    case "reopen-work-order":
      return "重新開啟工令任務";
    default:
      return task.taskType === "update-report"
        ? "更新報工背景任務"
        : "新增報工背景任務";
  }
}

function isUnresolvedScheduleMutationTask(task: CreateReportTask): boolean {
  return (
    task.taskType === "update-report" &&
    (task.operationKind === "update-start-schedule" ||
      task.operationKind === "update-sort-order" ||
      task.operationKind === "update-urgent" ||
      task.operationKind === "update-main-machine" ||
      task.operationKind === "update-planned-end-date") &&
    task.status === "failed" &&
    !task.scheduleMutationObservedAt &&
    (task.writeIndeterminate === true ||
      task.lifecycleState === "indeterminate" ||
      task.lifecycleState === "unknown" ||
      String(task.error?.code ?? "").trim().toUpperCase().endsWith("_INDETERMINATE"))
  );
}

class CreateReportTaskService {
  private readonly tasks = new Map<string, CreateReportTask>();
  private readonly queueChainByKey = workReportEntryMutationQueue;
  private readonly taskIdByClientMutationId = new Map<string, string>();
  private persistChain: Promise<void> = Promise.resolve();
  private initializedPromise: Promise<void> | null = null;

  constructor() {
    void this.initialize();
  }

  async initialize(): Promise<void> {
    if (!env.CREATE_TASK_PERSIST_ENABLED) {
      return;
    }

    if (this.initializedPromise) {
      await this.initializedPromise;
      return;
    }

    this.initializedPromise = this.loadFromDisk();
    await this.initializedPromise;
  }

  enqueue(input: EnqueueCreateReportTaskInput): CreateReportTask {
    const clientMutationId = String(input.clientMutationId ?? "").trim();
    const operationFingerprint = String(input.operationFingerprint ?? "").trim();
    if (clientMutationId) {
      const existingTaskId = this.taskIdByClientMutationId.get(clientMutationId);
      if (existingTaskId) {
        const existingTask = this.tasks.get(existingTaskId);
        if (existingTask) {
          const existingOperationFingerprint = String(
            existingTask.operationFingerprint ?? ""
          ).trim();
          if (
            operationFingerprint &&
            existingOperationFingerprint &&
            existingOperationFingerprint !== operationFingerprint
          ) {
            throw new HttpError(
              409,
              "x-client-mutation-id 已用於不同的報工操作，請重新整理後再送出。",
              "CLIENT_MUTATION_ID_CONFLICT"
            );
          }
          const canRetryRecoveredTask =
            existingTask.status === "failed" &&
            existingTask.error?.code === "TASK_RECOVERED_AFTER_RESTART" &&
            existingTask.writeIndeterminate !== true;
          if (!canRetryRecoveredTask) {
            return this.copyTask(existingTask);
          }
        }
        this.taskIdByClientMutationId.delete(clientMutationId);
      }
    }

    if (
      input.taskType === "update-report" &&
      (input.operationKind === "update-start-schedule" ||
        input.operationKind === "update-sort-order" ||
        input.operationKind === "update-urgent" ||
        input.operationKind === "update-main-machine" ||
        input.operationKind === "update-planned-end-date") &&
      workReportTaskRegistryService.hasBlockingScheduleMutationForEntry(
        input.formId,
        input.entryId
      )
    ) {
      throw new HttpError(
        409,
        "此工令已有排程修改結果待確認，請重新整理確認後再操作。",
        "SCHEDULE_MUTATION_PENDING_CONFIRMATION"
      );
    }

    this.queueChainByKey.assertAccepting(input.queueKey);

    const taskId = randomUUID();
    const createdAt = new Date().toISOString();
    const task: CreateReportTask = {
      taskId,
      taskType: input.taskType ?? "create-report",
      formId: input.formId,
      entryId: input.entryId,
      ...(typeof input.workOrderNo === "string" && input.workOrderNo.trim()
        ? { workOrderNo: input.workOrderNo.trim() }
        : {}),
      queueKey: input.queueKey,
      ...(clientMutationId ? { clientMutationId } : {}),
      ...(operationFingerprint ? { operationFingerprint } : {}),
      ...(input.operationKind ? { operationKind: input.operationKind } : {}),
      ...(input.actorClientId ? { actorClientId: input.actorClientId } : {}),
      ...(input.actorTabId ? { actorTabId: input.actorTabId } : {}),
      ...(input.actorIp ? { actorIp: input.actorIp } : {}),
      ...(input.actorLabel ? { actorLabel: input.actorLabel } : {}),
      status: "pending",
      createdAt,
      lifecycleState: "accepted",
      acceptedAt: createdAt,
      timings: { syncWaitMs: 0 },
      updatedAt: createdAt,
    };
    this.tasks.set(taskId, task);
    if (clientMutationId) {
      this.taskIdByClientMutationId.set(clientMutationId, taskId);
    }
    this.syncTaskToRegistry(task);
    this.pruneHistory();
    this.schedulePersist();

    void this.queueChainByKey.enqueue(
      input.queueKey,
      () => this.runTask(taskId, input.worker),
      {
        onWaitingForSync: () => {
          this.markWaitingForSync(taskId);
        },
      }
    );

    return this.copyTask(task);
  }

  getTask(taskId: string): CreateReportTask | null {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }
    return this.copyTask(task);
  }

  acknowledgeScheduleMutationObservation(
    formId: string,
    entryId: string,
    observedAt = new Date().toISOString()
  ): number {
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!normalizedEntryId) {
      return 0;
    }
    let acknowledgedCount = 0;
    for (const [taskId, task] of this.tasks.entries()) {
      if (
        task.formId !== formId ||
        task.entryId !== normalizedEntryId ||
        !isUnresolvedScheduleMutationTask(task)
      ) {
        continue;
      }
      this.tasks.set(taskId, {
        ...task,
        lifecycleState: "failed",
        writeIndeterminate: false,
        confirmedAt: observedAt,
        scheduleMutationObservedAt: observedAt,
        updatedAt: observedAt,
      });
      acknowledgedCount += 1;
    }
    const registryAcknowledgedCount =
      workReportTaskRegistryService.acknowledgeScheduleMutationObservation(
        formId,
        normalizedEntryId,
        observedAt
      );
    if (acknowledgedCount > 0) {
      this.schedulePersist();
    }
    return Math.max(acknowledgedCount, registryAcknowledgedCount);
  }

  getStats(): {
    total: number;
    pending: number;
    running: number;
    success: number;
    failed: number;
    activeQueueKeyCount: number;
  } {
    const counts = {
      total: this.tasks.size,
      pending: 0,
      running: 0,
      success: 0,
      failed: 0,
      activeQueueKeyCount: this.queueChainByKey.activeKeyCount,
    };

    for (const task of this.tasks.values()) {
      if (task.status === "pending") {
        counts.pending += 1;
      } else if (task.status === "running") {
        counts.running += 1;
      } else if (task.status === "success") {
        counts.success += 1;
      } else if (task.status === "failed") {
        counts.failed += 1;
      }
    }

    return counts;
  }

  async flush(): Promise<void> {
    await this.persistChain.catch((error) => {
      console.warn("[create-task][flush-failed]", {
        filePath: this.resolveStoreFilePath(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async runTask(
    taskId: string,
    worker: (context?: CreateReportTaskWorkerContext) => Promise<unknown>
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    const slotAcquiredAt = new Date().toISOString();
    const startedAt = task.startedAt ?? slotAcquiredAt;
    const syncWaitMs = task.syncWaitStartedAt
      ? Math.max(0, Date.parse(slotAcquiredAt) - Date.parse(task.syncWaitStartedAt))
      : 0;
    const acceptedToSlotMs = Math.max(
      0,
      Date.parse(slotAcquiredAt) - Date.parse(task.acceptedAt ?? task.createdAt)
    );
    const entryQueueWaitMs = Math.max(0, acceptedToSlotMs - syncWaitMs);
    this.updateTask(taskId, {
      status: "running",
      startedAt,
      slotAcquiredAt,
      timings: {
        ...(task.timings ?? { syncWaitMs: 0 }),
        syncWaitMs,
        entryQueueWaitMs,
      },
      updatedAt: slotAcquiredAt,
      runningMessage: undefined,
    });

    try {
      const workerResult = this.normalizeTaskResult(
        await worker({
          updateMutationTiming: (input) => {
            const currentTask = this.tasks.get(taskId);
            if (!currentTask) {
              return;
            }
            this.updateTask(taskId, {
              ...(input.writeStartedAt !== undefined
                ? { writeStartedAt: input.writeStartedAt }
                : {}),
              timings: normalizeWorkReportMutationTimings(
                {
                  syncWaitMs: currentTask.timings?.syncWaitMs ?? syncWaitMs,
                  ...input.mutationTimings,
                },
                currentTask.timings ?? { syncWaitMs }
              ),
            });
          },
          markFailurePhase: (phase) => {
            const currentTask = this.tasks.get(taskId);
            if (!currentTask) {
              return;
            }
            this.updateTask(taskId, {
              timings: {
                ...(currentTask.timings ?? { syncWaitMs }),
                failurePhase: phase,
              },
            });
          },
        }),
        task
      );
      const currentTask = this.tasks.get(taskId);
      const finishedAt = new Date().toISOString();
      this.updateTask(taskId, {
        status: "success",
        finishedAt,
        updatedAt: finishedAt,
        result: {
          ...(workerResult.rowId ? { rowId: workerResult.rowId } : {}),
          ...(workerResult.confirmedEntry
            ? { confirmedEntry: workerResult.confirmedEntry }
            : {}),
        },
        writeStartedAt: workerResult.writeStartedAt,
        timings: normalizeWorkReportMutationTimings(
          workerResult.mutationTimings,
          currentTask?.timings ?? { syncWaitMs }
        ),
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const currentTask = this.tasks.get(taskId);
      const normalizedError =
        error instanceof Error
          ? {
              code:
                typeof (error as { code?: unknown }).code === "string"
                  ? String((error as { code?: unknown }).code)
                  : undefined,
              message: error.message,
            }
          : { message: String(error) };
      const failurePhase =
        currentTask?.timings?.failurePhase ??
        this.inferFailurePhase(currentTask?.timings, currentTask?.writeStartedAt);
      const writeIndeterminate =
        failurePhase !== "current-read" &&
        isActivityLogMutationWriteIndeterminateError(error);

      console.error("[create-task][failed]", {
        taskId: task.taskId,
        taskType: task.taskType,
        operationKind: task.operationKind ?? null,
        formId: task.formId,
        entryId: task.entryId,
        workOrderNo: task.workOrderNo ?? null,
        queueKey: task.queueKey,
        clientMutationId: task.clientMutationId ?? null,
        actorClientId: task.actorClientId ?? null,
        actorTabId: task.actorTabId ?? null,
        actorIp: task.actorIp ?? null,
        actorLabel: task.actorLabel ?? null,
        createdAt: task.createdAt,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        lifecycleState: writeIndeterminate ? "indeterminate" : "failed",
        writeIndeterminate,
        failurePhase,
        timings: currentTask?.timings ?? { syncWaitMs },
        error: normalizedError,
      });

      this.updateTask(taskId, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        error: normalizedError,
        writeIndeterminate,
        timings: {
          ...(currentTask?.timings ?? { syncWaitMs }),
          failurePhase,
        },
      });
    }
  }

  private updateTask(taskId: string, patch: Partial<CreateReportTask>): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    const nextTask: CreateReportTask = {
      ...task,
      ...patch,
    };
    nextTask.lifecycleState = resolveMutationLifecycleState({
      status: nextTask.status,
      errorCode: nextTask.error?.code,
      writeIndeterminate: nextTask.writeIndeterminate,
    });
    if (nextTask.status === "success" && nextTask.timings?.failurePhase) {
      const { failurePhase: _failurePhase, ...successfulTimings } = nextTask.timings;
      nextTask.timings = successfulTimings;
    }
    if (
      patch.confirmedAt === undefined &&
      patch.finishedAt &&
      isConfirmedMutationLifecycleState(nextTask.lifecycleState)
    ) {
      nextTask.confirmedAt = patch.finishedAt;
    }
    if (
      nextTask.lifecycleState === "indeterminate" ||
      nextTask.lifecycleState === "unknown"
    ) {
      delete nextTask.confirmedAt;
    }

    this.tasks.set(taskId, nextTask);

    this.syncTaskToRegistry(this.tasks.get(taskId)!);
    this.pruneHistory();
    this.schedulePersist();
  }

  private markWaitingForSync(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    const waitingAt = new Date().toISOString();
    const syncWaitStartedAt = task.syncWaitStartedAt ?? waitingAt;
    this.updateTask(taskId, {
      status: "running",
      startedAt: task.startedAt ?? waitingAt,
      syncWaitStartedAt,
      timings: {
        ...(task.timings ?? { syncWaitMs: 0 }),
        syncWaitMs: Math.max(
          0,
          Date.parse(waitingAt) - Date.parse(syncWaitStartedAt)
        ),
      },
      updatedAt: waitingAt,
      runningMessage: "正在等待資料重新整理完成",
    });
  }

  private copyTask(task: CreateReportTask): CreateReportTask {
    const normalizedTask = this.normalizeTaskLifecycle(task);
    return {
      ...normalizedTask,
      result: normalizedTask.result
        ? {
            ...normalizedTask.result,
            ...(normalizedTask.result.confirmedEntry
              ? {
                  confirmedEntry: {
                    ...normalizedTask.result.confirmedEntry,
                    patch: { ...normalizedTask.result.confirmedEntry.patch },
                  },
                }
              : {}),
          }
        : undefined,
      timings: normalizedTask.timings ? { ...normalizedTask.timings } : undefined,
      error: normalizedTask.error ? { ...normalizedTask.error } : undefined,
    };
  }

  private normalizeTaskLifecycle(task: CreateReportTask): CreateReportTask {
    const lifecycleState =
      task.status === "failed" && task.scheduleMutationObservedAt
        ? "failed"
        : resolveMutationLifecycleState({
            status: task.status,
            errorCode: task.error?.code,
            writeIndeterminate: task.writeIndeterminate,
          });
    const normalized = {
      ...task,
      timings: task.timings ? { ...task.timings } : undefined,
      lifecycleState,
    };
    if (normalized.status === "success" && normalized.timings?.failurePhase) {
      delete normalized.timings.failurePhase;
    }
    if (lifecycleState === "indeterminate" || lifecycleState === "unknown") {
      delete normalized.confirmedAt;
    }
    return normalized;
  }

  private normalizeTaskResult(
    value: unknown,
    task: Pick<CreateReportTask, "formId" | "entryId" | "operationKind">
  ): CreateReportTaskResult {
    if (!value || typeof value !== "object") {
      return {};
    }
    const candidate = value as {
      rowId?: unknown;
      writeStartedAt?: unknown;
      mutationTimings?: unknown;
      confirmedEntry?: unknown;
    };
    const rowId = String(candidate.rowId ?? "").trim();
    const writeStartedAt =
      candidate.writeStartedAt === null || typeof candidate.writeStartedAt === "string"
        ? candidate.writeStartedAt
        : undefined;
    const normalizedMutationTimings = normalizeWorkReportMutationTimings(
      candidate.mutationTimings && typeof candidate.mutationTimings === "object"
        ? { ...candidate.mutationTimings, syncWaitMs: 0 }
        : candidate.mutationTimings
    );
    let mutationTimings: Partial<WorkReportMutationTimings> | undefined;
    if (normalizedMutationTimings) {
      const {
        syncWaitMs: _syncWaitMs,
        entryQueueWaitMs: _entryQueueWaitMs,
        failurePhase: _failurePhase,
        ...workerTimings
      } = normalizedMutationTimings;
      if (Object.keys(workerTimings).length > 0) {
        mutationTimings = workerTimings;
      }
    }
    const confirmedEntry = this.normalizeConfirmedEntryObservation(
      candidate.confirmedEntry,
      task
    );
    return {
      ...(rowId ? { rowId } : {}),
      ...(writeStartedAt !== undefined ? { writeStartedAt } : {}),
      ...(mutationTimings ? { mutationTimings } : {}),
      ...(confirmedEntry ? { confirmedEntry } : {}),
    };
  }

  private inferFailurePhase(
    timings: WorkReportMutationTimings | undefined,
    writeStartedAt: string | null | undefined
  ): WorkReportMutationFailurePhase {
    if ((timings?.verifyAttempts ?? 0) > 0 || (timings?.verifyMs ?? 0) > 0) {
      return "verify";
    }
    if (
      writeStartedAt ||
      (timings?.writeAttempts ?? 0) > 0 ||
      (timings?.writeMs ?? 0) > 0
    ) {
      return "write";
    }
    if (
      (timings?.currentReadAttempts ?? 0) > 0 ||
      (timings?.currentReadMs ?? 0) > 0
    ) {
      return "current-read";
    }
    return "unknown";
  }

  private normalizeConfirmedEntryObservation(
    value: unknown,
    task: Pick<CreateReportTask, "formId" | "entryId" | "operationKind">
  ): WorkReportConfirmedEntryFieldObservation | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const candidate = value as Partial<WorkReportConfirmedEntryFieldObservation>;
    const expectedOperation = this.resolveEntryFieldOperation(task.operationKind);
    const entryId = String(candidate.entryId ?? "").trim();
    const observedAt = String(candidate.observedAt ?? "").trim();
    const entryLastUpdatedAt = String(candidate.entryLastUpdatedAt ?? "").trim();
    if (
      !expectedOperation ||
      candidate.operation !== expectedOperation ||
      entryId !== task.entryId ||
      !observedAt ||
      Number.isNaN(Date.parse(observedAt)) ||
      (candidate.entryLastUpdatedAt !== undefined &&
        typeof candidate.entryLastUpdatedAt !== "string") ||
      !candidate.patch ||
      typeof candidate.patch !== "object" ||
      Array.isArray(candidate.patch)
    ) {
      return undefined;
    }

    const patch = candidate.patch as Record<string, unknown>;
    const expectedPatchKey =
      expectedOperation === "work-report-start-schedule"
        ? "startSchedule"
        : expectedOperation === "work-report-main-machine"
          ? task.formId === "902"
            ? "filterMachineCode"
            : "machineCode"
          : expectedOperation === "work-report-sort-order"
            ? "sortOrder"
            : expectedOperation === "work-report-planned-end-date"
              ? "plannedEndDate"
              : "urgent";
    if (
      !Object.prototype.hasOwnProperty.call(patch, expectedPatchKey) ||
      Object.keys(patch).some((key) => key !== expectedPatchKey) ||
      !this.isValidConfirmedPatchValue(expectedOperation, patch[expectedPatchKey])
    ) {
      return undefined;
    }

    return {
      entryId,
      operation: expectedOperation,
      observedAt,
      ...(entryLastUpdatedAt ? { entryLastUpdatedAt } : {}),
      patch: { [expectedPatchKey]: patch[expectedPatchKey] },
    };
  }

  private isValidConfirmedPatchValue(
    operation: WorkReportEntryFieldMutationOperation,
    value: unknown
  ): boolean {
    if (operation === "work-report-sort-order") {
      return typeof value === "number" && Number.isInteger(value) && value >= 0;
    }
    if (operation === "work-report-planned-end-date") {
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
    }
    if (operation === "work-report-main-machine") {
      return typeof value === "string" && value.trim().length > 0;
    }
    return value === "Yes" || value === "No";
  }

  private resolveEntryFieldOperation(
    operationKind: CreateReportTask["operationKind"]
  ): WorkReportEntryFieldMutationOperation | null {
    switch (operationKind) {
      case "update-start-schedule":
        return "work-report-start-schedule";
      case "update-main-machine":
        return "work-report-main-machine";
      case "update-sort-order":
        return "work-report-sort-order";
      case "update-planned-end-date":
        return "work-report-planned-end-date";
      case "update-urgent":
        return "work-report-urgent";
      default:
        return null;
    }
  }

  private async loadFromDisk(): Promise<void> {
    if (!env.CREATE_TASK_PERSIST_ENABLED) {
      return;
    }

    const filePath = this.resolveStoreFilePath();
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as TaskSnapshotPayload;
      if (!this.isValidSnapshotPayload(parsed)) {
        console.warn("[create-task][snapshot-invalid]", { filePath });
        return;
      }

      for (const task of parsed.tasks) {
        this.tasks.set(
          task.taskId,
          this.normalizeTaskLifecycle({
            ...task,
            taskType: task.taskType ?? "create-report",
          })
        );
        if (typeof task.clientMutationId === "string" && task.clientMutationId.trim()) {
          this.taskIdByClientMutationId.set(task.clientMutationId.trim(), task.taskId);
        }
      }

      const recoveredCount = this.recoverInterruptedTasks();
      await workReportTaskRegistryService.initialize();
      this.syncAllTasksToRegistry();
      this.pruneHistory();
      this.schedulePersist();
      console.info("[create-task][snapshot-loaded]", {
        filePath,
        count: parsed.tasks.length,
        recoveredCount,
      });
    } catch (error) {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError.code === "ENOENT") {
        return;
      }
      console.warn("[create-task][snapshot-load-failed]", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recoverInterruptedTasks(): number {
    const recoveredAt = new Date().toISOString();
    let recoveredCount = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status !== "pending" && task.status !== "running") {
        continue;
      }

      const writeIndeterminate = task.status === "running";
      const taskLabel = resolveTaskBaseMessage(task);
      recoveredCount += 1;
      const recoveredTask = this.normalizeTaskLifecycle({
        ...task,
        status: "failed",
        updatedAt: recoveredAt,
        finishedAt: recoveredAt,
        ...(writeIndeterminate ? {} : { confirmedAt: recoveredAt }),
        writeIndeterminate,
        error: {
          code: "TASK_RECOVERED_AFTER_RESTART",
          message: writeIndeterminate
            ? `服務重啟時${taskLabel}正在執行，Ragic 寫入結果尚未確認；請先重新整理確認，不可直接重送`
            : "服務重啟，原排隊任務尚未開始，已標記為失敗，請重新送出",
        },
      });
      this.tasks.set(taskId, recoveredTask);
    }

    if (recoveredCount > 0) {
      console.warn("[create-task][recovered-interrupted]", { recoveredCount });
    }

    return recoveredCount;
  }

  private pruneHistory(): void {
    const maxTasks = env.CREATE_TASK_HISTORY_LIMIT;
    if (this.tasks.size <= maxTasks) {
      return;
    }

    const completedTasks = Array.from(this.tasks.values())
      .filter(
        (task) =>
          (task.status === "success" || task.status === "failed") &&
          !isUnresolvedScheduleMutationTask(task)
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

    for (const task of completedTasks) {
      if (this.tasks.size <= maxTasks) {
        break;
      }
      this.tasks.delete(task.taskId);
      if (
        typeof task.clientMutationId === "string" &&
        task.clientMutationId.trim() &&
        this.taskIdByClientMutationId.get(task.clientMutationId.trim()) === task.taskId
      ) {
        this.taskIdByClientMutationId.delete(task.clientMutationId.trim());
      }
    }
  }

  private schedulePersist(): void {
    if (!env.CREATE_TASK_PERSIST_ENABLED) {
      return;
    }

    this.persistChain = this.persistChain
      .catch(() => {
        // NOTE: keep chain alive
      })
      .then(async () => {
        await this.persistToDisk();
      })
      .catch((error) => {
        console.warn("[create-task][snapshot-save-failed]", {
          filePath: this.resolveStoreFilePath(),
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async persistToDisk(): Promise<void> {
    const filePath = this.resolveStoreFilePath();
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true });

    const snapshot: TaskSnapshotPayload = {
      version: TASK_SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      tasks: Array.from(this.tasks.values())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((task) => this.copyTask(task)),
    };

    const tempFilePath = `${filePath}.tmp`;
    await fs.writeFile(tempFilePath, JSON.stringify(snapshot), "utf-8");
    await fs.rename(tempFilePath, filePath);
  }

  private resolveStoreFilePath(): string {
    return path.resolve(env.CREATE_TASK_STORE_FILE);
  }

  private syncTaskToRegistry(task: CreateReportTask): void {
    const taskType = task.taskType ?? "create-report";
    const baseMessage = resolveTaskBaseMessage(task);
    const message =
      task.status === "pending"
        ? `${baseMessage}排隊中`
        : task.status === "running"
          ? task.runningMessage ?? `${baseMessage}處理中`
          : task.status === "success"
            ? task.result?.rowId
              ? `${baseMessage}完成（rowId: ${task.result.rowId}）`
              : `${baseMessage}完成`
            : task.error?.message ?? `${baseMessage}失敗`;

    workReportTaskRegistryService.upsertTask({
      taskId: task.taskId,
      taskType,
      status: task.status,
      formId: task.formId,
      workOrderNo: task.workOrderNo ?? null,
      entryId: task.entryId,
      rowId: task.result?.rowId ?? null,
      queueKey: task.queueKey,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
      slotAcquiredAt: task.slotAcquiredAt ?? null,
      writeStartedAt: task.writeStartedAt ?? null,
      finishedAt: task.finishedAt ?? null,
      acceptedAt: task.acceptedAt ?? null,
      confirmedAt: task.confirmedAt ?? null,
      scheduleMutationObservedAt: task.scheduleMutationObservedAt ?? null,
      updatedAt: task.updatedAt,
      message,
      errorCode: task.error?.code ?? null,
      errorMessage: task.error?.message ?? null,
      writeIndeterminate: task.writeIndeterminate ?? null,
      actorClientId: task.actorClientId ?? null,
      actorTabId: task.actorTabId ?? null,
      actorIp: task.actorIp ?? null,
      actorLabel: task.actorLabel ?? null,
      operationKind: task.operationKind ?? null,
      timings: task.timings ?? { syncWaitMs: 0 },
    });
  }

  private syncAllTasksToRegistry(): void {
    for (const task of this.tasks.values()) {
      this.syncTaskToRegistry(task);
    }
  }

  private isValidSnapshotPayload(payload: unknown): payload is TaskSnapshotPayload {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    const maybeSnapshot = payload as Partial<TaskSnapshotPayload>;
    return (
      maybeSnapshot.version === TASK_SNAPSHOT_VERSION &&
      Array.isArray(maybeSnapshot.tasks) &&
      maybeSnapshot.tasks.every((task) => this.isValidTask(task))
    );
  }

  private isValidTask(task: unknown): task is CreateReportTask {
    if (!task || typeof task !== "object") {
      return false;
    }

    const t = task as Partial<CreateReportTask>;
    return (
      typeof t.taskId === "string" &&
      typeof t.formId === "string" &&
      typeof t.entryId === "string" &&
      typeof t.queueKey === "string" &&
      (t.taskType === undefined ||
        t.taskType === "create-report" ||
        t.taskType === "update-report" ||
        t.taskType === "update-downtime" ||
        t.taskType === "delete-downtime") &&
      (t.clientMutationId === undefined || typeof t.clientMutationId === "string") &&
      (t.operationFingerprint === undefined || typeof t.operationFingerprint === "string") &&
      (t.operationKind === undefined ||
        t.operationKind === "update-report-row" ||
        t.operationKind === "update-start-schedule" ||
        t.operationKind === "update-sort-order" ||
        t.operationKind === "update-urgent" ||
        t.operationKind === "update-main-machine" ||
        t.operationKind === "update-planned-end-date" ||
        t.operationKind === "close-work-order" ||
        t.operationKind === "reopen-work-order") &&
      (t.lifecycleState === undefined || isMutationLifecycleState(t.lifecycleState)) &&
      (t.acceptedAt === undefined || typeof t.acceptedAt === "string") &&
      (t.confirmedAt === undefined || typeof t.confirmedAt === "string") &&
      (t.syncWaitStartedAt === undefined || typeof t.syncWaitStartedAt === "string") &&
      (t.slotAcquiredAt === undefined || typeof t.slotAcquiredAt === "string") &&
      (t.writeStartedAt === undefined ||
        t.writeStartedAt === null ||
        typeof t.writeStartedAt === "string") &&
      (t.timings === undefined ||
        normalizeWorkReportMutationTimings(t.timings) !== undefined) &&
      (t.result === undefined ||
        (typeof t.result === "object" &&
          t.result !== null &&
          (t.result.rowId === undefined || typeof t.result.rowId === "string") &&
          (t.result.confirmedEntry === undefined ||
            this.normalizeConfirmedEntryObservation(t.result.confirmedEntry, {
              formId: t.formId ?? "",
              entryId: t.entryId ?? "",
              operationKind: t.operationKind,
            }) !== undefined))) &&
      (t.scheduleMutationObservedAt === undefined ||
        typeof t.scheduleMutationObservedAt === "string") &&
      (t.writeIndeterminate === undefined || typeof t.writeIndeterminate === "boolean") &&
      (t.actorClientId === undefined || typeof t.actorClientId === "string") &&
      (t.actorTabId === undefined || typeof t.actorTabId === "string") &&
      (t.actorIp === undefined || typeof t.actorIp === "string") &&
      (t.actorLabel === undefined || typeof t.actorLabel === "string") &&
      typeof t.status === "string" &&
      typeof t.createdAt === "string" &&
      typeof t.updatedAt === "string"
    );
  }
}

export const createReportTaskService = new CreateReportTaskService();
