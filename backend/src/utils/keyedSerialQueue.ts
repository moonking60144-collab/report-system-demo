/**
 * 同 key 任務串行化 queue：後到的 task 接在該 key 現有 chain 尾端依序執行，
 * 不同 key 互不影響。前一筆 task 失敗（reject）不阻塞後續排隊任務。
 * chain 跑完且沒有新任務接上時，自動從 Map 清掉該 key，避免無界累積。
 *
 * enqueue 回傳的 promise 反映「該筆 task」的結果；task 會 reject 的話 caller
 * 要自行 catch（目前各 task service 的 runner 內部已全吞錯誤、不重拋，
 * fire-and-forget `void enqueue(...)` 即可）。
 */
export interface KeyedSerialQueue {
  enqueue(
    key: string,
    task: () => Promise<void>,
    options?: { signal?: AbortSignal }
  ): Promise<void>;
  /** 在建立對應 task state 前同步確認 admission，避免關機期間留下 ghost pending task。 */
  assertAccepting(key?: string): void;
  /** 永久停止接受新任務；已排入的任務不受影響。 */
  closeAdmission(): void;
  /** 等待目前所有已接受任務完成或失敗。 */
  drain(): Promise<void>;
  getStats(): KeyedSerialQueueStats;
  getOldestPendingTaskAgeMs(): number;
  getHighestPendingTaskCountPerKey(): number;
  /** 目前仍有任務在跑（或排隊中）的 key 數量，觀測統計用。 */
  readonly activeKeyCount: number;
}

export interface KeyedSerialQueueStats {
  accepting: boolean;
  activeKeyCount: number;
  pendingTaskCount: number;
}

export interface KeyedSerialQueueOptions {
  maxPendingTaskCount?: number;
  maxPendingTaskCountPerKey?: number;
  maxOldestPendingTaskAgeMs?: number;
  now?: () => number;
}

export class KeyedSerialQueueAbortedError extends Error {
  constructor() {
    super("Keyed serial queue task aborted before start");
    this.name = "KeyedSerialQueueAbortedError";
  }
}

export class KeyedSerialQueueClosedError extends Error {
  constructor() {
    super("Keyed serial queue is closed to new tasks");
    this.name = "KeyedSerialQueueClosedError";
  }
}

export class KeyedSerialQueueCapacityError extends Error {
  constructor(
    public readonly reason: "total" | "key" | "age",
    public readonly pendingTaskCount: number,
    public readonly pendingTaskCountForKey: number,
    public readonly oldestPendingTaskAgeMs: number
  ) {
    super("Keyed serial queue capacity exceeded");
    this.name = "KeyedSerialQueueCapacityError";
  }
}

export function createKeyedSerialQueue(
  options: KeyedSerialQueueOptions = {}
): KeyedSerialQueue {
  const chainByKey = new Map<string, Promise<void>>();
  const pendingTaskCountByKey = new Map<string, number>();
  const pendingTasks = new Set<{ key: string; enqueuedAt: number }>();
  const now = options.now ?? Date.now;
  let accepting = true;
  let pendingTaskCount = 0;
  const getOldestPendingTaskAgeMs = (): number => {
    let oldestEnqueuedAt = Number.POSITIVE_INFINITY;
    for (const task of pendingTasks) {
      oldestEnqueuedAt = Math.min(oldestEnqueuedAt, task.enqueuedAt);
    }
    return Number.isFinite(oldestEnqueuedAt)
      ? Math.max(0, now() - oldestEnqueuedAt)
      : 0;
  };
  const getHighestPendingTaskCountPerKey = (): number => {
    let highest = 0;
    for (const count of pendingTaskCountByKey.values()) {
      highest = Math.max(highest, count);
    }
    return highest;
  };
  const assertAccepting = (key?: string) => {
    if (!accepting) {
      throw new KeyedSerialQueueClosedError();
    }
    const pendingTaskCountForKey = key ? pendingTaskCountByKey.get(key) ?? 0 : 0;
    const oldestPendingTaskAgeMs = getOldestPendingTaskAgeMs();
    const reason =
      options.maxPendingTaskCount !== undefined &&
      pendingTaskCount >= options.maxPendingTaskCount
        ? "total"
        : key &&
            options.maxPendingTaskCountPerKey !== undefined &&
            pendingTaskCountForKey >= options.maxPendingTaskCountPerKey
          ? "key"
          : options.maxOldestPendingTaskAgeMs !== undefined &&
              pendingTaskCount > 0 &&
              oldestPendingTaskAgeMs >= options.maxOldestPendingTaskAgeMs
            ? "age"
            : null;
    if (reason) {
      throw new KeyedSerialQueueCapacityError(
        reason,
        pendingTaskCount,
        pendingTaskCountForKey,
        oldestPendingTaskAgeMs
      );
    }
  };

  return {
    assertAccepting,
    enqueue(
      key: string,
      task: () => Promise<void>,
      options: { signal?: AbortSignal } = {}
    ): Promise<void> {
      assertAccepting(key);

      const currentChain = chainByKey.get(key) ?? Promise.resolve();
      const pendingTask = { key, enqueuedAt: now() };
      const nextChain = currentChain
        .catch(() => {
          // NOTE: 前一筆失敗不可中斷後續任務。
        })
        .then(() => {
          if (options.signal?.aborted) {
            throw new KeyedSerialQueueAbortedError();
          }
          return task();
        });
      pendingTaskCount += 1;
      pendingTaskCountByKey.set(key, (pendingTaskCountByKey.get(key) ?? 0) + 1);
      pendingTasks.add(pendingTask);
      chainByKey.set(key, nextChain);
      const settleTask = () => {
        pendingTaskCount -= 1;
        const nextPendingTaskCountForKey = (pendingTaskCountByKey.get(key) ?? 1) - 1;
        if (nextPendingTaskCountForKey > 0) {
          pendingTaskCountByKey.set(key, nextPendingTaskCountForKey);
        } else {
          pendingTaskCountByKey.delete(key);
        }
        pendingTasks.delete(pendingTask);
        if (chainByKey.get(key) === nextChain) {
          chainByKey.delete(key);
        }
      };
      void nextChain.then(settleTask, settleTask);
      return nextChain;
    },
    closeAdmission(): void {
      accepting = false;
    },
    async drain(): Promise<void> {
      while (pendingTaskCount > 0) {
        await Promise.allSettled(Array.from(chainByKey.values()));
      }
    },
    getStats(): KeyedSerialQueueStats {
      return {
        accepting,
        activeKeyCount: chainByKey.size,
        pendingTaskCount,
      };
    },
    getOldestPendingTaskAgeMs,
    getHighestPendingTaskCountPerKey,
    get activeKeyCount(): number {
      return chainByKey.size;
    },
  };
}
