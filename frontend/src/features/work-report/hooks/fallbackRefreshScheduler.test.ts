import { afterEach, describe, expect, test, vi } from "vitest";
import { startFallbackRefreshScheduler } from "./fallbackRefreshScheduler";

describe("fallback refresh scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("斷線滿一個週期時若忙碌，解除後只等待短 retry，不重算完整週期", async () => {
    vi.useFakeTimers();
    let busy = true;
    let refreshCalls = 0;
    const stop = startFallbackRefreshScheduler({
      shouldDefer: () => busy,
      refresh: () => {
        refreshCalls += 1;
      },
      refreshIntervalMs: 60_000,
      busyRetryMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshCalls).toBe(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(refreshCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshCalls).toBe(1);

    stop();
  });

  test("停止後不再執行後續 refresh", async () => {
    vi.useFakeTimers();
    let refreshCalls = 0;
    const stop = startFallbackRefreshScheduler({
      shouldDefer: () => false,
      refresh: () => {
        refreshCalls += 1;
      },
      refreshIntervalMs: 60_000,
    });

    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshCalls).toBe(0);
  });
});
