import { describe, expect, it } from "vitest";
import type { SystemNoticeRecord } from "../../api/systemNotice";
import { resolveSystemNoticeAvailabilitySnapshot } from "./systemAvailability";

const NOW_MS = Date.parse("2026-08-27T02:00:00.000Z");

function notice(overrides: Partial<SystemNoticeRecord> = {}): SystemNoticeRecord {
  return {
    enabled: true,
    level: "warn",
    title: "系統更新",
    message: "系統更新中",
    maintenanceMode: true,
    maintenanceDecision: "manual-on",
    maintenanceSuggested: true,
    maintenanceSuggestedReasons: ["系統更新"],
    startAt: null,
    endAt: null,
    linkText: null,
    linkUrl: null,
    updatedAt: "2026-08-27T01:00:00.000Z",
    updatedBy: "DEMO_ADMIN",
    revision: 1,
    forceRefreshToken: null,
    ...overrides,
  };
}

describe("system notice availability cache", () => {
  it("已停用的維護公告不縮短斷線判斷門檻", () => {
    expect(
      resolveSystemNoticeAvailabilitySnapshot(notice({ enabled: false }), NOW_MS)
        .maintenanceMode
    ).toBe(false);
  });

  it("已超過結束時間的維護公告不再保留 maintenance 狀態", () => {
    expect(
      resolveSystemNoticeAvailabilitySnapshot(
        notice({ endAt: "2026-08-27T01:59:00.000Z" }),
        NOW_MS
      ).maintenanceMode
    ).toBe(false);
  });

  it("目前生效中的維護公告仍保留 maintenance 狀態", () => {
    expect(resolveSystemNoticeAvailabilitySnapshot(notice(), NOW_MS).maintenanceMode).toBe(
      true
    );
  });
});
