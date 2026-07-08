import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AxiosError, type AxiosResponse } from "axios";
import { workReportService } from "../../src/services/workReportService";
import { workReportReadService } from "../../src/services/work-report/workReportReadService";
import { workReportSqliteRepository } from "../../src/storage/sqlite/workReportSqliteRepository";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
import type { WorkReportRecord } from "../../src/types/workReport";
import { HttpError } from "../../src/utils/httpError";

function createRecord(overrides: Partial<WorkReportRecord> = {}): WorkReportRecord {
  return {
    id: "E-104",
    workOrderNo: "WO-26060001",
    lastUpdatedAt: "2026-06-24T01:00:00.000Z",
    status: "未結案",
    reports: [
      {
        rowId: "1001",
        processCode: "P10",
        productionQty: "12",
        partNoDisplay: "舊料號顯示",
      },
    ],
    ...overrides,
  };
}

function installPreconditionStubs(
  t: TestContext,
  input: {
    sqliteRecord: WorkReportRecord | null;
    liveRecord: WorkReportRecord;
  }
): void {
  const originalGetLive = workReportReadService.getReportByEntryId;
  const originalGetSyncState = workReportSqliteRepository.getSyncState;
  const originalGetSqliteRecord = workReportSqliteRepository.getReportByEntryId;

  workReportReadService.getReportByEntryId = async (_formId, _entryId, options) => {
    assert.equal(options?.refresh, true);
    assert.equal(options?.priority, "mutation");
    assert.equal(typeof options?.ragicReadTimeoutMs, "number");
    assert.equal(typeof options?.ragicReadMaxRetries, "number");
    return input.liveRecord;
  };
  workReportSqliteRepository.getSyncState = async (formId) => ({
    formId,
    status: "synced",
    taskId: null,
    startedAt: null,
    finishedAt: "2026-06-24T01:00:00.000Z",
    snapshotAt: "2026-06-24T01:00:00.000Z",
    activeGenerationId: "2026-06-24T01:00:00.000Z",
    readModelVersion: READ_MODEL_SCHEMA_VERSION,
    totalEntries: 1,
    totalRows: 1,
    message: null,
    updatedAt: "2026-06-24T01:00:00.000Z",
  });
  workReportSqliteRepository.getReportByEntryId = async () => input.sqliteRecord;

  t.after(() => {
    workReportReadService.getReportByEntryId = originalGetLive;
    workReportSqliteRepository.getSyncState = originalGetSyncState;
    workReportSqliteRepository.getReportByEntryId = originalGetSqliteRecord;
  });
}

function installLiveReadErrorStub(t: TestContext, error: unknown): void {
  const originalGetLive = workReportReadService.getReportByEntryId;
  workReportReadService.getReportByEntryId = async (_formId, _entryId, options) => {
    assert.equal(options?.refresh, true);
    assert.equal(options?.priority, "mutation");
    throw error;
  };

  t.after(() => {
    workReportReadService.getReportByEntryId = originalGetLive;
  });
}

async function assertRejectsAsStaleCheckUnavailable(): Promise<void> {
  await assert.rejects(
    () => workReportService.assertEntryNotModified("104", "E-104", "2026-06-24T01:00:00.000Z"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 504 &&
      error.code === "RAGIC_STALE_CHECK_UNAVAILABLE" &&
      /尚未執行寫入/.test(error.message)
  );
}

function createAxiosResponseError(status: number): AxiosError {
  const response = {
    status,
    statusText: "Service Unavailable",
    headers: {},
    config: { headers: {} },
    data: {},
  } as AxiosResponse;
  return new AxiosError(
    `Request failed with status code ${status}`,
    undefined,
    undefined,
    undefined,
    response
  );
}

test("assertEntryNotModified 允許只有 lastUpdatedAt 漂移的 live Ragic 結果", async (t) => {
  const sqliteRecord = createRecord();
  const liveRecord = createRecord({
    lastUpdatedAt: "2026-06-24T01:05:00.000Z",
    reports: [
      {
        rowId: "1001",
        processCode: "P10",
        productionQty: "12",
        partNoDisplay: "新料號顯示",
      },
    ],
  });
  installPreconditionStubs(t, { sqliteRecord, liveRecord });

  await assert.doesNotReject(() =>
    workReportService.assertEntryNotModified("104", "E-104", "2026-06-24T01:00:00.000Z")
  );
});

test("assertEntryNotModified 在 live Ragic 內容真的改變時維持 409", async (t) => {
  const sqliteRecord = createRecord();
  const liveRecord = createRecord({
    lastUpdatedAt: "2026-06-24T01:05:00.000Z",
    reports: [
      {
        rowId: "1001",
        processCode: "P10",
        productionQty: "13",
        partNoDisplay: "舊料號顯示",
      },
    ],
  });
  installPreconditionStubs(t, { sqliteRecord, liveRecord });

  await assert.rejects(
    () => workReportService.assertEntryNotModified("104", "E-104", "2026-06-24T01:00:00.000Z"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_CONFLICT"
  );
});

test("assertEntryNotModified 不用不符合 expected timestamp 的 SQLite snapshot 放行", async (t) => {
  const sqliteRecord = createRecord({
    lastUpdatedAt: "2026-06-24T00:55:00.000Z",
  });
  const liveRecord = createRecord({
    lastUpdatedAt: "2026-06-24T01:05:00.000Z",
  });
  installPreconditionStubs(t, { sqliteRecord, liveRecord });

  await assert.rejects(
    () => workReportService.assertEntryNotModified("104", "E-104", "2026-06-24T01:00:00.000Z"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_CONFLICT"
  );
});

test("assertEntryNotModified 在 Ragic stale check 逾時時回 typed 504 且不放行寫入", async (t) => {
  const timeoutError = new Error("timeout of 10000ms exceeded") as Error & { code?: string };
  timeoutError.code = "ECONNABORTED";
  installLiveReadErrorStub(t, timeoutError);

  await assertRejectsAsStaleCheckUnavailable();
});

for (const code of ["ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"] as const) {
  test(`assertEntryNotModified 將 retryable Ragic read 網路錯誤 ${code} 轉成 typed 504`, async (t) => {
    installLiveReadErrorStub(t, new AxiosError(code, code));

    await assertRejectsAsStaleCheckUnavailable();
  });
}

test("assertEntryNotModified 將 retryable Ragic read HTTP 5xx 轉成 typed 504", async (t) => {
  installLiveReadErrorStub(t, createAxiosResponseError(503));

  await assertRejectsAsStaleCheckUnavailable();
});
