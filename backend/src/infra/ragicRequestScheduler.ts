import { AxiosError } from "axios";
import { env } from "../config/env";
import { createLogger } from "../observability/logger";
import { CircuitBreaker, type CircuitState } from "./circuitBreaker";
import { TokenBucket, TokenBucketAcquireTimeoutError } from "./tokenBucket";

const NON_COUNTED_RAGIC_HTTP_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

/**
 * 哪些 error 算「Ragic upstream failure」要進 breaker，哪些是 local backpressure 不算。
 * 用 lane.run 的 isFailureCounted classifier 過濾。
 */
function isCountedAsRagicFailure(err: unknown): boolean {
  // Local rate limiter timeout：上游可能完全健康，只是我們自己排太擠
  if (err instanceof TokenBucketAcquireTimeoutError) return false;
  if (
    err instanceof AxiosError &&
    NON_COUNTED_RAGIC_HTTP_STATUSES.has(err.response?.status ?? 0)
  ) {
    return false;
  }
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

export type RagicReadPriority = "user" | "mutation" | "sync" | "background";

interface RagicRequestSchedulerOptions {
  globalRatePerSecond?: number;
  globalBurstCapacity?: number;
}

export interface RagicRequestSchedulerStats {
  readActive: number;
  readPending: number;
  mutationActive: number;
  mutationPending: number;
  syncActive: number;
  syncPending: number;
  backgroundActive: number;
  backgroundPending: number;
  writeActive: number;
  writePending: number;
  // Latency 拆五 lane（user/mutation/sync/background/write），避免互動 mutation 被一般讀取平均值蓋掉。
  readLatencyMsP50: number;
  readLatencyMsP95: number;
  mutationLatencyMsP50: number;
  mutationLatencyMsP95: number;
  syncLatencyMsP50: number;
  syncLatencyMsP95: number;
  backgroundLatencyMsP50: number;
  backgroundLatencyMsP95: number;
  writeLatencyMsP50: number;
  writeLatencyMsP95: number;
  // Total / failure 也同步拆五（mutation precondition 不能和一般 user read 混在一起）
  readTotalRequests: number;
  readTotalFailures: number;
  mutationTotalRequests: number;
  mutationTotalFailures: number;
  syncTotalRequests: number;
  syncTotalFailures: number;
  backgroundTotalRequests: number;
  backgroundTotalFailures: number;
  writeTotalRequests: number;
  writeTotalFailures: number;
  readCircuitState: CircuitState;
  mutationCircuitState: CircuitState;
  syncCircuitState: CircuitState;
  backgroundCircuitState: CircuitState;
  writeCircuitState: CircuitState;
  // 所有 lane 共用的真正全域 token bucket 指標。
  globalRateLimiterAvailableTokens: number;
  globalRateLimiterPendingWaiters: number;
  globalRateLimiterCapacity: number;
  globalRateLimiterRefillPerSecond: number;
  // 前景 bucket：user read + write，保留互動操作速率預算。
  foregroundRateLimiterAvailableTokens: number;
  foregroundRateLimiterPendingWaiters: number;
  foregroundRateLimiterCapacity: number;
  foregroundRateLimiterRefillPerSecond: number;
  // Mutation bucket：寫入前 live precondition 用；不和一般 user refresh 或 sync 搶 token。
  mutationRateLimiterAvailableTokens: number;
  mutationRateLimiterPendingWaiters: number;
  mutationRateLimiterCapacity: number;
  mutationRateLimiterRefillPerSecond: number;
  // 背景 bucket：sync + background，避免背景任務餓死前景。
  backgroundRateLimiterAvailableTokens: number;
  backgroundRateLimiterPendingWaiters: number;
  backgroundRateLimiterCapacity: number;
  backgroundRateLimiterRefillPerSecond: number;
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
    this.breaker.checkBeforeQueue();

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
      } else {
        this.breaker.releaseHalfOpenProbe();
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

export class RagicRequestScheduler {
  // user lane：使用者請求，最高優先，最大 concurrency
  private readonly userLane = new ConcurrencyLane(
    "user",
    env.RAGIC_READ_CONCURRENCY,
    env.RAGIC_METRICS_WINDOW_SIZE
  );
  // mutation lane：寫入前 live precondition，不能被一般列表 refresh 或 sync 擠住。
  private readonly mutationLane = new ConcurrencyLane(
    "mutation",
    env.RAGIC_MUTATION_READ_CONCURRENCY,
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
  // 前景與背景使用不同 token bucket。ConcurrencyLane 限「同時 in-flight」數；
  // bucket 限「每秒 outbound 速率」。拆 bucket 的目的不是提高總吞吐，而是保留
  // user/write 的互動預算，避免 full sync / field-index refresh 吃光最後 token。
  private readonly foregroundRateLimiter = new TokenBucket({
    refillPerSecond: env.RAGIC_FOREGROUND_RATE_PER_SECOND,
    capacity: env.RAGIC_FOREGROUND_BURST_CAPACITY,
  });
  private readonly mutationRateLimiter = new TokenBucket({
    refillPerSecond: env.RAGIC_MUTATION_RATE_PER_SECOND,
    capacity: env.RAGIC_MUTATION_BURST_CAPACITY,
  });
  private readonly backgroundRateLimiter = new TokenBucket({
    refillPerSecond: env.RAGIC_BACKGROUND_RATE_PER_SECOND,
    capacity: env.RAGIC_BACKGROUND_BURST_CAPACITY,
  });
  private readonly globalRateLimiter: TokenBucket;

  constructor(options: RagicRequestSchedulerOptions = {}) {
    this.globalRateLimiter = new TokenBucket({
      refillPerSecond: options.globalRatePerSecond ?? env.RAGIC_GLOBAL_RATE_PER_SECOND,
      capacity: options.globalBurstCapacity ?? env.RAGIC_GLOBAL_BURST_CAPACITY,
    });
  }

  async runRead<T>(
    _label: string,
    task: () => Promise<T>,
    priority: RagicReadPriority = "user"
  ): Promise<T> {
    const lane = this.pickReadLane(priority);
    return lane.run(
      async () => {
        // 取得 lane slot 後再過 lane 與 global rate limiter，OPEN circuit breaker 已 fast-fail
        // 不必白等 rate limiter token。
        // Timeout 用 RAGIC_QUEUE_TIMEOUT_MS：lane slot 已被佔用，等 token 太久就放棄
        // 避免 lane.active 被 token-bucket-waiter 長期佔住失真。
        await this.pickRateLimiter(priority).acquire({ timeoutMs: env.RAGIC_QUEUE_TIMEOUT_MS });
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
        await this.foregroundRateLimiter.acquire({ timeoutMs: env.RAGIC_QUEUE_TIMEOUT_MS });
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
    if (priority === "mutation") return this.mutationLane;
    if (priority === "sync") return this.syncLane;
    if (priority === "background") return this.backgroundLane;
    return this.userLane;
  }

  private pickRateLimiter(priority: RagicReadPriority): TokenBucket {
    if (priority === "mutation") {
      return this.mutationRateLimiter;
    }
    if (priority === "sync" || priority === "background") {
      return this.backgroundRateLimiter;
    }
    return this.foregroundRateLimiter;
  }

  getStats(): RagicRequestSchedulerStats {
    const read = this.userLane.getStats();
    const mutation = this.mutationLane.getStats();
    const sync = this.syncLane.getStats();
    const background = this.backgroundLane.getStats();
    const write = this.writeLane.getStats();
    const readMetrics = this.userLane.getMetrics();
    const mutationMetrics = this.mutationLane.getMetrics();
    const syncMetrics = this.syncLane.getMetrics();
    const backgroundMetrics = this.backgroundLane.getMetrics();
    const writeMetrics = this.writeLane.getMetrics();
    const foregroundRateLimiter = this.foregroundRateLimiter.getStats();
    const mutationRateLimiter = this.mutationRateLimiter.getStats();
    const backgroundRateLimiter = this.backgroundRateLimiter.getStats();
    const globalRateLimiter = this.globalRateLimiter.getStats();

    return {
      readActive: read.active,
      readPending: read.pending,
      mutationActive: mutation.active,
      mutationPending: mutation.pending,
      syncActive: sync.active,
      syncPending: sync.pending,
      backgroundActive: background.active,
      backgroundPending: background.pending,
      writeActive: write.active,
      writePending: write.pending,
      readLatencyMsP50: read.latencyMsP50,
      readLatencyMsP95: read.latencyMsP95,
      mutationLatencyMsP50: mutation.latencyMsP50,
      mutationLatencyMsP95: mutation.latencyMsP95,
      syncLatencyMsP50: sync.latencyMsP50,
      syncLatencyMsP95: sync.latencyMsP95,
      backgroundLatencyMsP50: background.latencyMsP50,
      backgroundLatencyMsP95: background.latencyMsP95,
      writeLatencyMsP50: write.latencyMsP50,
      writeLatencyMsP95: write.latencyMsP95,
      readTotalRequests: readMetrics.totalRequests,
      readTotalFailures: readMetrics.totalFailures,
      mutationTotalRequests: mutationMetrics.totalRequests,
      mutationTotalFailures: mutationMetrics.totalFailures,
      syncTotalRequests: syncMetrics.totalRequests,
      syncTotalFailures: syncMetrics.totalFailures,
      backgroundTotalRequests: backgroundMetrics.totalRequests,
      backgroundTotalFailures: backgroundMetrics.totalFailures,
      writeTotalRequests: writeMetrics.totalRequests,
      writeTotalFailures: writeMetrics.totalFailures,
      readCircuitState: read.circuitState,
      mutationCircuitState: mutation.circuitState,
      syncCircuitState: sync.circuitState,
      backgroundCircuitState: background.circuitState,
      writeCircuitState: write.circuitState,
      globalRateLimiterAvailableTokens: globalRateLimiter.availableTokens,
      globalRateLimiterPendingWaiters: globalRateLimiter.pendingWaiters,
      globalRateLimiterCapacity: globalRateLimiter.capacity,
      globalRateLimiterRefillPerSecond: globalRateLimiter.refillPerSecond,
      foregroundRateLimiterAvailableTokens: foregroundRateLimiter.availableTokens,
      foregroundRateLimiterPendingWaiters: foregroundRateLimiter.pendingWaiters,
      foregroundRateLimiterCapacity: foregroundRateLimiter.capacity,
      foregroundRateLimiterRefillPerSecond: foregroundRateLimiter.refillPerSecond,
      mutationRateLimiterAvailableTokens: mutationRateLimiter.availableTokens,
      mutationRateLimiterPendingWaiters: mutationRateLimiter.pendingWaiters,
      mutationRateLimiterCapacity: mutationRateLimiter.capacity,
      mutationRateLimiterRefillPerSecond: mutationRateLimiter.refillPerSecond,
      backgroundRateLimiterAvailableTokens: backgroundRateLimiter.availableTokens,
      backgroundRateLimiterPendingWaiters: backgroundRateLimiter.pendingWaiters,
      backgroundRateLimiterCapacity: backgroundRateLimiter.capacity,
      backgroundRateLimiterRefillPerSecond: backgroundRateLimiter.refillPerSecond,
    };
  }
}

export const ragicRequestScheduler = new RagicRequestScheduler();
