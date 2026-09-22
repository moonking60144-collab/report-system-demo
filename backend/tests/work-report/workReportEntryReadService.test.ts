import assert from "node:assert/strict";
import test from "node:test";
import { AxiosError } from "axios";
import { HttpError } from "../../src/utils/httpError";
import { resolveWorkReportDataPath } from "../../src/config/env";
import { getFormConfig } from "../../src/config/forms";
import { ragicClient } from "../../src/ragic/client";
import { workReportSqliteRepository } from "../../src/storage/sqlite/workReportSqliteRepository";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
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

test("strict 工令讀取逾時回 typed 504，不能發布舊快照或再寫入", async t => {
  t.mock.method(workReportSqliteRepository, "getSyncState", async () => null);
  t.mock.method(ragicClient, "getEntry", async () => { throw new AxiosError("timeout", "ECONNABORTED"); });
  const persist = t.mock.method(workReportSqliteRepository, "upsertEntrySnapshot", async () => {
    assert.fail("TIMEOUT_CANNOT_PUBLISH_SNAPSHOT");
  });
  await assert.rejects(createEntryReadService().getReportByEntryId("901", "E-901", {
    refresh: true, allowSqliteFallbackOnRefresh: false, persistRefreshToSqlite: true,
  }), error => error instanceof HttpError && error.statusCode === 504 && error.code === "RAGIC_READ_TIMEOUT");
  assert.equal(persist.mock.callCount(), 0);
});

test("strict 完整工令拒絕 HTTP 200 application error 或空 payload，不誤判工令不存在", async t => {
  t.mock.method(workReportSqliteRepository, "getSyncState", async () => null);
  const internals = ragicClient as unknown as {
    axiosInstance: { get: () => Promise<{ status: number; data: unknown }> };
    runReadRequest: (label: string, request: () => Promise<unknown>) => Promise<unknown>;
  };
  t.mock.method(internals, "runReadRequest", async (_label: string, request: () => Promise<unknown>) => request());
  const persist = t.mock.method(workReportSqliteRepository, "upsertEntrySnapshot", async () => {
    assert.fail("INVALID_READ_CANNOT_PUBLISH_SNAPSHOT");
  });
  for (const [data, code] of [[{ status: "ERROR", msg: "permission denied" }, "RAGIC_READ_FAILED"], [{}, "RAGIC_READ_INVALID_RESPONSE"]] as const) {
    t.mock.method(internals.axiosInstance, "get", async () => ({ status: 200, data }));
    await assert.rejects(createEntryReadService().getReportByEntryId("901", "E-901", {
      refresh: true, allowSqliteFallbackOnRefresh: false, persistRefreshToSqlite: true,
    }), error => error instanceof HttpError && error.statusCode === 502 && error.code === code);
  }
  assert.equal(persist.mock.callCount(), 0);
});

test("只有工令讀取的 HTTP 404 暫停確認；關聯來源 404 保持可重試讀取錯誤", async t => {
  t.mock.method(workReportSqliteRepository, "getSyncState", async () => null);
  const missing = () => new AxiosError("not found", "ERR_BAD_REQUEST", undefined, undefined, {
    status: 404, data: {}, headers: {},
  } as never);
  t.mock.method(ragicClient, "getEntry", async (...args: Parameters<typeof ragicClient.getEntry>) => {
    assert.equal(args[3]?.strictResponse, true);
    throw missing();
  });
  await assert.rejects(createEntryReadService().getReportByEntryId("901", "E-901", { refresh: true }),
    error => error instanceof HttpError && error.statusCode === 404 && error.code === "REPORT_NOT_FOUND");
  t.mock.method(ragicClient, "getEntry", async () => ({ _ragicId: "E-901" }));
  const service = new WorkReportEntryReadService(new WorkReportReadSupport(), {
    prepareLinkedSourceMaps: async () => { throw missing(); },
  } as unknown as WorkReportOptionsReadService);
  await assert.rejects(service.getReportByEntryId("901", "E-901", { refresh: true }),
    error => error instanceof HttpError && error.statusCode === 502 && error.code === "RAGIC_LINKED_SOURCE_READ_FAILED");
});

