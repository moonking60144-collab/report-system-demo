import { useCallback, useEffect, useRef, useState } from "react";
import { pollDowntimeTaskUntilDone } from "./useDowntimeCreateTask";

export type DowntimeMutationStatus = "idle" | "submitting" | "success" | "failed";

export interface UseDowntimeMutationTaskOptions {
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface DowntimeMutationResult {
  ok: boolean;
  errorMessage?: string;
}

/**
 * 共用 downtime task mutation hook：
 * - submit accept 函式負責呼叫 API 取得 taskId
 * - 本 hook 負責 polling、cancel、status state
 * 三條路徑（create / update / delete）共用同一套行為
 */
export function useDowntimeMutationTask(
  options: UseDowntimeMutationTaskOptions = {}
): {
  status: DowntimeMutationStatus;
  run: (
    accept: () => Promise<{ taskId: string }>
  ) => Promise<DowntimeMutationResult>;
} {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const maxPollAttempts = options.maxPollAttempts ?? 30;
  const [status, setStatus] = useState<DowntimeMutationStatus>("idle");
  const cancelledRef = useRef(false);

  useEffect(() => {
    // mount 時重設 false：避免 React StrictMode 雙跑 effect 時，
    // 上一次 cleanup 把 ref 設成 true 之後再也回不來，導致每次 run 都立刻判 cancelled
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const run = useCallback(
    async (
      accept: () => Promise<{ taskId: string }>
    ): Promise<DowntimeMutationResult> => {
      setStatus("submitting");
      try {
        const accepted = await accept();
        const result = await pollDowntimeTaskUntilDone(accepted.taskId, {
          pollIntervalMs,
          maxPollAttempts,
          isCancelled: () => cancelledRef.current,
        });
        setStatus(result.ok ? "success" : "failed");
        return result;
      } catch (error) {
        setStatus("failed");
        return {
          ok: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [maxPollAttempts, pollIntervalMs]
  );

  return { status, run };
}
