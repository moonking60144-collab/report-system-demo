import {
  createKeyedSerialQueue,
  type KeyedSerialQueue,
  KeyedSerialQueueAbortedError,
  type KeyedSerialQueueStats,
} from "../../utils/keyedSerialQueue";
import { env } from "../../config/env";
import { workReportMutationSyncCoordinator } from "../work-report-sync/workReportMutationSyncCoordinator";

interface WorkReportEntryMutationQueueOptions {
  signal?: AbortSignal;
  onWaitingForSync?: () => void;
}

interface WorkReportEntryMutationQueue extends Omit<KeyedSerialQueue, "enqueue"> {
  enqueue(
    key: string,
    task: () => Promise<void>,
    options?: WorkReportEntryMutationQueueOptions
  ): Promise<void>;
}

const keyedQueue = createKeyedSerialQueue({
  maxPendingTaskCount: env.WORK_REPORT_MUTATION_MAX_PENDING_TOTAL,
  maxPendingTaskCountPerKey: env.WORK_REPORT_MUTATION_MAX_PENDING_PER_KEY,
  maxOldestPendingTaskAgeMs: env.WORK_REPORT_MUTATION_MAX_QUEUE_AGE_MS,
});

export const workReportEntryMutationQueue: WorkReportEntryMutationQueue = {
  assertAccepting: (key?: string) => keyedQueue.assertAccepting(key),
  closeAdmission: () => keyedQueue.closeAdmission(),
  drain: () => keyedQueue.drain(),
  getStats: () => keyedQueue.getStats(),
  getOldestPendingTaskAgeMs: () => keyedQueue.getOldestPendingTaskAgeMs(),
  getHighestPendingTaskCountPerKey: () => keyedQueue.getHighestPendingTaskCountPerKey(),
  get activeKeyCount(): number {
    return keyedQueue.activeKeyCount;
  },
  enqueue(
    key: string,
    task: () => Promise<void>,
    options: WorkReportEntryMutationQueueOptions = {}
  ): Promise<void> {
    return keyedQueue.enqueue(
      key,
      async () => {
        const releaseMutationSlot =
          await workReportMutationSyncCoordinator.acquireMutationSlot({
            onWaiting: options.onWaitingForSync,
          });
        try {
          if (options.signal?.aborted) {
            throw new KeyedSerialQueueAbortedError();
          }
          await task();
        } finally {
          releaseMutationSlot();
        }
      },
      { signal: options.signal }
    );
  },
};

export function getWorkReportEntryMutationQueueHealthStats(): KeyedSerialQueueStats & {
  oldestPendingTaskAgeMs: number;
  highestPendingTaskCountPerKey: number;
  maxPendingTaskCount: number;
  maxPendingTaskCountPerKey: number;
  maxOldestPendingTaskAgeMs: number;
} {
  return {
    ...keyedQueue.getStats(),
    oldestPendingTaskAgeMs: keyedQueue.getOldestPendingTaskAgeMs(),
    highestPendingTaskCountPerKey: keyedQueue.getHighestPendingTaskCountPerKey(),
    maxPendingTaskCount: env.WORK_REPORT_MUTATION_MAX_PENDING_TOTAL,
    maxPendingTaskCountPerKey: env.WORK_REPORT_MUTATION_MAX_PENDING_PER_KEY,
    maxOldestPendingTaskAgeMs: env.WORK_REPORT_MUTATION_MAX_QUEUE_AGE_MS,
  };
}

export function closeWorkReportEntryMutationQueueAdmission(): void {
  workReportEntryMutationQueue.closeAdmission();
}

export function drainWorkReportEntryMutationQueue(): Promise<void> {
  return workReportEntryMutationQueue.drain();
}

export function getWorkReportEntryMutationQueueStats(): KeyedSerialQueueStats {
  return workReportEntryMutationQueue.getStats();
}

export async function runWorkReportEntryMutationExclusive<T>(
  formId: string,
  entryId: string,
  worker: () => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  let result!: T;
  await workReportEntryMutationQueue.enqueue(
    `${formId}:${entryId}`,
    async () => {
      result = await worker();
    },
    options
  );
  return result;
}
