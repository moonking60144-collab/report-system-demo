export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerStateChange {
  name: string;
  from: CircuitState;
  to: CircuitState;
  consecutiveFailures: number;
  /** OPEN 時帶 cooldown 結束 epoch；其他狀態為 0 */
  cooldownEndsAt: number;
}

interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
  /** 狀態轉換時觸發；caller 可掛 log / metric。OPEN ↔ half-open ↔ closed 都會發 */
  onStateChange?: (change: CircuitBreakerStateChange) => void;
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly name: string, public readonly retryAfterMs: number) {
    super(`circuit breaker [${name}] is OPEN, retry after ${retryAfterMs}ms`);
    this.name = "CircuitBreakerOpenError";
  }
}

// 連續失敗超過 threshold → OPEN，cooldown 期間直接 fast-fail
// cooldown 過後 HALF_OPEN 放一個探測請求：成功回 CLOSED，失敗立刻回 OPEN 再 cooldown 一次
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly onStateChange?: (change: CircuitBreakerStateChange) => void;

  constructor(
    private readonly name: string,
    options: CircuitBreakerOptions
  ) {
    this.failureThreshold = options.failureThreshold;
    this.cooldownMs = options.cooldownMs;
    this.now = options.now ?? (() => Date.now());
    this.onStateChange = options.onStateChange;
  }

  checkBeforeRun(): void {
    if (this.state === "open") {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new CircuitBreakerOpenError(this.name, this.cooldownMs - elapsed);
      }
      this.transition("half-open");
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== "closed") {
      this.transition("closed");
    }
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === "half-open") {
      this.openedAt = this.now();
      this.transition("open");
      return;
    }
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.transition("open");
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  /** 內部狀態轉換 + 觸發 listener */
  private transition(next: CircuitState): void {
    const prev = this.state;
    if (prev === next) {
      return;
    }
    this.state = next;
    if (this.onStateChange) {
      this.onStateChange({
        name: this.name,
        from: prev,
        to: next,
        consecutiveFailures: this.consecutiveFailures,
        cooldownEndsAt: next === "open" ? this.openedAt + this.cooldownMs : 0,
      });
    }
  }
}
