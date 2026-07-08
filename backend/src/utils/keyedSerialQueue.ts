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
  enqueue(key: string, task: () => Promise<void>): Promise<void>;
  /** 目前仍有任務在跑（或排隊中）的 key 數量，觀測統計用。 */
  readonly activeKeyCount: number;
}

export function createKeyedSerialQueue(): KeyedSerialQueue {
  const chainByKey = new Map<string, Promise<void>>();
  return {
    enqueue(key: string, task: () => Promise<void>): Promise<void> {
      const currentChain = chainByKey.get(key) ?? Promise.resolve();
      const nextChain = currentChain
        .catch(() => {
          // NOTE: 前一筆失敗不可中斷後續任務。
        })
        .then(task);
      chainByKey.set(key, nextChain);
      // cleanup 衍生鏈要自己吞錯，否則 task reject 時這條 void 掉的 promise
      // 會變 unhandledRejection（task 的錯誤仍由 enqueue 回傳值正常傳遞）。
      void nextChain
        .catch(() => {})
        .finally(() => {
          if (chainByKey.get(key) === nextChain) {
            chainByKey.delete(key);
          }
        });
      return nextChain;
    },
    get activeKeyCount(): number {
      return chainByKey.size;
    },
  };
}
