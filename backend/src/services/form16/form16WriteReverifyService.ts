import fs from "fs/promises";
import path from "path";
import { env } from "../../config/env";
import { createLogger } from "../../observability/logger";
import { HttpError } from "../../utils/httpError";
import { batchCreateRowKeyRepository } from "../../storage/sqlite/batchCreateRowKeyRepository";
import { form16ClientRowKeyRepository } from "../../storage/sqlite/form16ClientRowKeyRepository";
import {
  assertForm16EntryStored,
  type VerifyForm16EntryExpected,
  type VerifyForm16ReadIndeterminatePayload,
} from "./form16WriteVerifier";
import {
  publishWorkReportFormUpdated,
  publishWorkReportUpdated,
} from "../../events/realtimeEventBus";
import { workReportMutationProjectionService } from "../work-report-sync/workReportMutationProjectionService";
import type { ProjectionApplyResult } from "../work-report-sync/workReportMutationProjectionServiceFactory";

const SNAPSHOT_VERSION = "v1";
const FAILED_HISTORY_LIMIT = 200;
const log = createLogger("form16-write-reverify");
const ENTRY_GONE_CODES = new Set([
  "RAGIC_WRITE_GONE",
  "RAGIC_WRITE_ROLLBACK_DELETED",
]);

export type Form16WriteReverifyStatus = "pending" | "failed";

export interface Form16WriteReverifyTask {
  key: string;
  source: string;
  form16Path: string;
  entryId: string;
  expected: VerifyForm16EntryExpected;
  status: Form16WriteReverifyStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  finishedAt?: string;
  lastError?: string;
  workReportFormId?: string;
  workReportEntryId?: string;
  workOrderNo?: string;
}

interface Form16WriteReverifySnapshot {
  version: string;
  savedAt: string;
  tasks: Form16WriteReverifyTask[];
}

export interface EnqueueForm16WriteReverifyInput
  extends VerifyForm16ReadIndeterminatePayload {
  source: string;
  workReportFormId?: string;
  workReportEntryId?: string;
  workOrderNo?: string;
}

export interface Form16WriteReverifyServiceOptions {
  enabled?: boolean;
  storeFile?: string;
  maxAttempts?: number;
  maxPerRun?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** entry 經 reverify 確認已不存在時清掉 idempotency 映射；預設依 source 對應 repo */
  invalidateIdempotencyOnEntryGone?: (task: Form16WriteReverifyTask) => Promise<void>;
  /** entry 經 reverify 確認已不存在時，刷新對應工令投影與通知前端 */
  refreshWorkReportAfterEntryGone?: (task: Form16WriteReverifyTask) => Promise<void>;
}

export interface Form16WriteReverifyRunStats {
  scanned: number;
  verified: number;
  failed: number;
  retryPending: number;
}

function resolveStoreFile(storeFile: string): string {
  return path.isAbsolute(storeFile) ? storeFile : path.resolve(process.cwd(), storeFile);
}

function taskKey(form16Path: string, entryId: string): string {
  return `${form16Path}::${entryId}`;
}

// reverify 確認 entry 已不存在（mismatch 回滾刪除成功 / 讀回 null）後，
// 依當初 create 的來源清掉對應的 idempotency 映射，讓同 clientRowKey 重試能重新建立。
// task.entryId 就是被刪的 Form16 rowId：批次表存在 ragic_row_id、單筆表存在 entry_id。
async function defaultInvalidateIdempotencyOnEntryGone(
  task: Form16WriteReverifyTask
): Promise<void> {
  if (task.source === "work-report-batch-create") {
    await batchCreateRowKeyRepository.deleteByRagicRowId(task.entryId);
  } else if (task.source === "work-report-create" || task.source === "downtime") {
    await form16ClientRowKeyRepository.deleteByEntryId(task.entryId);
  }
}

function shouldPublishAfterProjection(result: ProjectionApplyResult): boolean {
  return result === "applied" || result === "deleted";
}

