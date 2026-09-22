import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { CircuitBreakerOpenError } from "../../infra/circuitBreaker";
import { isRagicRequestAdmissionError } from "../../infra/ragicRequestScheduler";
import { createLogger } from "../../observability/logger";
import { HttpError } from "../../utils/httpError";
import { batchCreateRowKeyRepository } from "../../storage/sqlite/batchCreateRowKeyRepository";
import { activityLogClientRowKeyRepository } from "../../storage/sqlite/activityLogClientRowKeyRepository";
import {
  inspectActivityLogEntryStored,
  type ActivityLogMismatch,
  type ActivityLogObservedCoreFields,
  type VerifyActivityLogEntryExpected,
  type VerifyActivityLogReadIndeterminatePayload,
} from "./activityLogWriteVerifier";
import {
  publishWorkReportFormUpdated,
  publishWorkReportUpdated,
} from "../../events/realtimeEventBus";
import { workReportMutationProjectionService } from "../work-report-sync/workReportMutationProjectionService";
import type { ProjectionApplyResult } from "../work-report-sync/workReportMutationProjectionServiceFactory";

const SNAPSHOT_VERSION = "v1";
const FAILED_HISTORY_LIMIT = 200;
const log = createLogger("activityLog-write-reverify");

export type ActivityLogWriteReverifyStatus = "pending" | "conflict" | "failed";

export interface ActivityLogWriteReverifyTask {
  key: string;
  source: string;
  activityLogPath: string;
  entryId: string;
  expected: VerifyActivityLogEntryExpected;
  rollbackPending?: boolean;
  status: ActivityLogWriteReverifyStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  deadlineAt?: string;
  finishedAt?: string;
  lastError?: string;
  lastErrorCode?: string;
  observed?: ActivityLogObservedCoreFields;
  mismatches?: ActivityLogMismatch[];
  observedAt?: string;
  workReportFormId?: string;
  workReportEntryId?: string;
  workOrderNo?: string;
  clientRowKey?: string;
  idempotencySource?: string;
  idempotencyReservationToken?: string;
}

interface ActivityLogWriteReverifySnapshot {
  version: string;
  savedAt: string;
  tasks: ActivityLogWriteReverifyTask[];
}

export interface EnqueueActivityLogWriteReverifyInput
  extends VerifyActivityLogReadIndeterminatePayload {
  source: string;
  workReportFormId?: string;
  workReportEntryId?: string;
  workOrderNo?: string;
  clientRowKey?: string;
  idempotencySource?: string;
  idempotencyReservationToken?: string;
}

export interface ActivityLogWriteReverifyServiceOptions {
  enabled?: boolean;
  storeFile?: string;
  maxAttempts?: number;
  maxPerRun?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxAgeMs?: number;
  deferDelayMs?: number;
  now?: () => number;
  /** entry 經 reverify 確認已不存在時清掉 idempotency 映射；預設依 source 對應 repo */
  invalidateIdempotencyOnEntryGone?: (task: ActivityLogWriteReverifyTask) => Promise<void>;
  /** entry 經 reverify 確認已不存在時，刷新對應工令投影與通知前端 */
  refreshWorkReportAfterEntryGone?: (task: ActivityLogWriteReverifyTask) => Promise<void>;
}

export interface ActivityLogWriteReverifyRunStats {
  scanned: number;
  verified: number;
  conflicted: number;
  failed: number;
  retryPending: number;
}

function resolveStoreFile(storeFile: string): string {
  return path.isAbsolute(storeFile) ? storeFile : path.resolve(process.cwd(), storeFile);
}

function taskKey(activityLogPath: string, entryId: string): string {
  return `${activityLogPath}::${entryId}`;
}

