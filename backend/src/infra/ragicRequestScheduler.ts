import { env } from "../config/env";
import { createLogger } from "../observability/logger";
import { CircuitBreaker, type CircuitState } from "./circuitBreaker";
import { TokenBucket, TokenBucketAcquireTimeoutError } from "./tokenBucket";

/**
 * 哪些 error 算「Ragic upstream failure」要進 breaker，哪些是 local backpressure 不算。
 * 用 lane.run 的 isFailureCounted classifier 過濾。
 */
function isCountedAsRagicFailure(err: unknown): boolean {
  // Local rate limiter timeout：上游可能完全健康，只是我們自己排太擠
  if (err instanceof TokenBucketAcquireTimeoutError) return false;
  return true;
}

const log = createLogger("ragic-circuit-breaker");

interface ConcurrencyLaneStats {
  active: number;
  pending: number;
  latencyMsP50: number;
  latencyMsP95: number;
  circuitState: CircuitState;
}

interface ConcurrencyLaneMetrics {
  totalRequests: number;
  totalFailures: number;
}

export type RagicReadPriority = "user" | "sync" | "background";

export interface RagicRequestSchedulerStats {
  readActive: number;
  readPending: number;
  syncActive: number;
  syncPending: number;
  backgroundActive: number;
  backgroundPending: number;
  writeActive: number;
  writePending: number;
  // Latency 拆四 lane（之前只露 read/write，sync 跟 background 看不到 P50/P95）
  readLatencyMsP50: number;
  readLatencyMsP95: number;
  syncLatencyMsP50: number;
  syncLatencyMsP95: number;
  backgroundLatencyMsP50: number;
  backgroundLatencyMsP95: number;
  writeLatencyMsP50: number;
  writeLatencyMsP95: number;
  // Total / failure 也同步拆四（form16 background 流量、sync 流量原本看不到）
  readTotalRequests: number;
  readTotalFailures: number;
  syncTotalRequests: number;
  syncTotalFailures: number;
  backgroundTotalRequests: number;
  backgroundTotalFailures: number;
  writeTotalRequests: number;
  writeTotalFailures: number;
  readCircuitState: CircuitState;
  syncCircuitState: CircuitState;
  backgroundCircuitState: CircuitState;
  writeCircuitState: CircuitState;
  // 全域 token bucket（橫跨 4 條 lane 的 Ragic outbound rate limiter）
  globalRateLimiterAvailableTokens: number;
  globalRateLimiterPendingWaiters: number;
  globalRateLimiterCapacity: number;
  globalRateLimiterRefillPerSecond: number;
}

class ConcurrencyLane {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly latenciesMs: number[] = [];
  private totalRequests = 0;
  private totalFailures = 0;
  private readonly breaker: CircuitBreaker;

  constructor(
    name: string,
    private readonly maxConcurrency: number,
    private readonly latencyWindowSize: number
  ) {
    this.breaker = new CircuitBreaker(name, {
      failureThreshold: env.RAGIC_CIRCUIT_FAILURE_THRESHOLD,
      cooldownMs: env.RAGIC_CIRCUIT_COOLDOWN_MS,
      onStateChange: (change) => {
        // 狀態轉換結構化 log，方便 grep 對齊到實際時間 / 對應 lane
        // closed→open  : 連續失敗達 threshold，整條 lane fast-fail
        // open→half-open: cooldown 結束放探測請求
        // half-open→open: 探測請求又失敗，再 cooldown 一輪
        // half-open→closed: 探測請求成功，恢復服務
        const payload = {
          event: "circuit-breaker-state-change",
          lane: change.name,
          from: change.from,
          to: change.to,
          consecutiveFailures: change.consecutiveFailures,
          cooldownEndsAt: change.cooldownEndsAt
            ? new Date(change.cooldownEndsAt).toISOString()
            : null,
          failureThreshold: env.RAGIC_CIRCUIT_FAILURE_THRESHOLD,
          cooldownMs: env.RAGIC_CIRCUIT_COOLDOWN_MS,
        };
        const msg = `[circuit-breaker] ${change.name} ${change.from} → ${change.to}`;
        // 明確分支不靠動態索引，避免 pino API 變動時 silent break
        if (change.to === "open") {
          log.warn(payload, msg);
        } else {
          log.info(payload, msg);
        }
      },
    });
  }