async function defaultRefreshWorkReportAfterEntryGone(
  task: Form16WriteReverifyTask
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

export class Form16WriteReverifyService {
  private readonly tasks = new Map<string, Form16WriteReverifyTask>();
  private readonly enabled: boolean;
  private readonly storeFile: string;
  private readonly maxAttempts: number;
  private readonly maxPerRun: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly invalidateIdempotencyOnEntryGone: (
    task: Form16WriteReverifyTask
  ) => Promise<void>;
  private readonly refreshWorkReportAfterEntryGone: (
    task: Form16WriteReverifyTask
  ) => Promise<void>;
  private initializedPromise: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private runOncePromise: Promise<Form16WriteReverifyRunStats> | null = null;

  constructor(options: Form16WriteReverifyServiceOptions = {}) {
    this.enabled = options.enabled ?? env.FORM16_WRITE_REVERIFY_ENABLED;
    this.storeFile = resolveStoreFile(
      options.storeFile ?? env.FORM16_WRITE_REVERIFY_STORE_FILE
    );
    this.maxAttempts = Math.max(
      1,
      Math.trunc(options.maxAttempts ?? env.FORM16_WRITE_REVERIFY_MAX_ATTEMPTS)
    );
    this.maxPerRun = Math.max(
      1,
      Math.trunc(options.maxPerRun ?? env.FORM16_WRITE_REVERIFY_MAX_PER_RUN)
    );
    this.timeoutMs = Math.max(
      1_000,
      Math.trunc(options.timeoutMs ?? env.FORM16_WRITE_REVERIFY_TIMEOUT_MS)
    );
    this.maxRetries = Math.max(
      0,
      Math.trunc(options.maxRetries ?? env.FORM16_WRITE_REVERIFY_MAX_RETRIES)
    );
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

  async enqueue(input: EnqueueForm16WriteReverifyInput): Promise<Form16WriteReverifyTask | null> {
    if (!this.enabled) return null;
    await this.initialize();

    const key = taskKey(input.form16Path, input.entryId);
    const now = new Date().toISOString();
    const existing = this.tasks.get(key);
    const task: Form16WriteReverifyTask = {
      key,
      source: input.source,
      form16Path: input.form16Path,
      entryId: input.entryId,
      expected: input.expected,
      status: "pending",
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? input.occurredAt,
      updatedAt: now,
      lastError: input.errorMessage,
      ...(input.workReportFormId ? { workReportFormId: input.workReportFormId } : {}),
      ...(input.workReportEntryId ? { workReportEntryId: input.workReportEntryId } : {}),
      ...(input.workOrderNo ? { workOrderNo: input.workOrderNo } : {}),
    };
    this.tasks.set(key, task);
    this.schedulePersist();
    log.warn({
      event: "queued",
      key,
      source: input.source,
      form16Path: input.form16Path,
      entryId: input.entryId,
      attempts: task.attempts,
      error: input.errorMessage,
    });
    return { ...task };
  }

  async runOnce(): Promise<Form16WriteReverifyRunStats> {
    if (this.runOncePromise) {
      return this.runOncePromise;
    }
    this.runOncePromise = this.runOnceInternal().finally(() => {
      this.runOncePromise = null;
    });
    return this.runOncePromise;
  }

  private async runOnceInternal(): Promise<Form16WriteReverifyRunStats> {
    if (!this.enabled) {
      return { scanned: 0, verified: 0, failed: 0, retryPending: 0 };
    }
    await this.initialize();

    const pending = [...this.tasks.values()]
      .filter((task) => task.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, this.maxPerRun);

    const stats: Form16WriteReverifyRunStats = {
      scanned: pending.length,
      verified: 0,
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

  getStats(): { pending: number; failed: number; total: number } {
    let pending = 0;
    let failed = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "pending") pending += 1;
      if (task.status === "failed") failed += 1;
    }
    return { pending, failed, total: this.tasks.size };
  }

  private async verifyTask(
    task: Form16WriteReverifyTask
  ): Promise<"verified" | "failed" | "retryPending"> {
    const attemptAt = new Date().toISOString();
    task.attempts += 1;
    task.lastAttemptAt = attemptAt;
    task.updatedAt = attemptAt;

    try {
      await assertForm16EntryStored(task.form16Path, task.entryId, task.expected, {
        readPriority: "background",
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
      });
      this.tasks.delete(task.key);
      log.info({
        event: "verified",
        key: task.key,
        form16Path: task.form16Path,
        entryId: task.entryId,
        attempts: task.attempts,
      });
      return "verified";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof HttpError && typeof error.code === "string" ? error.code : undefined;
      const entryGone = code !== undefined && ENTRY_GONE_CODES.has(code);
      const isTerminal = entryGone || task.attempts >= this.maxAttempts;
      task.lastError = message;
      task.updatedAt = new Date().toISOString();

      if (isTerminal) {
        // 只有讀回 null 或 rollback delete 成功，才代表 entry 已確認不存在。
        // → 清映射讓重試重建。maxAttempts 耗盡屬「狀態未知」，entry 可能還在，不能清
        // （清了會讓重試重複開單）。
        if (entryGone) {
          await this.invalidateMappingForGoneEntry(task);
          const refreshQueued = await this.refreshWorkReportForGoneEntry(task);
          if (!refreshQueued) {
            log.warn({
              event: "retry-pending",
              key: task.key,
              form16Path: task.form16Path,
              entryId: task.entryId,
              attempts: task.attempts,
              maxAttempts: this.maxAttempts,
              terminalCode: code ?? null,
              reason: "work-report-refresh-failed",
            });
            return "retryPending";
          }
        }
        task.status = "failed";
        task.finishedAt = task.updatedAt;
        log.error({
          event: "failed",
          key: task.key,
          form16Path: task.form16Path,
          entryId: task.entryId,
          attempts: task.attempts,
          terminalCode: code ?? null,
          error: message,
        });
        return "failed";
      }

      log.warn({
        event: "retry-pending",
        key: task.key,
        form16Path: task.form16Path,
        entryId: task.entryId,
        attempts: task.attempts,
        maxAttempts: this.maxAttempts,
        error: message,
      });
      return "retryPending";
    }
  }

  private async invalidateMappingForGoneEntry(
    task: Form16WriteReverifyTask
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
    task: Form16WriteReverifyTask
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
      task.updatedAt = new Date().toISOString();
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
      const payload = JSON.parse(raw) as Partial<Form16WriteReverifySnapshot>;
      const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      for (const task of tasks) {
        if (!task || typeof task.key !== "string") continue;
        if (task.status !== "pending" && task.status !== "failed") continue;
        this.tasks.set(task.key, task);
      }
      log.info({ event: "loaded", total: this.tasks.size, storeFile: this.storeFile });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn({
          event: "load-failed",
          storeFile: this.storeFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private schedulePersist(): void {
    if (!this.enabled) return;
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.persistToDisk())
      .catch((error) => {
        log.error({
          event: "persist-failed",
          storeFile: this.storeFile,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async persistToDisk(): Promise<void> {
    await fs.mkdir(path.dirname(this.storeFile), { recursive: true });
    const payload: Form16WriteReverifySnapshot = {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      tasks: [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
    await fs.writeFile(this.storeFile, JSON.stringify(payload, null, 2), "utf-8");
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

export const form16WriteReverifyService = new Form16WriteReverifyService();