// reverify 以 authoritative read 確認 entry 已不存在後，依 create 來源清掉 mapping，
// 讓同 clientRowKey 可由人工流程重新建立。Mismatch 不屬於 gone，絕不走這裡。
async function defaultInvalidateIdempotencyOnEntryGone(
  task: ActivityLogWriteReverifyTask
): Promise<void> {
  if (task.source === "work-report-batch-create") {
    if (task.clientRowKey && task.idempotencyReservationToken && task.workReportFormId && task.workReportEntryId) {
      await batchCreateRowKeyRepository.deleteByReservationIdentity({
        clientRowKey: task.clientRowKey, reservationToken: task.idempotencyReservationToken,
        formId: task.workReportFormId, entryId: task.workReportEntryId, ragicRowId: task.entryId,
      });
      return;
    }
    await batchCreateRowKeyRepository.deleteByRagicRowId(task.entryId);
  } else if (task.source === "work-report-create" || task.source === "downtime") {
    if (task.clientRowKey && task.idempotencySource && task.idempotencyReservationToken) {
      await activityLogClientRowKeyRepository.deleteByReservationIdentity({
        clientRowKey: task.clientRowKey,
        source: task.idempotencySource,
        reservationToken: task.idempotencyReservationToken,
        entryId: task.entryId,
      });
      return;
    }
    await activityLogClientRowKeyRepository.deleteByEntryId(task.entryId);
  }
}

function shouldPublishAfterProjection(result: ProjectionApplyResult): boolean {
  return result === "applied" || result === "deleted";
}

