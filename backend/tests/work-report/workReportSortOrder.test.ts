import assert from "node:assert/strict";
import test from "node:test";
import { resolveWritePath } from "../../src/config/env";
import { getFormConfig } from "../../src/config/forms";
import {
  ragicClient,
  type RagicReadRequestOptions,
  type RagicRecord,
  type RagicWriteMethod,
  type RagicWriteOptions,
} from "../../src/ragic/client";
import type { RagicReadPriority } from "../../src/infra/ragicRequestScheduler";
import { workReportService } from "../../src/services/workReportService";
import { workReportReadService } from "../../src/services/work-report/workReportReadService";
import { WorkReportWorkOrderCommandService } from "../../src/services/work-report/mutation/workReportWorkOrderCommandService";
import { isActivityLogMutationWriteIndeterminateError } from "../../src/services/activityLog/activityLogIdempotencyService";
import { HttpError, UpstreamError } from "../../src/utils/httpError";

test("updateSortOrder 寫入主表欄位後會從相同 write target 回讀驗證", async (t) => {
  const config = getFormConfig("901");
  const writePath = resolveWritePath("901", config.ragicPath);
  assert.ok(writePath);
  let getEntryCalls = 0;

  const getEntryMock = t.mock.method(
    ragicClient,
    "getEntry",
    async (
      formPath: string,
      entryId: string,
      useCache: boolean,
      options?: RagicReadRequestOptions
    ) => {
      getEntryCalls += 1;
      assert.equal(formPath, writePath);
      assert.equal(entryId, "E-901");
      assert.equal(useCache, false);
      assert.equal(options?.priority, "mutation");
      assert.equal(options?.includeSubtables, getEntryCalls === 1 ? false : true);
      return {
        _ragicId: "E-901",
        "9001063": getEntryCalls === 1 ? "2" : "4",
      };
    }
  );
  const updateEntryMock = t.mock.method(
    ragicClient,
    "updateEntry",
    async (
      formPath: string,
      entryId: string,
      body: RagicRecord,
      method: RagicWriteMethod,
      options: boolean | RagicWriteOptions
    ) => {
      assert.equal(formPath, writePath);
      assert.equal(entryId, "E-901");
      assert.deepEqual(body, { "9001063": 4 });
      assert.equal(method, "PATCH");
      assert.deepEqual(options, {
        doWorkflow: false,
        doFormula: false,
      });
      return {};
    }
  );
  t.mock.method(ragicClient, "clearFormCache", () => undefined);
  const result = await workReportService.updateSortOrder("901", "E-901", 4, { expectedSortOrder: 2 });

  assert.deepEqual(result, {
    sortOrder: 4,
    previousSortOrder: 2,
    changed: true,
  });
  assert.equal(getEntryMock.mock.callCount(), 2);
  assert.equal(updateEntryMock.mock.callCount(), 1);
});

test("Form 902 updateSortOrder 只走 raw entry，不建立 linked-source 完整 record", async (t) => {
  const config = getFormConfig("902");
  const writePath = resolveWritePath("902", config.ragicPath);
  assert.ok(writePath);
  const fullRecordReadMock = t.mock.method(
    workReportReadService,
    "getReportByEntryId",
    async () => {
      throw new Error("排序更新不應建立 linked-source 完整 record");
    }
  );
  let getEntryCalls = 0;
  const getEntryMock = t.mock.method(
    ragicClient,
    "getEntry",
    async (formPath: string, entryId: string, useCache: boolean) => {
      getEntryCalls += 1;
      assert.equal(formPath, writePath);
      assert.equal(entryId, "E-902");
      assert.equal(useCache, false);
      return {
        _ragicId: "E-902",
        "9001063": getEntryCalls === 1 ? 1 : 3,
      };
    }
  );
  const updateEntryMock = t.mock.method(
    ragicClient,
    "updateEntry",
    async (
      formPath: string,
      entryId: string,
      body: RagicRecord,
      method: RagicWriteMethod,
      options: boolean | RagicWriteOptions
    ) => {
      assert.equal(formPath, writePath);
      assert.equal(entryId, "E-902");
      assert.deepEqual(body, { "9001063": 3 });
      assert.equal(method, "PATCH");
      assert.deepEqual(options, {
        doWorkflow: false,
        doFormula: false,
      });
      return {};
    }
  );
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  const result = await workReportService.updateSortOrder("902", "E-902", 3, { expectedSortOrder: 1 });

  assert.deepEqual(result, {
    sortOrder: 3,
    previousSortOrder: 1,
    changed: true,
  });
  assert.equal(fullRecordReadMock.mock.callCount(), 0);
  assert.equal(getEntryMock.mock.callCount(), 2);
  assert.equal(updateEntryMock.mock.callCount(), 1);
});

