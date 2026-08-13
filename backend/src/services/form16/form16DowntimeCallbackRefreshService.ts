import { randomUUID } from "crypto";
import { env } from "../../config/env";
import {
  createKeyedSerialQueue,
  KeyedSerialQueueClosedError,
  type KeyedSerialQueueStats,
} from "../../utils/keyedSerialQueue";
import { HttpError } from "../../utils/httpError";
import type { RagicCallbackEventType } from "../ragicCallbackRefreshServiceFactory";
import {
  workReportTaskRegistryService,
  type WorkReportQueueTaskRecord,
} from "../work-report/workReportTaskRegistryService";
import { form16DowntimeService } from "./form16DowntimeService";

type Form16CallbackTaskStatus = "pending" | "running" | "success" | "failed";

interface Form16CallbackTask {
  taskId: string;
  entryId: string;
  eventType: RagicCallbackEventType;
  source?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  status: Form16CallbackTaskStatus;
  errorMessage?: string;
}

interface Form16DowntimeCallbackRefreshServiceDeps {
  delayMs: number;
  refreshEntrySnapshotFromRagic: (entryId: string) => Promise<unknown>;
  registry: {
    initialize: () => Promise<void>;
    listTasksForReplay: (
      options: Parameters<typeof workReportTaskRegistryService.listTasksForReplay>[0]
    ) => WorkReportQueueTaskRecord[];
    upsertTask: (
      input: Parameters<typeof workReportTaskRegistryService.upsertTask>[0]
    ) => WorkReportQueueTaskRecord;
  };
}

export class Form16DowntimeCallbackRefreshService {
  private readonly tasks = new Map<string, Form16CallbackTask>();
  private readonly queueChainByEntryKey = createKeyedSerialQueue();
  private initializedPromise: Promise<void> | null = null;

  constructor(
    private readonly deps: Form16DowntimeCallbackRefreshServiceDeps = {
      delayMs: env.RAGIC_CALLBACK_DELAY_MS,
      refreshEntrySnapshotFromRagic: (entryId) =>
        form16DowntimeService.refreshEntrySnapshotFromRagic(entryId),
      registry: workReportTaskRegistryService,
    }
  ) {}

  async initialize(): Promise<void> {
    if (this.initializedPromise) {
      await this.initializedPromise;
      return;
    }

    const initialization = (async () => {
      await this.deps.registry.initialize();
      const interruptedTasks = this.deps.registry
        .listTasksForReplay({
          formId: "16",
          taskType: "callback-refresh",
          errorCode: "TASK_REGISTRY_RECOVERED_AFTER_RESTART",
        })
        .filter(
          (task) => /^\d+$/.test(String(task.entryId ?? "").trim())
        );

      for (const interruptedTask of interruptedTasks) {
        const replayTask = this.enqueue({
          entryId: interruptedTask.entryId!,
          eventType: "entry-updated",
          source: "ragic-callback-16-recovered",
          ...(interruptedTask.actorIp ? { actorIp: interruptedTask.actorIp } : {}),
          ...(interruptedTask.actorLabel
            ? { actorLabel: interruptedTask.actorLabel }
            : {}),
        });
        const replayScheduledAt = new Date().toISOString();
        this.deps.registry.upsertTask({
          taskId: interruptedTask.taskId,
          taskType: "callback-refresh",
          status: "failed",
          formId: "16",
          entryId: interruptedTask.entryId,
          rowId: interruptedTask.rowId,
          queueKey: interruptedTask.queueKey,
          createdAt: interruptedTask.createdAt,
          startedAt: interruptedTask.startedAt,
          finishedAt: interruptedTask.finishedAt,
          updatedAt: replayScheduledAt,
          message: `服務重啟後已重新排入 Form 16 callback refresh（${replayTask.taskId}）`,
          errorCode: "FORM16_CALLBACK_REPLAY_SCHEDULED",
          errorMessage: null,
          actorClientId: interruptedTask.actorClientId,
          actorTabId: interruptedTask.actorTabId,
          actorIp: interruptedTask.actorIp,
          actorLabel: interruptedTask.actorLabel,
          source: interruptedTask.source,
        });
      }
    })();

    this.initializedPromise = initialization;
    try {
      await initialization;
    } catch (error) {
      this.initializedPromise = null;
      throw error;
    }
  }

  closeAdmission(): void {
    this.queueChainByEntryKey.closeAdmission();
  }

  drain(): Promise<void> {
    return this.queueChainByEntryKey.drain();
  }

