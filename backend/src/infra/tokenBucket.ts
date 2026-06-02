/**
 * 簡單的 token bucket：用來限制「對單一上游（Ragic）的全域 request rate」。
 *
 * 跟 ConcurrencyLane 的差異：
 * - ConcurrencyLane 限制「同時 in-flight 的請求數」
 * - TokenBucket 限制「每秒新發出的請求數」
 *
 * 兩個是正交的概念。例：lane=12 in-flight，但 token bucket 8 req/s
 * → in-flight 可以維持 12，但每秒只能新放出 8 個進去做（其他排隊）。
 *
 * Bucket 容量決定 burst 大小：例 capacity=12 表示閒置一段時間後可以瞬間放出 12 個。
 *
 * **已知限制（v1）**：waiters 是單一 FIFO queue，不分 priority。
 * 所以全域 rate limiter 不會保留 lane priority —— user lane 的請求若排在
 * background lane 之後，仍要等 background 拿到 token 才輪到。
 * Lane priority 只在 ConcurrencyLane 內生效（in-flight cap 層）。
 * 如果未來觀察到 user 經常被背景排隊擋住，再做 priority-aware queue。
 */

interface TokenBucketOptions {
  /** 每秒補多少 token */
  refillPerSecond: number;
  /** Bucket 容量 = burst 大小 */
  capacity: number;
  /** 注入時間源，方便測試 */
  now?: () => number;
}

interface AcquireOptions {
  /** 最久等待 ms；超過直接 reject。0 / undefined 表示不限時 */
  timeoutMs?: number;
  /** AbortSignal；abort 時 acquire 立即 reject 並從 waiter queue 移除 */
  signal?: AbortSignal;
}

export class TokenBucketAcquireTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super(`TokenBucket acquire timed out after ${waitedMs}ms`);
    this.name = "TokenBucketAcquireTimeoutError";
  }
}

export class TokenBucketAcquireAbortedError extends Error {
  constructor() {
    super("TokenBucket acquire aborted");
    this.name = "TokenBucketAcquireAbortedError";
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private waiters: Waiter[] = [];
  private refillTimer: NodeJS.Timeout | null = null;

  private readonly refillPerSecond: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    if (options.refillPerSecond <= 0) {
      throw new Error("TokenBucket refillPerSecond 必須 > 0");
    }
    if (options.capacity <= 0) {
      throw new Error("TokenBucket capacity 必須 > 0");
    }
    this.refillPerSecond = options.refillPerSecond;
    this.capacity = options.capacity;
    this.now = options.now ?? (() => Date.now());
    this.tokens = options.capacity;
    this.lastRefillAt = this.now();
  }

  /**
   * 取得 1 個 token；不夠時 block 直到 refill 或 timeout / abort。
   *
   * 失敗條件：
   * - timeout 超過 → 拋 TokenBucketAcquireTimeoutError
   * - signal aborted → 拋 TokenBucketAcquireAbortedError
   *
   * 失敗時 waiter 會從 queue 中移除（不會留 dead waiter 阻塞後續）。
   */
  acquire(options: AcquireOptions = {}): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    // 沒 token，排進 waiter queue
    const startedAt = this.now();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };

      // 統一的清理函式：從 waiter queue 移除（避免 dead waiter）
      // 移除後若 queue 已空 → cancel refill timer，避免 timer 拖長 process 退出
      // （特別是低 refillPerSecond 設定下，timer 可能排幾秒甚至幾十秒）
      const removeFromQueue = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        if (this.waiters.length === 0 && this.refillTimer) {
          clearTimeout(this.refillTimer);
          this.refillTimer = null;
        }
      };

      // Timeout handler
      let timeoutHandle: NodeJS.Timeout | null = null;
      if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          removeFromQueue();
          options.signal?.removeEventListener("abort", onAbort);
          reject(new TokenBucketAcquireTimeoutError(this.now() - startedAt));
        }, options.timeoutMs);
      }

      // Abort handler
      const onAbort = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        removeFromQueue();
        reject(new TokenBucketAcquireAbortedError());
      };

      // 包一層 resolve / reject 確保 timeout / abort 解除
      const wrappedResolve = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const wrappedReject = (err: Error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", onAbort);
        reject(err);
      };
      waiter.resolve = wrappedResolve;
      waiter.reject = wrappedReject;

      // signal 已經 abort 直接 reject
      if (options.signal?.aborted) {
        wrappedReject(new TokenBucketAcquireAbortedError());
        return;
      }
      options.signal?.addEventListener("abort", onAbort);

      this.waiters.push(waiter);
      this.scheduleRefillCheck();
    });
  }

  /** 不阻塞嘗試取一個 token；OK 回 true、不夠回 false（caller 自己決定要 fail-fast 還是 wait） */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 給 health endpoint 看 */
  getStats(): { availableTokens: number; pendingWaiters: number; capacity: number; refillPerSecond: number } {
    this.refill();
    return {
      availableTokens: Math.floor(this.tokens),
      pendingWaiters: this.waiters.length,
      capacity: this.capacity,
      refillPerSecond: this.refillPerSecond,
    };
  }

  /** 計算自上次 refill 以來該補多少 token */
  private refill(): void {
    const now = this.now();
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs <= 0) {
      return;
    }
    const newTokens = (elapsedMs / 1000) * this.refillPerSecond;
    if (newTokens > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + newTokens);
      this.lastRefillAt = now;
    }
  }

  /**
   * 排一個 timer 等下次有 token 時叫醒 waiters。
   *
   * 注意：**不**呼叫 timer.unref()。pending waiter 是真實未完成工作，必須讓
   * event loop 等到 timer 觸發 / waiter 被 resolve；unref 會讓 process 在
   * waiter 還沒 resolve 前就退出，acquire() 永遠等不到 token。
   *
   * Self-cleanup：waiters 排空後 timer 自動 null（line 108-119），不會 leak。
   */
  private scheduleRefillCheck(): void {
    if (this.refillTimer || this.waiters.length === 0) {
      return;
    }
    const waitMs = Math.max(1, Math.ceil(1000 / this.refillPerSecond));
    this.refillTimer = setTimeout(() => {
      this.refillTimer = null;
      this.refill();
      while (this.tokens >= 1 && this.waiters.length > 0) {
        this.tokens -= 1;
        const next = this.waiters.shift();
        next?.resolve();
      }
      if (this.waiters.length > 0) {
        this.scheduleRefillCheck();
      }
    }, waitMs);
  }
}
