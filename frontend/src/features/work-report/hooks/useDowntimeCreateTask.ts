import { useCallback, useRef } from "react";
import {
  createForm16DowntimeRecord,
  fetchDowntimeTask,
  type CreateForm16DowntimePayload,
} from "../../../api/downtime";
import { useDowntimeMutationTask } from "./useDowntimeMutationTask";

/**
 * 共用的 downtime task poll 邏輯：拿到 taskId 後輪詢，直到 success/failed/timeout
 * 用在 create / update / delete 三條路徑
 */
export async function pollDowntimeTaskUntilDone(
  taskId: string,
  options: {
    pollIntervalMs?: number;
    maxPollAttempts?: number;
    isCancelled?: () => boolean;
  } = {}
): Promise<{ ok: boolean; errorMessage?: string }> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const maxPollAttempts = options.maxPollAttempts ?? 30;
  const isCancelled = options.isCancelled ?? (() => false);

  for (let i = 0; i < maxPollAttempts; i += 1) {
    if (isCancelled()) return { ok: false, errorMessage: "cancelled" };
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (isCancelled()) return { ok: false, errorMessage: "cancelled" };
    try {
      const task = await fetchDowntimeTask(taskId);
      if (task.status === "success") return { ok: true };
      if (task.status === "failed") {
        return { ok: false, errorMessage: task.message ?? "任務失敗" };
      }
    } catch {
      // query failed, keep polling
    }
  }
  return { ok: false, errorMessage: "任務逾時，請手動重新整理" };
}

export type DowntimeCreateStatus = "idle" | "submitting" | "success" | "failed";

export interface UseDowntimeCreateTaskOptions {
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface UseDowntimeCreateTaskResult {
  status: DowntimeCreateStatus;
  submit: (payload: CreateForm16DowntimePayload) => Promise<{ ok: boolean; errorMessage?: string }>;
}

/**
 * 停機建立的 task queue polling 封裝。薄 wrapper over useDowntimeMutationTask
 * 保留向後相容 API（status + submit 介面），內部邏輯跟 update/delete 共用。
 *
 * Idempotency：
 * - 每次 submit session 產一組 clientRowKey UUID，失敗重試會重用同一個 key
 * - backend 收到相同 key 會擋掉重複寫入（擋 retry 風暴造成的 duplicate Form 16 entry）
 * - 成功後清空 ref，下一次 submit 會是新 key
 */
export function useDowntimeCreateTask(
  options: UseDowntimeCreateTaskOptions = {}
): UseDowntimeCreateTaskResult {
  const { status, run } = useDowntimeMutationTask(options);
  const clientRowKeyRef = useRef<string | null>(null);

  const submit = useCallback(
    async (payload: CreateForm16DowntimePayload) => {
      if (!clientRowKeyRef.current) {
        clientRowKeyRef.current =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      }
      const clientRowKey = clientRowKeyRef.current;
      const result = await run(() =>
        createForm16DowntimeRecord({ ...payload, clientRowKey })
      );
      if (result.ok) {
        // 成功 → 下次 submit 走新 key；失敗保留，讓 retry 走同 key 走 idempotency 路徑
        clientRowKeyRef.current = null;
      }
      return result;
    },
    [run]
  );
  return { status, submit };
}