  getQueueStats(): KeyedSerialQueueStats {
    return this.queueChainByEntryKey.getStats();
  }

  enqueue(input: {
    entryId: string;
    eventType: RagicCallbackEventType;
    source?: string;
    actorIp?: string;
    actorLabel?: string;
  }): Form16CallbackTask {
    try {
      this.queueChainByEntryKey.assertAccepting();
    } catch (error) {
      if (error instanceof KeyedSerialQueueClosedError) {
        throw new HttpError(
          503,
          "Form 16 callback refresh queue 正在關閉，暫不接受新任務",
          "RAGIC_CALLBACK_QUEUE_CLOSED"
        );
      }
      throw error;
    }

    const normalizedEntryId = String(input.entryId ?? "").trim();
    const createdAt = new Date().toISOString();
    const task: Form16CallbackTask = {
      taskId: randomUUID(),
      entryId: normalizedEntryId,
      eventType: input.eventType,
      ...(input.source ? { source: input.source } : {}),
      createdAt,
      updatedAt: createdAt,
      status: "pending",
    };

    this.tasks.set(task.taskId, task);
    this.syncTaskToRegistry(task, input);

    // 同 entry 的 callback 走 queue chain 序列化，避免短時間多筆 callback 互相覆寫
    const queueKey = `form16:${normalizedEntryId}`;
    void this.queueChainByEntryKey.enqueue(queueKey, () =>
      this.runTask(task.taskId, input)
    );

    return { ...task };
  }

  private async runTask(
    taskId: string,
    input: {
      actorIp?: string;
      actorLabel?: string;
      source?: string;
    }
  ): Promise<void> {
    const current = this.tasks.get(taskId);
    if (!current) {
      return;
    }

    const startedAt = new Date().toISOString();
    const runningTask: Form16CallbackTask = {
      ...current,
      status: "running",
      updatedAt: startedAt,
    };
    this.tasks.set(taskId, runningTask);
    this.syncTaskToRegistry(runningTask, input);

    try {
      if (this.deps.delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.deps.delayMs);
        });
      }

      // refreshEntrySnapshotFromRagic 內部會自己處理「Ragic 找不到 entry → 從 SQLite 刪掉」
      // 所以 created/updated/deleted 三種都用同一條路徑
      await this.deps.refreshEntrySnapshotFromRagic(runningTask.entryId);

      const finishedAt = new Date().toISOString();
      const successTask: Form16CallbackTask = {
        ...runningTask,
        status: "success",
        updatedAt: finishedAt,
        finishedAt,
      };
      this.tasks.set(taskId, successTask);
      this.syncTaskToRegistry(successTask, input);
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const failedTask: Form16CallbackTask = {
        ...runningTask,
        status: "failed",
        updatedAt: finishedAt,
        finishedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      this.tasks.set(taskId, failedTask);
      this.syncTaskToRegistry(failedTask, input);
    } finally {
      // task lifecycle 已結束並同步到 registry（持久層）；這個 in-memory Map 無人
      // 後續讀取（route 只用 enqueue 的同步回傳），完成即刪，避免無界累積到 OOM。
      this.tasks.delete(taskId);
    }
  }

  private syncTaskToRegistry(
    task: Form16CallbackTask,
    input?: {
      actorIp?: string;
      actorLabel?: string;
      source?: string;
    }
  ): void {
    const sourceLabel = input?.source ?? task.source ?? "ragic-callback-16";
    this.deps.registry.upsertTask({
      taskId: task.taskId,
      taskType: "callback-refresh",
      status: task.status,
      formId: "16",
      entryId: task.entryId,
      queueKey: `form16:${task.entryId}`,
      createdAt: task.createdAt,
      startedAt:
        task.status === "running" || task.status === "success" || task.status === "failed"
          ? task.createdAt
          : null,
      finishedAt: task.finishedAt ?? null,
      updatedAt: task.updatedAt,
      message:
        task.status === "failed"
          ? task.errorMessage ?? "Form 16 callback refresh 失敗"
          : `Form 16 callback refresh: ${sourceLabel}`,
      errorCode: task.status === "failed" ? "FORM16_CALLBACK_REFRESH_FAILED" : null,
      errorMessage: task.status === "failed" ? task.errorMessage ?? null : null,
      actorIp: input?.actorIp ?? null,
      // 只存真正的裝置 label；系統事件來源寫到 source 欄
      actorLabel: input?.actorLabel ?? null,
      source: sourceLabel,
    });
  }
}

export const form16DowntimeCallbackRefreshService =
  new Form16DowntimeCallbackRefreshService();
