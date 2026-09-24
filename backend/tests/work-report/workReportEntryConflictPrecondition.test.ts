import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AxiosError, type AxiosResponse } from "axios";
import { workReportService } from "../../src/services/workReportService";
import { workReportReadService } from "../../src/services/work-report/workReportReadService";
import { workReportSqliteRepository } from "../../src/storage/sqlite/workReportSqliteRepository";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
import type { WorkReportRecord } from "../../src/types/workReport";
import { HttpError } from "../../src/utils/httpError";
import { buildEntrySnapshotHash } from "../../src/services/work-report/shared/entrySnapshotHash";
import { getFormConfig } from "../../src/config/forms";
import { transformRow } from "../../src/services/work-report/queries/rowTransform";

function createRecord(overrides: Partial<WorkReportRecord> = {}): WorkReportRecord {
  return {
    id: "E-901",
    workOrderNo: "WO-DEMO-0004",
    lastUpdatedAt: "2026-06-24T01:00:00.000Z",
    status: "未結案",
    reports: [
      {
        rowId: "1001",
        processCode: "MB50",
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
    () => workReportService.assertEntryNotModified("901", "E-901", "2026-06-24T01:00:00.000Z"),
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
        processCode: "MB50",
        productionQty: "12",
        partNoDisplay: "新料號顯示",
      },
    ],
  });
  installPreconditionStubs(t, { sqliteRecord, liveRecord });

  await assert.doesNotReject(() =>
    workReportService.assertEntryNotModified("901", "E-901", "2026-06-24T01:00:00.000Z")
  );
});

test("assertEntryNotModified 在 live Ragic 內容真的改變時維持 409", async (t) => {
  const sqliteRecord = createRecord();
  const liveRecord = createRecord({
    lastUpdatedAt: "2026-06-24T01:05:00.000Z",
    reports: [
      {
        rowId: "1001",
        processCode: "MB50",
        productionQty: "13",
        partNoDisplay: "舊料號顯示",
      },
    ],
  });
  installPreconditionStubs(t, { sqliteRecord, liveRecord });

  await assert.rejects(
    () => workReportService.assertEntryNotModified("901", "E-901", "2026-06-24T01:00:00.000Z"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_CONFLICT"
  );
});

test("assertEntryNotModified 找不到使用者原版本時不把未知誤稱為內容衝突", async (t) => {
  const sqliteRecord = createRecord({
    lastUpdatedAt: "2026-06-24T00:55:00.000Z",
  });
  const liveRecord = createRecord({
    lastUpdatedAt: "2026-06-24T01:05:00.000Z",
  });
  installPreconditionStubs(t, { sqliteRecord, liveRecord });

  await assert.rejects(
    () => workReportService.assertEntryNotModified("901", "E-901", "2026-06-24T01:00:00.000Z"),
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_BASELINE_UNAVAILABLE"
  );
});

for (const formId of ["901", "902"] as const) {
  test(`${formId} Demo 欄位轉換後，Callback 先更新快照不誤擋純時間漂移`, async (t) => {
    const config = getFormConfig(formId);
    const processSource = config.linkedFields?.processCode;
    assert.ok(processSource);
    const entryId = `E-${formId}`;
    const makeRecord = (updatedAt: string, productionQty: string, display: string) =>
      transformRow({
        entryId,
        data: {
          _ragicId: entryId,
          [config.mainFields.workOrderNo]: "WO-DEMO-0004",
          [config.mainFields.status]: "未結案",
          [config.mainFields.lastUpdatedAt]: updatedAt,
          [config.subtableId]: {
            "1001": {
              [config.subtableFields.processCode]: "MB50",
              [config.subtableFields.productionQty]: productionQty,
            },
          },
        },
      }, config, new Map([["processCode", new Map([["MB50", { [processSource.displayFieldId]: display }]])]]));
    const viewedRecord = makeRecord("2026-06-24T01:00:00.000Z", "12", "舊製程顯示");
    const callbackRecord = makeRecord("2026-06-24T01:05:00.000Z", "12", "新製程顯示");
    const records = { sqliteRecord: viewedRecord, liveRecord: callbackRecord };
    installPreconditionStubs(t, records);
    const shown = await workReportReadService.getReportByEntryIdResult(formId, entryId);
    assert.match(shown.data.entrySnapshotHash ?? "", /^sha256:[a-f0-9]{64}$/);
    records.sqliteRecord = callbackRecord;

    await assert.doesNotReject(() => workReportService.assertEntryNotModified(formId, entryId,
      String(shown.data.lastUpdatedAt), { expectedEntrySnapshotHash: shown.data.entrySnapshotHash }));

    const changedRecord = makeRecord("2026-06-24T01:05:00.000Z", "13", "新製程顯示");
    records.sqliteRecord = changedRecord;
    records.liveRecord = changedRecord;
    await assert.rejects(() => workReportService.assertEntryNotModified(formId, entryId,
      String(shown.data.lastUpdatedAt), { expectedEntrySnapshotHash: shown.data.entrySnapshotHash }),
    (error) => error instanceof HttpError && error.code === "ENTRY_CONFLICT");
  });
}

test("Callback 已覆蓋 SQLite 時保留使用者原 hash，可放行純時間漂移", async (t) => {
  const viewedRecord = createRecord();
  const callbackRecord = createRecord({ lastUpdatedAt: "2026-06-24T01:05:00.000Z" });
  installPreconditionStubs(t, { sqliteRecord: callbackRecord, liveRecord: callbackRecord });
  await assert.doesNotReject(() => workReportService.assertEntryNotModified("901", "E-901",
    String(viewedRecord.lastUpdatedAt), { expectedEntrySnapshotHash: buildEntrySnapshotHash(viewedRecord) }));
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

test("新舊讀取模型的明細 hash metadata 不構成業務資料衝突", async (t) => {
  const sqliteRecord = createRecord();
  installPreconditionStubs(t, {
    sqliteRecord,
    liveRecord: createRecord({ lastUpdatedAt: "new", reports: sqliteRecord.reports.map(row => ({ ...row, snapshotHash: "new-derived-hash" })) }),
  });
  await workReportService.assertEntryNotModified("901", "E-901", String(sqliteRecord.lastUpdatedAt));
});