  async run<T>(
    task: () => Promise<T>,
    options?: { isFailureCounted?: (err: unknown) => boolean }
  ): Promise<T> {
    // 在 acquire 之前先檢查 breaker，OPEN 狀態直接 fast-fail，不佔 concurrency slot
    this.breaker.checkBeforeRun();

    const release = await this.acquire();
    let releaseCalled = false;
    const safeRelease = () => {
      if (releaseCalled) return;
      releaseCalled = true;
      release();
    };

    // Re-check breaker：等 queue 期間前面 task 可能連續失敗把 breaker 打開
    // queued task 不該繼續執行，立刻釋放 slot 並 fast-fail。
    // CircuitBreakerOpenError 不算 Ragic failure，不 record。
    try {
      this.breaker.checkBeforeRun();
    } catch (err) {
      safeRelease();
      throw err;
    }

    const startedAt = Date.now();
    this.totalRequests += 1;

    try {
      const result = await task();
      this.recordLatency(Date.now() - startedAt);
      this.breaker.recordSuccess();
      return result;
    } catch (error) {
      this.recordLatency(Date.now() - startedAt);
      // Failure classifier：caller 可指定哪些 error 不算 breaker failure。
      // 預設都算。用法：local backpressure（token bucket timeout）等不該被
      // 誤判為「Ragic upstream 壞掉」連帶觸發 breaker。
      const counted = options?.isFailureCounted?.(error) ?? true;
      if (counted) {
        this.totalFailures += 1;
        this.breaker.recordFailure();
      }
      throw error;
    } finally {
      safeRelease();
    }
  }

  getStats(): ConcurrencyLaneStats {
    return {
      active: this.active,
      pending: this.queue.length,
      latencyMsP50: this.calculatePercentile(50),
      latencyMsP95: this.calculatePercentile(95),
      circuitState: this.breaker.getState(),
    };
  }

  getMetrics(): ConcurrencyLaneMetrics {
    return {
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
    };
  }

  private async acquire(): Promise<() => void> {
    if (this.active >= this.maxConcurrency) {
      const queueTimeoutMs = env.RAGIC_QUEUE_TIMEOUT_MS;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.queue.indexOf(wrappedResolve);
          if (index >= 0) {
            this.queue.splice(index, 1);
          }
          reject(new Error(`concurrency queue timeout (${queueTimeoutMs}ms, pending=${this.queue.length}, active=${this.active})`));
        }, queueTimeoutMs);
        const wrappedResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        this.queue.push(wrappedResolve);
      });
    }

    this.active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.queue.shift();
      if (next) {
        next();
      }
    };
  }

  private recordLatency(durationMs: number): void {
    this.latenciesMs.push(Math.max(0, durationMs));
    if (this.latenciesMs.length > this.latencyWindowSize) {
      this.latenciesMs.shift();
    }
  }

  private calculatePercentile(percentile: number): number {
    if (this.latenciesMs.length === 0) {
      return 0;
    }
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const rank = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)
    );
    const value = sorted[rank];
    return Number(value.toFixed(2));
  }
}

class RagicRequestScheduler {
  // user lane：使用者請求，最高優先，最大 concurrency
  private readonly userLane = new ConcurrencyLane(
    "user",
    env.RAGIC_READ_CONCURRENCY,
    env.RAGIC_METRICS_WINDOW_SIZE
  );
  // sync lane：auto-sync 專用，獨立 pool 不影響使用者
  private readonly syncLane = new ConcurrencyLane(
    "sync",
    env.RAGIC_SYNC_READ_CONCURRENCY,
    env.RAGIC_METRICS_WINDOW_SIZE
  );
  // background lane：callback refresh、form 16 refresh 等背景任務
  private readonly backgroundLane = new ConcurrencyLane(
    "background",
    env.RAGIC_BACKGROUND_READ_CONCURRENCY,
    env.RAGIC_METRICS_WINDOW_SIZE
  );
  private readonly writeLane = new ConcurrencyLane(
    "write",
    env.RAGIC_WRITE_CONCURRENCY,
    env.RAGIC_METRICS_WINDOW_SIZE
  );
  // 全域 token bucket：限制 4 條 lane 加總後對 Ragic 的每秒請求上限。
  // ConcurrencyLane 限「同時 in-flight」數，bucket 限「每秒 outbound 速率」，正交設計。
  // 寫入 / 讀取共用同一個 bucket，因為 Ragic 限流是混 read/write 看 total。
  private readonly globalRateLimiter = new TokenBucket({
    refillPerSecond: env.RAGIC_GLOBAL_RATE_PER_SECOND,
    capacity: env.RAGIC_GLOBAL_BURST_CAPACITY,
  });