async function defaultRefreshWorkReportAfterEntryGone(
  task: ActivityLogWriteReverifyTask
): Promise<void> {
  const formId = task.workReportFormId?.trim();
  const entryId = task.workReportEntryId?.trim();
  if (!formId || !entryId) {
    return;
  }

  const projectionSeq = await workReportMutationProjectionService.enqueueEntryAfterMutation(
    formId,
    entryId,
    "update"
  );
  if (projectionSeq <= 0) {
    publishWorkReportUpdated(formId, entryId);
    publishWorkReportFormUpdated(formId);
    return;
  }

  try {
    const result = await workReportMutationProjectionService.applyQueuedProjectionAfterMutation(
      formId,
      entryId,
      "update",
      projectionSeq
    );
    if (shouldPublishAfterProjection(result)) {
      publishWorkReportUpdated(formId, entryId);
      publishWorkReportFormUpdated(formId);
    }
  } catch (error) {
    log.error({
      event: "work-report-refresh-apply-failed",
      key: task.key,
      source: task.source,
      workReportFormId: formId,
      workReportEntryId: entryId,
      entryId: task.entryId,
      projectionSeq,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export class ActivityLogWriteReverifyService {
  private readonly tasks = new Map<string, ActivityLogWriteReverifyTask>();
  private readonly enabled: boolean;
  private readonly storeFile: string;
  private readonly maxAttempts: number;
  private readonly maxPerRun: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxAgeMs: number;
  private readonly deferDelayMs: number;
  private readonly now: () => number;
  private readonly invalidateIdempotencyOnEntryGone: (
    task: ActivityLogWriteReverifyTask
  ) => Promise<void>;
  private readonly refreshWorkReportAfterEntryGone: (
    task: ActivityLogWriteReverifyTask
  ) => Promise<void>;
  private initializedPromise: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private storeUnavailable = false;
  private runOncePromise: Promise<ActivityLogWriteReverifyRunStats> | null = null;

  constructor(options: ActivityLogWriteReverifyServiceOptions = {}) {
    this.enabled = options.enabled ?? env.ACTIVITY_LOG_WRITE_REVERIFY_ENABLED;
    this.storeFile = resolveStoreFile(
      options.storeFile ?? env.ACTIVITY_LOG_WRITE_REVERIFY_STORE_FILE
    );
    this.maxAttempts = Math.max(
      1,
      Math.trunc(options.maxAttempts ?? env.ACTIVITY_LOG_WRITE_REVERIFY_MAX_ATTEMPTS)
    );
    this.maxPerRun = Math.max(
      1,
      Math.trunc(options.maxPerRun ?? env.ACTIVITY_LOG_WRITE_REVERIFY_MAX_PER_RUN)
    );
    this.timeoutMs = Math.max(
      1_000,
      Math.trunc(options.timeoutMs ?? env.ACTIVITY_LOG_WRITE_REVERIFY_TIMEOUT_MS)
    );
    this.maxRetries = Math.max(
      0,
      Math.trunc(options.maxRetries ?? env.ACTIVITY_LOG_WRITE_REVERIFY_MAX_RETRIES)
    );
    this.maxAgeMs = Math.max(
      60_000,
      Math.trunc(options.maxAgeMs ?? env.ACTIVITY_LOG_WRITE_REVERIFY_MAX_AGE_MS)
    );
    this.deferDelayMs = Math.max(
      1_000,
      Math.trunc(options.deferDelayMs ?? env.ACTIVITY_LOG_WRITE_REVERIFY_INTERVAL_MS)
    );
    this.now = options.now ?? Date.now;
    this.invalidateIdempotencyOnEntryGone =
      options.invalidateIdempotencyOnEntryGone ?? defaultInvalidateIdempotencyOnEntryGone;
    this.refreshWorkReportAfterEntryGone =
      options.refreshWorkReportAfterEntryGone ?? defaultRefreshWorkReportAfterEntryGone;
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return;
    if (this.initializedPromise) {
      await this.initializedPromise;
      return;
    }
    this.initializedPromise = this.loadFromDisk();
    await this.initializedPromise;
  }

  async enqueue(input: EnqueueActivityLogWriteReverifyInput): Promise<ActivityLogWriteReverifyTask | null> {
    if (!this.enabled) return null;
    await this.initialize();

    const key = taskKey(input.activityLogPath, input.entryId);
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const existing = this.tasks.get(key);
    const task: ActivityLogWriteReverifyTask = {
      key,
      source: input.source,
      activityLogPath: input.activityLogPath,
      entryId: input.entryId,
      expected: input.expected,
      ...(input.rollbackPending ? { rollbackPending: true } : {}),
      status: "pending",
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? input.occurredAt,
      updatedAt: now,
      deadlineAt: existing?.deadlineAt ?? new Date(nowMs + this.maxAgeMs).toISOString(),
      lastError: input.errorMessage,
      ...(input.workReportFormId ? { workReportFormId: input.workReportFormId } : {}),
      ...(input.workReportEntryId ? { workReportEntryId: input.workReportEntryId } : {}),
      ...(input.workOrderNo ? { workOrderNo: input.workOrderNo } : {}),
      ...(input.clientRowKey ? { clientRowKey: input.clientRowKey } : {}),
      ...(input.idempotencySource ? { idempotencySource: input.idempotencySource } : {}),
      ...(input.idempotencyReservationToken
        ? { idempotencyReservationToken: input.idempotencyReservationToken }
        : {}),
    };
    this.tasks.set(key, task);
    this.schedulePersist();
    await this.flush();
    log.warn({
      event: "queued",
      key,
      source: input.source,
      activityLogPath: input.activityLogPath,
      entryId: input.entryId,
      attempts: task.attempts,
      error: input.errorMessage,
    });
    return { ...task };
  }

  async runOnce(): Promise<ActivityLogWriteReverifyRunStats> {
    if (this.runOncePromise) {
      return this.runOncePromise;
    }
    this.runOncePromise = this.runOnceInternal().finally(() => {
      this.runOncePromise = null;
    });
    return this.runOncePromise;
  }

  private async runOnceInternal(): Promise<ActivityLogWriteReverifyRunStats> {
    if (!this.enabled) {
      return { scanned: 0, verified: 0, conflicted: 0, failed: 0, retryPending: 0 };
    }
    await this.initialize();

    const pending = [...this.tasks.values()]
      .filter((task) => task.status === "pending" && this.isTaskDue(task))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, this.maxPerRun);

    const stats: ActivityLogWriteReverifyRunStats = {
      scanned: pending.length,
      verified: 0,
      conflicted: 0,
      failed: 0,
      retryPending: 0,
    };

    for (const task of pending) {
      const result = await this.verifyTask(task);
      stats[result] += 1;
    }

    if (pending.length > 0) {
      this.pruneFailedHistory();
      this.schedulePersist();
      await this.flush();
    }
    return stats;
  }

  async flush(): Promise<void> {
    await this.persistChain;
  }

  async listTasks(
    status?: ActivityLogWriteReverifyStatus,
    limit = 100
  ): Promise<ActivityLogWriteReverifyTask[]> {
    if (!this.enabled) return [];
    await this.initialize();

    const normalizedLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    return [...this.tasks.values()]
      .filter((task) => !status || task.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, normalizedLimit)
      .map((task) => ({
        ...task,
        expected: { ...task.expected },
        ...(task.observed ? { observed: { ...task.observed } } : {}),
        ...(task.mismatches
          ? { mismatches: task.mismatches.map((mismatch) => ({ ...mismatch })) }
          : {}),
      }));
  }

  async retryTask(key: string): Promise<ActivityLogWriteReverifyTask> {
    if (!this.enabled) {
      throw new HttpError(
        503,
        "ActivityLog 寫入補驗功能目前未啟用",
        "ACTIVITY_LOG_WRITE_REVERIFY_DISABLED"
      );
    }
    await this.initialize();

    const task = this.tasks.get(key);
    if (!task) {
      throw new HttpError(
        404,
        "找不到指定的 ActivityLog 補驗任務",
        "ACTIVITY_LOG_WRITE_REVERIFY_NOT_FOUND"
      );
    }
    if (task.status === "pending") {
      throw new HttpError(
        409,
        "這筆 ActivityLog 補驗任務已在等待處理",
        "ACTIVITY_LOG_WRITE_REVERIFY_NOT_RETRYABLE"
      );
    }

    const nowMs = this.now();
    task.status = "pending";
    task.attempts = 0;
    task.updatedAt = new Date(nowMs).toISOString();
    task.deadlineAt = new Date(nowMs + this.maxAgeMs).toISOString();
    delete task.lastAttemptAt;
    delete task.nextAttemptAt;
    delete task.finishedAt;
    delete task.lastErrorCode;
    delete task.observed;
    delete task.mismatches;
    delete task.observedAt;
    this.schedulePersist();
    await this.flush();

    log.warn({
      event: "manual-retry-queued",
      key: task.key,
      source: task.source,
      activityLogPath: task.activityLogPath,
      entryId: task.entryId,
    });
    return { ...task, expected: { ...task.expected } };
  }

  getStats(): { pending: number; conflict: number; failed: number; total: number; storeUnavailable?: boolean } {
    let pending = 0;
    let conflict = 0;
    let failed = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "pending") pending += 1;
      if (task.status === "conflict") conflict += 1;
      if (task.status === "failed") failed += 1;
    }
    return { pending, conflict, failed, total: this.tasks.size,
      ...(this.storeUnavailable ? { storeUnavailable: true } : {}) };
  }

  private async verifyTask(
    task: ActivityLogWriteReverifyTask
  ): Promise<"verified" | "conflicted" | "failed" | "retryPending"> {
    const startedAtMs = this.now();
    if (this.isDeadlineElapsed(task, startedAtMs)) {
      this.markFailed(
        task,
        "ACTIVITY_LOG_WRITE_REVERIFY_DEADLINE_EXCEEDED",
        "ActivityLog 補驗已超過 durable deadline，需人工確認。",
        startedAtMs
      );
      return "failed";
    }

    let admittedAttempts = 0;
    try {
      const observation = await inspectActivityLogEntryStored(
        task.activityLogPath,
        task.entryId,
        task.expected,
        {
          readPriority: "background",
          timeoutMs: this.timeoutMs,
          maxRetries: this.maxRetries,
          onAttemptTiming: (timing) => {
            if (timing.requestStarted) admittedAttempts += 1;
          },
        }
      );
      this.recordObservationAttempts(task, Math.max(1, admittedAttempts), this.now());
      delete task.nextAttemptAt;

      if (task.rollbackPending && observation.kind === "confirmed") {
        task.status = "conflict";
        task.lastErrorCode = "RAGIC_WRITE_ROLLBACK_UNCONFIRMED";
        task.lastError = "回滾後 entry 仍存在，需人工確認；不得自動重建或再次刪除。";
        task.observedAt = new Date(this.now()).toISOString();
        task.finishedAt = task.observedAt;
        task.updatedAt = task.observedAt;
        return "conflicted";
      }
      if (observation.kind === "confirmed") {
        this.tasks.delete(task.key);
        log.info({
          event: "verified",
          key: task.key,
          activityLogPath: task.activityLogPath,
          entryId: task.entryId,
          attempts: task.attempts,
        });
        return "verified";
      }

      if (observation.kind === "mismatch") {
        const observedAt = new Date(this.now()).toISOString();
        task.status = "conflict";
        task.observed = { ...observation.observed };
        task.mismatches = observation.mismatches.map((mismatch) => ({ ...mismatch }));
        task.observedAt = observedAt;
        task.updatedAt = observedAt;
        task.finishedAt = observedAt;
        task.lastErrorCode = "ACTIVITY_LOG_WRITE_REVERIFY_CONFLICT";
        task.lastError = observation.mismatches
          .map(
            (mismatch) =>
              `${mismatch.field}: expected="${mismatch.expected}" actual="${mismatch.actual}"`
          )
          .join("; ");
        log.error({
          event: "conflict",
          key: task.key,
          activityLogPath: task.activityLogPath,
          entryId: task.entryId,
          attempts: task.attempts,
          observed: task.observed,
          mismatches: task.mismatches,
        });
        return "conflicted";
      }

      task.lastErrorCode = "RAGIC_WRITE_GONE";
      task.lastError = `activity log 補驗確認 entry ${task.entryId} 已不存在`;
      task.updatedAt = new Date(this.now()).toISOString();
      await this.invalidateMappingForGoneEntry(task);
      const refreshQueued = await this.refreshWorkReportForGoneEntry(task);
      if (!refreshQueued) {
        task.nextAttemptAt = new Date(this.now() + this.deferDelayMs).toISOString();
        return "retryPending";
      }
      this.markFailed(task, "RAGIC_WRITE_GONE", task.lastError, this.now());
      return "failed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = this.resolveErrorCode(error);
      const failedAtMs = this.now();
      task.lastError = message;
      task.lastErrorCode = code;
      task.updatedAt = new Date(failedAtMs).toISOString();

      if (admittedAttempts === 0 && isRagicRequestAdmissionError(error)) {
        const retryAfterMs =
          error instanceof CircuitBreakerOpenError
            ? Math.max(1_000, error.retryAfterMs)
            : this.deferDelayMs;
        task.nextAttemptAt = new Date(failedAtMs + retryAfterMs).toISOString();
        if (this.isDeadlineElapsed(task, failedAtMs)) {
          this.markFailed(
            task,
            "ACTIVITY_LOG_WRITE_REVERIFY_DEADLINE_EXCEEDED",
            message,
            failedAtMs
          );
          return "failed";
        }
        log.warn({
          event: "deferred",
          key: task.key,
          activityLogPath: task.activityLogPath,
          entryId: task.entryId,
          attempts: task.attempts,
          lastErrorCode: code,
          nextAttemptAt: task.nextAttemptAt,
        });
        return "retryPending";
      }

      this.recordObservationAttempts(task, Math.max(1, admittedAttempts), failedAtMs);
      if (task.attempts >= this.maxAttempts || this.isDeadlineElapsed(task, failedAtMs)) {
        this.markFailed(task, code ?? "ACTIVITY_LOG_WRITE_REVERIFY_READ_FAILED", message, failedAtMs);
        return "failed";
      }

      task.nextAttemptAt = new Date(failedAtMs + this.deferDelayMs).toISOString();
      log.warn({
        event: "retry-pending",
        key: task.key,
        activityLogPath: task.activityLogPath,
        entryId: task.entryId,
        attempts: task.attempts,
        maxAttempts: this.maxAttempts,
        lastErrorCode: code,
        nextAttemptAt: task.nextAttemptAt,
        error: message,
      });
      return "retryPending";
    }
  }

  private isTaskDue(task: ActivityLogWriteReverifyTask): boolean {
    if (!task.nextAttemptAt) return true;
    const nextAttemptAtMs = Date.parse(task.nextAttemptAt);
    return !Number.isFinite(nextAttemptAtMs) || nextAttemptAtMs <= this.now();
  }

  private isDeadlineElapsed(task: ActivityLogWriteReverifyTask, nowMs: number): boolean {
    const deadlineAtMs = Date.parse(task.deadlineAt ?? "");
    return Number.isFinite(deadlineAtMs) && nowMs >= deadlineAtMs;
  }

  private recordObservationAttempts(
    task: ActivityLogWriteReverifyTask,
    count: number,
    attemptedAtMs: number
  ): void {
    task.attempts += Math.max(1, Math.trunc(count));
    const attemptedAt = new Date(attemptedAtMs).toISOString();
    task.lastAttemptAt = attemptedAt;
    task.updatedAt = attemptedAt;
  }

  private resolveErrorCode(error: unknown): string | undefined {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
    ) {
      return error.code;
    }
    return undefined;
  }

  private markFailed(
    task: ActivityLogWriteReverifyTask,
    code: string,
    message: string,
    failedAtMs: number
  ): void {
    const failedAt = new Date(failedAtMs).toISOString();
    task.status = "failed";
    task.updatedAt = failedAt;
    task.finishedAt = failedAt;
    task.lastErrorCode = code;
    task.lastError = message;
    delete task.nextAttemptAt;
    log.error({
      event: "failed",
      key: task.key,
      activityLogPath: task.activityLogPath,
      entryId: task.entryId,
      attempts: task.attempts,
      terminalCode: code,
      error: message,
    });
  }

  private async invalidateMappingForGoneEntry(
    task: ActivityLogWriteReverifyTask
  ): Promise<void> {
    try {
      await this.invalidateIdempotencyOnEntryGone(task);
      log.warn({
        event: "idempotency-invalidated",
        key: task.key,
        source: task.source,
        entryId: task.entryId,
      });
    } catch (error) {
      // 清映射失敗只 log，不讓它打斷整輪 reverify；映射最終仍會被 6h cleanup 清掉
      log.error({
        event: "idempotency-invalidate-failed",
        key: task.key,
        source: task.source,
        entryId: task.entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async refreshWorkReportForGoneEntry(
    task: ActivityLogWriteReverifyTask
  ): Promise<boolean> {
    if (!task.workReportFormId?.trim() || !task.workReportEntryId?.trim()) {
      return true;
    }

    try {
      await this.refreshWorkReportAfterEntryGone(task);
      log.warn({
        event: "work-report-refresh-enqueued",
        key: task.key,
        source: task.source,
        workReportFormId: task.workReportFormId ?? null,
        workReportEntryId: task.workReportEntryId ?? null,
        entryId: task.entryId,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      task.lastError = `work-report-refresh-failed: ${message}`;
      task.updatedAt = new Date(this.now()).toISOString();
      log.error({
        event: "work-report-refresh-failed",
        key: task.key,
        source: task.source,
        workReportFormId: task.workReportFormId ?? null,
        workReportEntryId: task.workReportEntryId ?? null,
        entryId: task.entryId,
        error: message,
      });
      return false;
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storeFile, "utf-8");
      const payload = JSON.parse(raw) as Partial<ActivityLogWriteReverifySnapshot>;
      if (payload?.version !== SNAPSHOT_VERSION || !Array.isArray(payload.tasks)) {
        throw new Error("Invalid ActivityLog reverify snapshot");
      }
      const tasks = payload.tasks;
      if (tasks.some(task => !task || typeof task.key !== "string" ||
        !task.activityLogPath || !task.entryId || !task.expected ||
        !["pending", "conflict", "failed"].includes(task.status))) {
        throw new Error("Invalid ActivityLog reverify task");
      }
      let migrated = false;
      for (const task of tasks) {
        const hydrated: ActivityLogWriteReverifyTask = {
          ...task,
          expected: { ...task.expected },
          ...(task.observed ? { observed: { ...task.observed } } : {}),
          ...(task.mismatches
            ? { mismatches: task.mismatches.map((mismatch) => ({ ...mismatch })) }
            : {}),
        };
        if (hydrated.status === "pending" && !hydrated.deadlineAt) {
          hydrated.deadlineAt = new Date(this.now() + this.maxAgeMs).toISOString();
          migrated = true;
        }
        this.tasks.set(hydrated.key, hydrated);
      }
      log.info({ event: "loaded", total: this.tasks.size, storeFile: this.storeFile });
      if (migrated) {
        this.schedulePersist();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.storeUnavailable = true;
        log.warn({
          event: "load-failed",
          storeFile: this.storeFile,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  private schedulePersist(): void {
    if (!this.enabled) return;
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.persistToDisk())
      .catch((error) => {
        this.storeUnavailable = true;
        log.error({
          event: "persist-failed",
          storeFile: this.storeFile,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
    void this.persistChain.catch(() => undefined);
  }

  private async persistToDisk(): Promise<void> {
    await fs.mkdir(path.dirname(this.storeFile), { recursive: true });
    const payload: ActivityLogWriteReverifySnapshot = {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      tasks: [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
    const tempFile = `${this.storeFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempFile, JSON.stringify(payload, null, 2), { encoding: "utf-8", flush: true });
      await fs.rename(tempFile, this.storeFile);
      this.storeUnavailable = false;
    } finally {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
    }
  }

  private pruneFailedHistory(): void {
    const failed = [...this.tasks.values()]
      .filter((task) => task.status === "failed")
      .sort((a, b) => (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt));
    for (const task of failed.slice(FAILED_HISTORY_LIMIT)) {
      this.tasks.delete(task.key);
    }
  }
}

export const activityLogWriteReverifyService = new ActivityLogWriteReverifyService();
