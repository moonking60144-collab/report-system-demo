import { AxiosError } from "axios";
import { env } from "../config/env";
import { createLogger } from "../observability/logger";

const log = createLogger("ragic-read-retry");

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ENOTFOUND",
  "EPIPE",
]);

export interface ReadRetryLogPayload {
  event: "retry";
  label: string;
  priority?: string;
  timeoutMs?: number;
  attempt: number;
  maxRetries: number;
  waitMs: number;
  reason: string;
  scheduler?: unknown;
}

interface ReadRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  label?: string;
  priority?: string;
  timeoutMs?: number;
  getSchedulerStats?: () => unknown;
  retryLogSink?: (payload: ReadRetryLogPayload) => void;
}

export function isRetryableReadError(error: unknown): boolean {
  if (!(error instanceof AxiosError)) {
    return false;
  }

  const status = error.response?.status;
  if (status === 429) {
    return true;
  }
  if (typeof status === "number" && status >= 500) {
    return true;
  }
  if (typeof error.code === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(error.code)) {
    return true;
  }

  return false;
}

function getRetryErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (typeof status === "number") {
      return `HTTP ${status}`;
    }
    if (error.code) {
      return String(error.code);
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateBackoffDelay(baseDelayMs: number, attempt: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.floor(Math.random() * Math.max(1, Math.round(baseDelayMs * 0.3)));
  return exponential + jitter;
}

export async function runWithReadRetry<T>(
  task: () => Promise<T>,
  options: ReadRetryOptions = {}
): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? env.RAGIC_GET_RETRY_MAX);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? env.RAGIC_GET_RETRY_BASE_DELAY_MS);
  const label = options.label ?? "ragic-read";

  let attempt = 0;
  while (true) {
    try {
      return await task();
    } catch (error) {
      const shouldRetry = attempt < maxRetries && isRetryableReadError(error);
      if (!shouldRetry) {
        throw error;
      }

      const waitMs = calculateBackoffDelay(baseDelayMs, attempt);
      const payload: ReadRetryLogPayload = {
        event: "retry",
        label,
        ...(options.priority ? { priority: options.priority } : {}),
        ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
        attempt: attempt + 1,
        maxRetries,
        waitMs,
        reason: getRetryErrorMessage(error),
        ...(options.getSchedulerStats ? { scheduler: options.getSchedulerStats() } : {}),
      };
      if (options.retryLogSink) {
        options.retryLogSink(payload);
      } else {
        log.warn(payload);
      }

      await delay(waitMs);
      attempt += 1;
    }
  }
}