  async runRead<T>(
    _label: string,
    task: () => Promise<T>,
    priority: RagicReadPriority = "user"
  ): Promise<T> {
    const lane = this.pickReadLane(priority);
    return lane.run(
      async () => {
        // 取得 lane slot 後再過全域 rate limiter，OPEN circuit breaker 已 fast-fail
        // 不必白等 rate limiter token。
        // Timeout 用 RAGIC_QUEUE_TIMEOUT_MS：lane slot 已被佔用，等 token 太久就放棄
        // 避免 lane.active 被 token-bucket-waiter 長期佔住失真。
        await this.globalRateLimiter.acquire({ timeoutMs: env.RAGIC_QUEUE_TIMEOUT_MS });
        return task();
      },
      // TokenBucketAcquireTimeoutError 是 local backpressure，不算 Ragic failure
      { isFailureCounted: isCountedAsRagicFailure }
    );
  }

  async runWrite<T>(_label: string, task: () => Promise<T>): Promise<T> {
    return this.writeLane.run(
      async () => {
        await this.globalRateLimiter.acquire({ timeoutMs: env.RAGIC_QUEUE_TIMEOUT_MS });
        return task();
      },
      { isFailureCounted: isCountedAsRagicFailure }
    );
  }

  /** 給 health endpoint / monitor 用 */
  getRateLimiterStats(): ReturnType<TokenBucket["getStats"]> {
    return this.globalRateLimiter.getStats();
  }

  private pickReadLane(priority: RagicReadPriority): ConcurrencyLane {
    if (priority === "sync") return this.syncLane;
    if (priority === "background") return this.backgroundLane;
    return this.userLane;
  }

  getStats(): RagicRequestSchedulerStats {
    const read = this.userLane.getStats();
    const sync = this.syncLane.getStats();
    const background = this.backgroundLane.getStats();
    const write = this.writeLane.getStats();
    const readMetrics = this.userLane.getMetrics();
    const syncMetrics = this.syncLane.getMetrics();
    const backgroundMetrics = this.backgroundLane.getMetrics();
    const writeMetrics = this.writeLane.getMetrics();
    const rateLimiter = this.globalRateLimiter.getStats();

    return {
      readActive: read.active,
      readPending: read.pending,
      syncActive: sync.active,
      syncPending: sync.pending,
      backgroundActive: background.active,
      backgroundPending: background.pending,
      writeActive: write.active,
      writePending: write.pending,
      readLatencyMsP50: read.latencyMsP50,
      readLatencyMsP95: read.latencyMsP95,
      syncLatencyMsP50: sync.latencyMsP50,
      syncLatencyMsP95: sync.latencyMsP95,
      backgroundLatencyMsP50: background.latencyMsP50,
      backgroundLatencyMsP95: background.latencyMsP95,
      writeLatencyMsP50: write.latencyMsP50,
      writeLatencyMsP95: write.latencyMsP95,
      readTotalRequests: readMetrics.totalRequests,
      readTotalFailures: readMetrics.totalFailures,
      syncTotalRequests: syncMetrics.totalRequests,
      syncTotalFailures: syncMetrics.totalFailures,
      backgroundTotalRequests: backgroundMetrics.totalRequests,
      backgroundTotalFailures: backgroundMetrics.totalFailures,
      writeTotalRequests: writeMetrics.totalRequests,
      writeTotalFailures: writeMetrics.totalFailures,
      readCircuitState: read.circuitState,
      syncCircuitState: sync.circuitState,
      backgroundCircuitState: background.circuitState,
      writeCircuitState: write.circuitState,
      globalRateLimiterAvailableTokens: rateLimiter.availableTokens,
      globalRateLimiterPendingWaiters: rateLimiter.pendingWaiters,
      globalRateLimiterCapacity: rateLimiter.capacity,
      globalRateLimiterRefillPerSecond: rateLimiter.refillPerSecond,
    };
  }
}

export const ragicRequestScheduler = new RagicRequestScheduler();
