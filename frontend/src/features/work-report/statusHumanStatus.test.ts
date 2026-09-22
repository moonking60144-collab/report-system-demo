import { describe, expect, it } from "vitest";
import { deriveWorkReportHumanStatus } from "./statusHumanStatus";

const t = (key: string, options?: Record<string, unknown>): string =>
  `${key}:${String(options?.snapshot ?? "")}:${String(options?.error ?? "")}`;

function createHydration(overrides: Partial<Parameters<typeof deriveWorkReportHumanStatus>[0]["hydration"]> = {}) {
  return {
    shouldUseFullHydrationForList: false,
    hasHydratedAllRecords: false,
    backendSnapshotAt: "2026-08-14T00:00:00.000Z",
    truncated: false,
    truncatedCount: 0,
    realtimeConnected: true,
    realtimeDisconnectedSince: null,
    previewRevalidating: false,
    previewRevalidationError: null,
    ...overrides,
  };
}

describe("deriveWorkReportHumanStatus", () => {
  it("背景 read-model 狀態不覆蓋一般使用者看到的可用資料狀態", () => {
    const result = deriveWorkReportHumanStatus({
      t,
      hydration: createHydration(),
      isSyncingFromRagic: false,
      loading: false,
      error: null,
      summarySnapshotText: "2026/08/14 08:00:00",
    });

    expect(result.tone).toBe("success");
    expect(result.title).toContain("readyTitle");
    expect(result.detail).toContain("08/14");
  });

  it("快取重驗失敗時顯示非阻斷 warning，不把可用資料當成整頁錯誤", () => {
    const result = deriveWorkReportHumanStatus({
      t,
      hydration: createHydration({
        previewRevalidationError: "network timeout",
      }),
      isSyncingFromRagic: false,
      loading: false,
      error: null,
      summarySnapshotText: "2026/08/14 08:00:00",
    });

    expect(result.tone).toBe("warn");
    expect(result.title).toContain("revalidationFailedTitle");
    expect(result.detail).toContain("network timeout");
  });
});
