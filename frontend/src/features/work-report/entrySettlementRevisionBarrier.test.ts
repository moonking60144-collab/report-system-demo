import { describe, expect, it } from "vitest";
import { WorkReportEntrySettlementRevisionBarrier } from "./entrySettlementRevisionBarrier";

describe("WorkReportEntrySettlementRevisionBarrier", () => {
  it("Detail request 開始後才發布的 settlement 不會被較早 response 覆寫", () => {
    const barrier = new WorkReportEntrySettlementRevisionBarrier<{
      id: string;
      sortOrder: number;
    }>();
    const requestRevision = barrier.captureRevision();
    barrier.record("901", { id: "E-901", sortOrder: 11 });

    expect(
      barrier.mergeRecord("901", requestRevision, {
        id: "E-901",
        sortOrder: 9,
      })
    ).toEqual({ id: "E-901", sortOrder: 11 });
  });

  it("settlement 後才開始的 Detail request 可以發布更新 snapshot", () => {
    const barrier = new WorkReportEntrySettlementRevisionBarrier<{
      id: string;
      sortOrder: number;
    }>();
    barrier.record("901", { id: "E-901", sortOrder: 11 });
    const requestRevision = barrier.captureRevision();

    expect(
      barrier.mergeRecord("901", requestRevision, {
        id: "E-901",
        sortOrder: 12,
      })
    ).toEqual({ id: "E-901", sortOrder: 12 });
  });

  it("settlement 後才送出的 read model response 若資料版本較舊，仍保留已確認的新值", () => {
    const barrier = new WorkReportEntrySettlementRevisionBarrier<{
      id: string;
      sortOrder: number;
      lastUpdatedAt: string;
    }>();
    barrier.record("901", {
      id: "E-901",
      sortOrder: 11,
      lastUpdatedAt: "2026-09-03T02:00:02.000Z",
    });
    const requestRevision = barrier.captureRevision();

    expect(
      barrier.mergeRecord("901", requestRevision, {
        id: "E-901",
        sortOrder: 8,
        lastUpdatedAt: "2026-09-03T02:00:01.000Z",
      })
    ).toEqual({
      id: "E-901",
      sortOrder: 11,
      lastUpdatedAt: "2026-09-03T02:00:02.000Z",
    });

    expect(
      barrier.mergeRecord("901", requestRevision, {
        id: "E-901",
        sortOrder: 12,
        lastUpdatedAt: "2026-09-03T02:00:03.000Z",
      })
    ).toEqual({
      id: "E-901",
      sortOrder: 12,
      lastUpdatedAt: "2026-09-03T02:00:03.000Z",
    });
  });

  it("秒級時間相同但 mutation patch 尚未出現在 read model 時，保留 settlement", () => {
    const barrier = new WorkReportEntrySettlementRevisionBarrier<{
      id: string;
      sortOrder: number | string;
      lastUpdatedAt: string;
    }>();
    barrier.record(
      "901",
      {
        id: "E-901",
        sortOrder: 11,
        lastUpdatedAt: "2026-09-03T02:00:02.000Z",
      },
      { sortOrder: 11 }
    );
    const requestRevision = barrier.captureRevision();

    expect(
      barrier.mergeRecord("901", requestRevision, {
        id: "E-901",
        sortOrder: 8,
        lastUpdatedAt: "2026-09-03T02:00:02.000Z",
      })
    ).toEqual({
      id: "E-901",
      sortOrder: 11,
      lastUpdatedAt: "2026-09-03T02:00:02.000Z",
    });

    expect(
      barrier.mergeRecord("901", requestRevision, {
        id: "E-901",
        sortOrder: "11",
        lastUpdatedAt: "2026-09-03T02:00:02.000Z",
      })
    ).toEqual({
      id: "E-901",
      sortOrder: "11",
      lastUpdatedAt: "2026-09-03T02:00:02.000Z",
    });
  });

  it("較舊 snapshot 即使含相同 patch，也不會取代較新的 settlement 其他欄位", () => {
    const barrier = new WorkReportEntrySettlementRevisionBarrier<{
      id: string;
      sortOrder: number;
      machineCode: string;
      lastUpdatedAt: string;
    }>();
    barrier.record(
      "901",
      {
        id: "E-901",
        sortOrder: 11,
        machineCode: "MA02",
        lastUpdatedAt: "2026-09-03T02:00:02.000Z",
      },
      { sortOrder: 11 }
    );
    const requestRevision = barrier.captureRevision();

    expect(
      barrier.mergeRecord("901", requestRevision, {
        id: "E-901",
        sortOrder: 11,
        machineCode: "MA01",
        lastUpdatedAt: "2026-09-03T02:00:01.000Z",
      })
    ).toEqual({
      id: "E-901",
      sortOrder: 11,
      machineCode: "MA02",
      lastUpdatedAt: "2026-09-03T02:00:02.000Z",
    });
  });

  it("filtered preview 不會把 response 已排除的 settlement 重新補回", () => {
    const barrier = new WorkReportEntrySettlementRevisionBarrier<{
      id: string;
      machineCode: string;
    }>();
    const requestRevision = barrier.captureRevision();
    barrier.record("901", { id: "E-901", machineCode: "MA02" });

    expect(
      barrier.mergeRecords("901", requestRevision, [], {
        includeMissingSettlements: false,
      })
    ).toEqual([]);
  });
});