test("updateSortOrder 遇到相同排序碼不重複寫入 Ragic", async (t) => {
  const getEntryMock = t.mock.method(
    ragicClient,
    "getEntry",
    async (
      _formPath: string,
      _entryId: string,
      _useCache: boolean,
      options: RagicReadRequestOptions
    ) => ({
      _ragicId: "E-901",
      "9001063": 4,
      ...(options.includeSubtables
        ? { _subtable_demo_work_orders: { R1: { _ragicId: "R1" } } }
        : {}),
    })
  );
  const updateEntryMock = t.mock.method(
    ragicClient,
    "updateEntry",
    async () => ({})
  );
  const result = await workReportService.updateSortOrder("901", "E-901", 4);

  assert.deepEqual(result, {
    sortOrder: 4,
    previousSortOrder: 4,
    changed: false,
  });
  assert.equal(updateEntryMock.mock.callCount(), 0);
  assert.equal(getEntryMock.mock.callCount(), 2);
  assert.equal(getEntryMock.mock.calls[0]?.arguments[3]?.includeSubtables, false);
  assert.equal(getEntryMock.mock.calls[1]?.arguments[3]?.includeSubtables, true);
});

test("updateSortOrder 已結案時在寫入前拒絕修改", async (t) => {
  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-901",
    "9001049": "已結案",
    "9001063": 10,
  }));
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));

  await assert.rejects(
    () => workReportService.updateSortOrder("901", "E-901", 11),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_CLOSED"
  );

  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.equal(updateEntryMock.mock.callCount(), 0);
});

test("updateSortOrder 回讀值不一致時回傳 typed upstream error", async (t) => {
  let getEntryCalls = 0;
  t.mock.method(ragicClient, "getEntry", async () => {
    getEntryCalls += 1;
    return {
      _ragicId: "E-901",
      "9001063": getEntryCalls === 1 ? 2 : 3,
    };
  });
  t.mock.method(ragicClient, "updateEntry", async () => ({}));
  t.mock.method(ragicClient, "clearFormCache", () => undefined);
  await assert.rejects(
    () => workReportService.updateSortOrder("901", "E-901", 4, { expectedSortOrder: 2 }),
    (error: unknown) => {
      return (
        error instanceof HttpError &&
        error.statusCode === 502 &&
        error.code === "RAGIC_WRITE_VERIFY_FAILED"
      );
    }
  );
});

test("updateSortOrder 遇到 Ragic code 202 時留下完整欄位診斷並回傳可處理訊息", async (t) => {
  const errorLogs: Array<Record<string, unknown>> = [];
  const commandService = new WorkReportWorkOrderCommandService({
    info: () => undefined,
    error: (detail) => {
      errorLogs.push(detail);
    },
  });
  t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-901",
    "9001040": "DEMO-100503",
    "9001063": 2,
    "9001054": "",
  }));
  t.mock.method(ragicClient, "updateEntry", async () => {
    throw new UpstreamError(
      "Field 預計產數量輸入 contains empty value (code: 202)",
      "RAGIC_WRITE_FAILED",
      {
        status: 400,
        ragicStatus: "ERROR",
        ragicCode: "202",
        message: "Field 預計產數量輸入 contains empty value",
      }
    );
  });

  await assert.rejects(
    () => commandService.updateSortOrder("901", "E-901", 4, { expectedSortOrder: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.code, "RAGIC_WRITE_FAILED");
      assert.match(error.message, /工令 DEMO-100503/);
      assert.match(error.message, /必填欄位「預計產數量輸入」目前為空/);
      assert.match(error.message, /code: 202/);
      const detail = error.upstreamDetail as {
        requestedSortOrder?: number;
        requiredField?: { fieldId?: string; valueState?: string };
      };
      assert.equal(detail.requestedSortOrder, 4);
      assert.equal(detail.requiredField?.fieldId, "9001054");
      assert.equal(detail.requiredField?.valueState, "blank");
      assert.equal(isActivityLogMutationWriteIndeterminateError(error), false);
      return true;
    }
  );

  const writeFailure = errorLogs.find(
    (detail) => detail.event === "sort-order.write-failed"
  );
  assert.ok(writeFailure);
  const logged = writeFailure as unknown as {
    operation: string;
    formId: string;
    entryId: string;
    workOrderNo: string;
    sortOrder: unknown;
    requiredField: unknown;
    ragic: unknown;
    errorCode: string;
  };
  assert.equal(logged.operation, "update-sort-order");
  assert.equal(logged.formId, "901");
  assert.equal(logged.entryId, "E-901");
  assert.equal(logged.workOrderNo, "DEMO-100503");
  assert.deepEqual(logged.sortOrder, {
    previous: 2,
    requested: 4,
    fieldId: "9001063",
  });
  assert.deepEqual(logged.requiredField, {
    fieldId: "9001054",
    fieldName: "預計產數量輸入",
    matchedKey: "9001054",
    valueState: "blank",
    observedValue: "",
  });
  assert.deepEqual(logged.ragic, {
    httpStatus: 400,
    ragicStatus: "ERROR",
    ragicCode: "202",
    message: "Field 預計產數量輸入 contains empty value",
  });
  assert.equal(logged.errorCode, "RAGIC_WRITE_FAILED");
});

