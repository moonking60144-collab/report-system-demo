import { env } from "../../config/env";

export interface LoginRateLimiterOptions {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  now?: () => number;
}

export interface LoginRateLimitResult {
  limited: boolean;
  retryAfterMs: number;
  failedCount: number;
}

interface LoginFailureRecord {
  firstFailureMs: number;
  failedCount: number;
  lockedUntilMs: number | null;
}

export class LoginRateLimiter {
  private readonly records = new Map<string, LoginFailureRecord>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;

  constructor(options: LoginRateLimiterOptions) {
    this.maxFailures = Math.max(1, Math.trunc(options.maxFailures));
    this.windowMs = Math.max(1, Math.trunc(options.windowMs));
    this.lockMs = Math.max(1, Math.trunc(options.lockMs));
    this.now = options.now ?? Date.now;
  }

  check(key: string): LoginRateLimitResult {
    const now = this.now();
    this.cleanup(now);
    const record = this.records.get(key);
    if (!record) {
      return { limited: false, retryAfterMs: 0, failedCount: 0 };
    }
    if (record.lockedUntilMs && record.lockedUntilMs > now) {
      return {
        limited: true,
        retryAfterMs: record.lockedUntilMs - now,
        failedCount: record.failedCount,
      };
    }
    if (now - record.firstFailureMs >= this.windowMs) {
      this.records.delete(key);
      return { limited: false, retryAfterMs: 0, failedCount: 0 };
    }
    return { limited: false, retryAfterMs: 0, failedCount: record.failedCount };
  }

  recordFailure(key: string): LoginRateLimitResult {
    const now = this.now();
    this.cleanup(now);
    const existing = this.records.get(key);
    const record =
      existing && now - existing.firstFailureMs < this.windowMs
        ? existing
        : { firstFailureMs: now, failedCount: 0, lockedUntilMs: null };

    record.failedCount += 1;
    if (record.failedCount >= this.maxFailures) {
      record.lockedUntilMs = now + this.lockMs;
    }
    this.records.set(key, record);
    return this.check(key);
  }

  recordSuccess(key: string): void {
    this.records.delete(key);
  }

  reset(): void {
    this.records.clear();
  }

  private cleanup(now: number): void {
    for (const [key, record] of this.records.entries()) {
      const lockExpired = !record.lockedUntilMs || record.lockedUntilMs <= now;
      const windowExpired = now - record.firstFailureMs >= this.windowMs;
      if (lockExpired && windowExpired) {
        this.records.delete(key);
      }
    }
  }
}

export function buildLoginRateLimitKey(input: {
  clientKey: unknown;
  username: unknown;
}): string {
  const clientKey = String(input.clientKey ?? "unknown").trim() || "unknown";
  const username = String(input.username ?? "").trim().toLowerCase() || "(blank)";
  return `${clientKey}|${username}`;
}

export const systemNoticeLoginRateLimiter = new LoginRateLimiter({
  maxFailures: env.NOTICE_LOGIN_MAX_FAILURES,
  windowMs: env.NOTICE_LOGIN_WINDOW_MS,
  lockMs: env.NOTICE_LOGIN_LOCK_MS,
});
