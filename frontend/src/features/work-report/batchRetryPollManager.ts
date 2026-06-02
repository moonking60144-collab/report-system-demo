import { fetchWorkReportQueueTask } from "../../api/workReport";
import { deleteRetryableBatchCreateRecordChain } from "./taskBatchRetryStore";

// Poll 管理器跑在 module-level，不綁 React 組件生命週期
// 關 drawer / 切頁都不會中止，poll 會自然跑到 task 結束或 timeout
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000; // 2 分鐘

const activePolls = new Map<string, AbortController>();

async function runPoll(formId: string, taskId: string, controller: AbortController): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  try {
    while (Date.now() < deadline && !controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (controller.signal.aborted) return;
      try {
        const latest = await fetchWorkReportQueueTask(formId, taskId);
        if (latest.status === "success") {
          deleteRetryableBatchCreateRecordChain(taskId);
          return;
        }
        if (latest.status === "failed") {
          return; // 保留 record 供下次 retry
        }
      } catch {
        // poll 本身失敗不致命，等下一輪再試
      }
    }
  } finally {
    if (activePolls.get(taskId) === controller) {
      activePolls.delete(taskId);
    }
  }
}

/**
 * 啟動對某個 retry task 的 poll；同 taskId 已在 poll 時直接忽略，避免重複
 * 這個 poll 不依賴任何 React 組件，關 drawer / 切頁都會繼續
 */
export function enqueueRetryPoll(formId: string, taskId: string): void {
  if (!formId || !taskId) return;
  if (activePolls.has(taskId)) return;
  const controller = new AbortController();
  activePolls.set(taskId, controller);
  void runPoll(formId, taskId, controller);
}

/** 測試 / 除錯用：目前進行中的 poll 數量 */
export function getActiveRetryPollCount(): number {
  return activePolls.size;
}
