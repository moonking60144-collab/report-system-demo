import { LoginRateLimiter, type LoginRateLimitResult } from "../auth/loginRateLimiter";
import { HttpError } from "../../utils/httpError";

export interface MeetingLibraryAccessAttemptIdentity {
  clientId: unknown;
  ip: unknown;
}

export interface MeetingLibraryAccessAttemptGuardOptions {
  clientMaxFailures?: number;
  ipMaxFailures?: number;
  windowMs?: number;
  lockMs?: number;
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1_000;
const DEFAULT_LOCK_MS = 10 * 60 * 1_000;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function normalizeClientId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return CLIENT_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeIp(value: unknown): string {
  return String(value ?? "unknown").trim().slice(0, 128) || "unknown";
}

export class MeetingLibraryAccessAttemptGuard {
  private readonly clientLimiter: LoginRateLimiter;
  private readonly ipLimiter: LoginRateLimiter;

  constructor(options: MeetingLibraryAccessAttemptGuardOptions = {}) {
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const lockMs = options.lockMs ?? DEFAULT_LOCK_MS;
    this.clientLimiter = new LoginRateLimiter({
      maxFailures: options.clientMaxFailures ?? 10,
      windowMs,
      lockMs,
      now: options.now,
    });
    this.ipLimiter = new LoginRateLimiter({
      maxFailures: options.ipMaxFailures ?? 100,
      windowMs,
      lockMs,
      now: options.now,
    });
  }

  assertAllowed(identity: MeetingLibraryAccessAttemptIdentity): void {
    this.throwIfLimited(this.check(identity));
  }

  recordFailure(identity: MeetingLibraryAccessAttemptIdentity): void {
    const keys = this.keys(identity);
    const clientState = keys.client
      ? this.clientLimiter.recordFailure(keys.client)
      : null;
    const ipState = this.ipLimiter.recordFailure(keys.ip);
    this.throwIfLimited([clientState, ipState]);
  }

  recordSuccess(identity: MeetingLibraryAccessAttemptIdentity): void {
    const keys = this.keys(identity);
    if (keys.client) this.clientLimiter.recordSuccess(keys.client);
  }

  reset(): void {
    this.clientLimiter.reset();
    this.ipLimiter.reset();
  }

  private check(
    identity: MeetingLibraryAccessAttemptIdentity
  ): Array<LoginRateLimitResult | null> {
    const keys = this.keys(identity);
    return [
      keys.client ? this.clientLimiter.check(keys.client) : null,
      this.ipLimiter.check(keys.ip),
    ];
  }

  private keys(identity: MeetingLibraryAccessAttemptIdentity): {
    client: string | null;
    ip: string;
  } {
    const clientId = normalizeClientId(identity.clientId);
    return {
      client: clientId ? `client:${clientId}` : null,
      ip: `ip:${normalizeIp(identity.ip)}`,
    };
  }

  private throwIfLimited(states: Array<LoginRateLimitResult | null>): void {
    const retryAfterMs = states.reduce(
      (max, state) => (state?.limited ? Math.max(max, state.retryAfterMs) : max),
      0
    );
    if (retryAfterMs <= 0) return;
    throw new HttpError(
      429,
      `錄音庫存取碼嘗試次數過多，請 ${Math.ceil(retryAfterMs / 1000)} 秒後再試。`,
      "MEETING_LIBRARY_ACCESS_RATE_LIMITED"
    );
  }
}