test("updateSortOrder 有相同 expected timestamp 時只讀 raw entry，不建立完整 linked record", async (t) => {
  const expectedLastUpdatedAt = "2026-08-07T01:00:00.000Z";
  const readCurrentMock = t.mock.method(
    workReportReadService,
    "getReportByEntryId",
    async () => {
      throw new Error("相同 timestamp 不應建立完整 linked record");
    }
  );
  let readCount = 0;
  const rawReadMock = t.mock.method(ragicClient, "getEntry", async () => {
    readCount += 1;
    return readCount === 1
      ? {
          _ragicId: "E-901",
          "9001063": 2,
          "9001202": expectedLastUpdatedAt,
        }
      : {
          _ragicId: "E-901",
          "9001063": 4,
        };
  });
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));
  t.mock.method(ragicClient, "clearFormCache", () => undefined);
  const result = await workReportService.updateSortOrder("901", "E-901", 4, {
    expectedEntryLastUpdatedAt: expectedLastUpdatedAt,
  });

  assert.deepEqual(result, {
    sortOrder: 4,
    previousSortOrder: 2,
    changed: true,
  });
  assert.equal(readCurrentMock.mock.callCount(), 0);
  assert.equal(rawReadMock.mock.callCount(), 2);
  assert.equal(updateEntryMock.mock.callCount(), 1);
});

test("updateSortOrder 同一工令連續更新時不會把前序排序任務誤判為外部衝突", async (t) => {
  const expectedLastUpdatedAt = "2026-08-07T01:00:00.000Z";
  const readCurrentMock = t.mock.method(
    workReportReadService,
    "getReportByEntryId",
    async () => {
      throw new Error("排序更新不應建立完整 linked record 做整筆衝突檢查");
    }
  );
  let readCount = 0;
  t.mock.method(ragicClient, "getEntry", async () => {
    readCount += 1;
    const responses = [
      {
        _ragicId: "E-901",
        "9001063": 2,
        "9001202": expectedLastUpdatedAt,
      },
      {
        _ragicId: "E-901",
        "9001063": 4,
        "9001202": "2026-08-07T01:01:00.000Z",
      },
      {
        _ragicId: "E-901",
        "9001063": 4,
        "9001202": "2026-08-07T01:01:00.000Z",
      },
      {
        _ragicId: "E-901",
        "9001063": 5,
        "9001202": "2026-08-07T01:02:00.000Z",
      },
    ];
    return responses[readCount - 1] ?? null;
  });
  const writtenSortOrders: number[] = [];
  t.mock.method(ragicClient, "updateEntry", async (
    _path: string,
    _entryId: string,
    body: RagicRecord
  ) => {
    writtenSortOrders.push(Number(body["9001063"]));
    return {};
  });
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  const firstResult = await workReportService.updateSortOrder("901", "E-901", 4, {
    expectedSortOrder: 2,
    expectedEntryLastUpdatedAt: expectedLastUpdatedAt,
  });
  const secondResult = await workReportService.updateSortOrder("901", "E-901", 5, {
    expectedSortOrder: 4,
    expectedEntryLastUpdatedAt: expectedLastUpdatedAt,
  });

  assert.deepEqual(firstResult, {
    sortOrder: 4,
    previousSortOrder: 2,
    changed: true,
  });
  assert.deepEqual(secondResult, {
    sortOrder: 5,
    previousSortOrder: 4,
    changed: true,
  });
  assert.deepEqual(writtenSortOrders, [4, 5]);
  assert.equal(readCurrentMock.mock.callCount(), 0);
});

test("updateSortOrder 拒絕負數與非整數", async () => {
  await assert.rejects(
    () => workReportService.updateSortOrder("901", "E-901", -1),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_PAYLOAD"
  );
  await assert.rejects(
    () => workReportService.updateSortOrder("901", "E-901", 1.5),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_PAYLOAD"
  );
});
