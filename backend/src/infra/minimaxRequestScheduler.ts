import { env } from "../config/env";

export class MiniMaxRequestQueueTimeoutError extends Error {
  constructor() {
    super("MiniMax request queue timeout");
    this.name = "MiniMaxRequestQueueTimeoutError";
  }
}

export class MiniMaxRequestQueueAbortedError extends Error {
  constructor() {
    super("MiniMax request queue aborted");
    this.name = "MiniMaxRequestQueueAbortedError";
  }
}

export interface MiniMaxRequestSchedulerStats {
  active: number;
  pending: number;
  maxConcurrency: number;
}

export interface MiniMaxRequestSchedulerLike {
  run<T>(
    worker: () => Promise<T>,
    options?: { signal?: AbortSignal; queueTimeoutMs?: number }
  ): Promise<T>;
}

interface QueueItem {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
}

export class MiniMaxRequestScheduler implements MiniMaxRequestSchedulerLike {
  private active = 0;
  private readonly queue: QueueItem[] = [];

  constructor(private readonly maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("MiniMax scheduler concurrency must be a positive integer");
    }
  }

  async run<T>(
    worker: () => Promise<T>,
    options: { signal?: AbortSignal; queueTimeoutMs?: number } = {}
  ): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await worker();
    } finally {
      release();
    }
  }

  getStats(): MiniMaxRequestSchedulerStats {
    return {
      active: this.active,
      pending: this.queue.length,
      maxConcurrency: this.maxConcurrency,
    };
  }

  private acquire(options: {
    signal?: AbortSignal;
    queueTimeoutMs?: number;
  }): Promise<() => void> {
    if (options.signal?.aborted) {
      return Promise.reject(new MiniMaxRequestQueueAbortedError());
    }
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const item: QueueItem = { resolve, reject, signal: options.signal };
      item.onAbort = () => {
        if (!this.removeQueuedItem(item)) return;
        reject(new MiniMaxRequestQueueAbortedError());
      };
      item.signal?.addEventListener("abort", item.onAbort, { once: true });
      if (options.queueTimeoutMs && options.queueTimeoutMs > 0) {
        item.timeout = setTimeout(() => {
          if (!this.removeQueuedItem(item)) return;
          reject(new MiniMaxRequestQueueTimeoutError());
        }, options.queueTimeoutMs);
      }
      this.queue.push(item);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        this.cleanupQueueItem(next);
        next.resolve(this.createRelease());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }

  private removeQueuedItem(item: QueueItem): boolean {
    const index = this.queue.indexOf(item);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    this.cleanupQueueItem(item);
    return true;
  }

  private cleanupQueueItem(item: QueueItem): void {
    if (item.timeout) clearTimeout(item.timeout);
    if (item.onAbort) item.signal?.removeEventListener("abort", item.onAbort);
  }
}

export const minimaxRequestScheduler = new MiniMaxRequestScheduler(
  env.MINIMAX_REQUEST_CONCURRENCY
);
