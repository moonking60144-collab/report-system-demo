import { randomUUID } from "crypto";
import { env } from "../../config/env";
import type { RagicCallbackEventType } from "../ragicCallbackRefreshServiceFactory";
import { workReportTaskRegistryService } from "../work-report/workReportTaskRegistryService";
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

class Form16DowntimeCallbackRefreshService {
  private readonly tasks = new Map<string, Form16CallbackTask>();
  private readonly queueChainByEntryKey = new Map<string, Promise<void>>();

  enqueue(input: {
    entryId: string;
    eventType: RagicCallbackEventType;
    source?: string;
    actorIp?: string;
    actorLabel?: string;
  }): Form16CallbackTask {
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
    const currentChain = this.queueChainByEntryKey.get(queueKey) ?? Promise.resolve();
    const nextChain = currentChain
      .catch(() => {
        // queue 內單筆失敗不阻塞後續
      })
      .then(async () => {
        await this.runTask(task.taskId, input);
      });

    this.queueChainByEntryKey.set(queueKey, nextChain);
    void nextChain.finally(() => {
      if (this.queueChainByEntryKey.get(queueKey) === nextChain) {
        this.queueChainByEntryKey.delete(queueKey);
      }
    });

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
      if (env.RAGIC_CALLBACK_DELAY_MS > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, env.RAGIC_CALLBACK_DELAY_MS);
        });
      }

      // refreshEntrySnapshotFromRagic 內部會自己處理「Ragic 找不到 entry → 從 SQLite 刪掉」
      // 所以 created/updated/deleted 三種都用同一條路徑
      await form16DowntimeService.refreshEntrySnapshotFromRagic(runningTask.entryId);

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
    workReportTaskRegistryService.upsertTask({
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