test("strict 工令本身成功但關聯來源逾時也回 typed 504", async t => {
  t.mock.method(workReportSqliteRepository, "getSyncState", async () => null);
  t.mock.method(ragicClient, "getEntry", async () => ({ _ragicId: "E-901" }));
  const service = new WorkReportEntryReadService(new WorkReportReadSupport(), {
    prepareLinkedSourceMaps: async () => { throw new AxiosError("linked timeout", "ETIMEDOUT"); },
  } as unknown as WorkReportOptionsReadService);
  await assert.rejects(service.getReportByEntryId("901", "E-901", { refresh: true }),
    error => error instanceof HttpError && error.statusCode === 504 && error.code === "RAGIC_READ_TIMEOUT");
});

test("detail refresh=1 成功讀到 Ragic live 後會回寫 SQLite entry snapshot", async (t) => {
  const service = createEntryReadService();
  const config = getFormConfig("901");
  const expectedReadPath = resolveWorkReportDataPath("901", config.ragicPath);
  const upsertInputs: Array<{ formId: string; record: WorkReportRecord; snapshotAt: string }> = [];
  let touchSyncStateCalled = false;

  t.mock.method(workReportSqliteRepository, "getSyncState", async () => null);
  t.mock.method(ragicClient, "getEntry", async (formPath: string) => {
    assert.equal(formPath, expectedReadPath);
    return {
      _ragicId: "E-901",
      "9001040": "WO-901-new",
      "9001049": "未結案",
      "9001202": "2026/07/03 08:00:00",
    };
  });
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

  const record = await service.getReportByEntryId("901", "E-901", {
    refresh: true,
    persistRefreshToSqlite: true,
  });

  assert.equal(record.id, "E-901");
  assert.equal(record.workOrderNo, "WO-901-new");
  assert.equal(upsertInputs.length, 1);
  assert.equal(upsertInputs[0].formId, "901");
  assert.equal(upsertInputs[0].record.workOrderNo, "WO-901-new");
  assert.match(upsertInputs[0].snapshotAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(touchSyncStateCalled, false);
});

test("detail refresh=1 未要求 persistRefreshToSqlite 時不回寫 SQLite", async (t) => {
  const service = createEntryReadService();
  let upsertCalled = false;

  t.mock.method(workReportSqliteRepository, "getSyncState", async () => null);
  t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-901",
    "9001040": "WO-901-new",
    "9001049": "未結案",
  }));
  t.mock.method(workReportSqliteRepository, "upsertEntrySnapshot", async () => {
    upsertCalled = true;
    return { rowCount: 0 };
  });

  const record = await service.getReportByEntryId("901", "E-901", {
    refresh: true,
  });

  assert.equal(record.id, "E-901");
  assert.equal(upsertCalled, false);
});

test("detail SQLite fallback 會回傳 stale snapshot metadata", async (t) => {
  const service = createEntryReadService();

  t.mock.method(workReportSqliteRepository, "getSyncState", async () => ({
    formId: "901",
    status: "failed",
    taskId: "sync-901",
    startedAt: null,
    finishedAt: null,
    snapshotAt: "2026-08-14T00:00:00.000Z",
    activeGenerationId: "2026-08-14T00:00:00.000Z",
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
    totalEntries: 1,
    totalRows: 0,
    message: "同步失敗",
    updatedAt: "2026-08-14T00:01:00.000Z",
  }));
  t.mock.method(workReportSqliteRepository, "getReportByEntryId", async () => ({
    id: "E-901",
    workOrderNo: "WO-901",
    reports: [],
  }));

  const result = await service.getReportByEntryIdResult("901", "E-901");

  assert.equal(result.data.id, "E-901");
  assert.deepEqual(result.meta, {
    cacheSource: "sqlite",
    cacheState: "stale",
    snapshotAt: "2026-08-14T00:00:00.000Z",
  });
});
