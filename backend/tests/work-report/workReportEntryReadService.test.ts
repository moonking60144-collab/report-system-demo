import assert from "node:assert/strict";
import test from "node:test";
import { ragicClient } from "../../src/ragic/client";
import { workReportSqliteRepository } from "../../src/storage/sqlite/workReportSqliteRepository";
import type { WorkReportRecord } from "../../src/types/workReport";
import { WorkReportEntryReadService } from "../../src/services/work-report/workReportEntryReadService";
import { WorkReportReadSupport } from "../../src/services/work-report/shared/workReportReadSupport";
import type { WorkReportOptionsReadService } from "../../src/services/work-report/workReportOptionsReadService";

function createEntryReadService(): WorkReportEntryReadService {
  return new WorkReportEntryReadService(
    new WorkReportReadSupport(),
    {
      prepareLinkedSourceMaps: async () => new Map(),
    } as unknown as WorkReportOptionsReadService
  );
}

test("detail refresh=1 成功讀到 Ragic live 後會回寫 SQLite entry snapshot", async (t) => {
  const service = createEntryReadService();
  const upsertInputs: Array<{ formId: string; record: WorkReportRecord; snapshotAt: string }> = [];
  let touchSyncStateCalled = false;

  t.mock.method(workReportSqliteRepository, "getSyncState", async () => null);
  t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-104",
    "1005984": "WO-104-new",
    "1006393": "未結案",
    "109": "2026/07/03 08:00:00",
  }));
  t.mock.method(workReportSqliteRepository, "upsertEntrySnapshot", async (
    formId: string,
    record: WorkReportRecord,
    snapshotAt: string
  ) => {
    upsertInputs.push({ formId, record, snapshotAt });
    return { rowCount: 0 };
  });
  t.mock.method(workReportSqliteRepository, "touchSyncStateSnapshot", async (
    _formId: string,
    _snapshotAt: string,
    _message: string | null
  ) => {
    touchSyncStateCalled = true;
  });

  const record = await service.getReportByEntryId("104", "E-104", {
    refresh: true,
    persistRefreshToSqlite: true,
  });

  assert.equal(record.id, "E-104");
  assert.equal(record.workOrderNo, "WO-104-new");
  assert.equal(upsertInputs.length, 1);
  assert.equal(upsertInputs[0].formId, "104");
  assert.equal(upsertInputs[0].record.workOrderNo, "WO-104-new");
  assert.match(upsertInputs[0].snapshotAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(touchSyncStateCalled, false);
});

test("detail refresh=1 未要求 persistRefreshToSqlite 時不回寫 SQLite", async (t) => {
  const service = createEntryReadService();
  let upsertCalled = false;

  t.mock.method(workReportSqliteRepository, "getSyncState", async () => null);
  t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-104",
    "1005984": "WO-104-new",
    "1006393": "未結案",
  }));
  t.mock.method(workReportSqliteRepository, "upsertEntrySnapshot", async () => {
    upsertCalled = true;
    return { rowCount: 0 };
  });

  const record = await service.getReportByEntryId("104", "E-104", {
    refresh: true,
  });

  assert.equal(record.id, "E-104");
  assert.equal(upsertCalled, false);
});
