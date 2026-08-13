import assert from "node:assert/strict";
import test from "node:test";
import { resolveWritePath } from "../../src/config/env";
import { getFormConfig } from "../../src/config/forms";
import {
  ragicClient,
  type RagicRecord,
  type RagicWriteMethod,
  type RagicWriteOptions,
} from "../../src/ragic/client";
import type { RagicReadPriority } from "../../src/infra/ragicRequestScheduler";
import { workReportService } from "../../src/services/workReportService";
import { workReportReadService } from "../../src/services/work-report/workReportReadService";
import { HttpError } from "../../src/utils/httpError";

test("updateSortOrder 寫入主表欄位後會從相同 write target 回讀驗證", async (t) => {
  const config = getFormConfig("104");
  const writePath = resolveWritePath("104", config.ragicPath);
  assert.ok(writePath);
  let getEntryCalls = 0;

  const getEntryMock = t.mock.method(
    ragicClient,
    "getEntry",
    async (
      formPath: string,
      entryId: string,
      useCache: boolean,
      options?: {
        timeoutMs?: number;
        priority?: RagicReadPriority;
        maxRetries?: number;
      }
    ) => {
      getEntryCalls += 1;
      assert.equal(formPath, writePath);
      assert.equal(entryId, "E-104");
      assert.equal(useCache, false);
      assert.equal(options?.priority, "mutation");
      return {
        _ragicId: "E-104",
        "1012079": getEntryCalls === 1 ? "2" : "4",
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
      assert.equal(entryId, "E-104");
      assert.deepEqual(body, { "1012079": 4 });
      assert.equal(method, "PATCH");
      assert.deepEqual(options, {
        doWorkflow: false,
        doFormula: false,
      });
      return {};
    }
  );
  t.mock.method(ragicClient, "clearFormCache", () => undefined);
  const result = await workReportService.updateSortOrder("104", "E-104", 4);

  assert.deepEqual(result, {
    sortOrder: 4,
    previousSortOrder: 2,
    changed: true,
  });
  assert.equal(getEntryMock.mock.callCount(), 2);
  assert.equal(updateEntryMock.mock.callCount(), 1);
});

test("Form 105 updateSortOrder 只走 raw entry，不建立 linked-source 完整 record", async (t) => {
  const config = getFormConfig("105");
  const writePath = resolveWritePath("105", config.ragicPath);
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
      assert.equal(entryId, "E-105");
      assert.equal(useCache, false);
      return {
        _ragicId: "E-105",
        "1012079": getEntryCalls === 1 ? 1 : 3,
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
      assert.equal(entryId, "E-105");
      assert.deepEqual(body, { "1012079": 3 });
      assert.equal(method, "PATCH");
      assert.deepEqual(options, {
        doWorkflow: false,
        doFormula: false,
      });
      return {};
    }
  );
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  const result = await workReportService.updateSortOrder("105", "E-105", 3);

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
  t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-104",
    "1012079": 4,
  }));
  const updateEntryMock = t.mock.method(
    ragicClient,
    "updateEntry",
    async () => ({})
  );
  const result = await workReportService.updateSortOrder("104", "E-104", 4);

  assert.deepEqual(result, {
    sortOrder: 4,
    previousSortOrder: 4,
    changed: false,
  });
  assert.equal(updateEntryMock.mock.callCount(), 0);
});

test("updateSortOrder 回讀值不一致時回傳 typed upstream error", async (t) => {
  let getEntryCalls = 0;
  t.mock.method(ragicClient, "getEntry", async () => {
    getEntryCalls += 1;
    return {
      _ragicId: "E-104",
      "1012079": getEntryCalls === 1 ? 2 : 3,
    };
  });
  t.mock.method(ragicClient, "updateEntry", async () => ({}));
  t.mock.method(ragicClient, "clearFormCache", () => undefined);
  await assert.rejects(
    () => workReportService.updateSortOrder("104", "E-104", 4),
    (error: unknown) => {
      return (
        error instanceof HttpError &&
        error.statusCode === 502 &&
        error.code === "RAGIC_WRITE_VERIFY_FAILED"
      );
    }
  );
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
          _ragicId: "E-104",
          "1012079": 2,
          "109": expectedLastUpdatedAt,
        }
      : {
          _ragicId: "E-104",
          "1012079": 4,
        };
  });
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));
  t.mock.method(ragicClient, "clearFormCache", () => undefined);
  const result = await workReportService.updateSortOrder("104", "E-104", 4, {
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
        _ragicId: "E-104",
        "1012079": 2,
        "109": expectedLastUpdatedAt,
      },
      {
        _ragicId: "E-104",
        "1012079": 4,
        "109": "2026-08-07T01:01:00.000Z",
      },
      {
        _ragicId: "E-104",
        "1012079": 4,
        "109": "2026-08-07T01:01:00.000Z",
      },
      {
        _ragicId: "E-104",
        "1012079": 5,
        "109": "2026-08-07T01:02:00.000Z",
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
    writtenSortOrders.push(Number(body["1012079"]));
    return {};
  });
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  const firstResult = await workReportService.updateSortOrder("104", "E-104", 4, {
    expectedEntryLastUpdatedAt: expectedLastUpdatedAt,
  });
  const secondResult = await workReportService.updateSortOrder("104", "E-104", 5, {
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
    () => workReportService.updateSortOrder("104", "E-104", -1),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_PAYLOAD"
  );
  await assert.rejects(
    () => workReportService.updateSortOrder("104", "E-104", 1.5),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_PAYLOAD"
  );
});
