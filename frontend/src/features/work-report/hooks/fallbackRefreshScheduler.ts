interface FallbackRefreshSchedulerOptions {
  shouldDefer: () => boolean;
  refresh: () => void | Promise<void>;
  refreshIntervalMs?: number;
  busyRetryMs?: number;
}

export function startFallbackRefreshScheduler({
  shouldDefer,
  refresh,
  refreshIntervalMs = 60_000,
  busyRetryMs = 5_000,
}: FallbackRefreshSchedulerOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(attemptRefresh, delayMs);
  };
  const attemptRefresh = () => {
    if (shouldDefer()) {
      schedule(busyRetryMs);
      return;
    }
    void Promise.resolve(refresh()).then(
      () => schedule(refreshIntervalMs),
      () => schedule(refreshIntervalMs)
    );
  };

  schedule(refreshIntervalMs);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
