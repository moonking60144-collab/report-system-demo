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
import { workReportService } from "../../src/services/workReportService";
import { workReportMutationPreconditionService } from "../../src/services/work-report/mutation/workReportMutationPreconditionService";
import { HttpError } from "../../src/utils/httpError";

for (const formId of ["901", "902"] as const) {
  test(`Form ${formId} updatePlannedEndDate 寫入主表後回讀驗證`, async (t) => {
    const config = getFormConfig(formId);
    const writePath = resolveWritePath(formId, config.ragicPath);
    assert.ok(writePath);
    const preconditionMock = t.mock.method(
      workReportMutationPreconditionService,
      "assertEntryNotModified",
      async (_formId: string, _entryId: string, expected: string | undefined) => {
        assert.equal(_formId, formId);
        assert.equal(_entryId, `E-${formId}`);
        assert.equal(expected, "2026-08-28T01:00:00.000Z");
      }
    );
    let getEntryCalls = 0;
    const getEntryMock = t.mock.method(
      ragicClient,
      "getEntry",
      async (
        formPath: string,
        entryId: string,
        useCache: boolean,
        options: RagicReadRequestOptions
      ) => {
        getEntryCalls += 1;
        assert.equal(formPath, writePath);
        assert.equal(entryId, `E-${formId}`);
        assert.equal(useCache, false);
        assert.equal(options.includeSubtables, getEntryCalls === 1 ? false : true);
        return {
          _ragicId: entryId,
          "9001057": getEntryCalls === 1 ? "2026/09/01" : "2026/09/05",
          "9001202": "2026-08-28T01:00:00.000Z",
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
        assert.equal(entryId, `E-${formId}`);
        assert.deepEqual(body, { "9001057": "2026/09/05" });
        assert.equal(method, "PATCH");
        assert.deepEqual(options, {
          doWorkflow: true,
          doFormula: false,
          doLinkLoad: "first",
        });
        return {};
      }
    );
    t.mock.method(ragicClient, "clearFormCache", () => undefined);

    const result = await workReportService.updatePlannedEndDate(
      formId,
      `E-${formId}`,
      "2026-09-05",
      { expectedEntryLastUpdatedAt: "2026-08-28T01:00:00.000Z" }
    );

    assert.deepEqual(result, {
      plannedEndDate: "2026-09-05",
      previousPlannedEndDate: "2026-09-01",
      changed: true,
    });
    assert.equal(preconditionMock.mock.callCount(), 0);
    assert.equal(getEntryMock.mock.callCount(), 2);
    assert.equal(updateEntryMock.mock.callCount(), 1);
  });
}

test("updatePlannedEndDate 相同日期不重複寫入 Ragic", async (t) => {
  t.mock.method(
    workReportMutationPreconditionService,
    "assertEntryNotModified",
    async () => undefined
  );
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
      "9001057": "2026/09/05",
      ...(options.includeSubtables
        ? { _subtable_demo_work_orders: { R1: { _ragicId: "R1" } } }
        : {}),
    })
  );
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));

  const result = await workReportService.updatePlannedEndDate("901", "E-901", "2026-09-05");

  assert.deepEqual(result, {
    plannedEndDate: "2026-09-05",
    previousPlannedEndDate: "2026-09-05",
    changed: false,
  });
  assert.equal(updateEntryMock.mock.callCount(), 0);
  assert.equal(getEntryMock.mock.callCount(), 2);
  assert.equal(getEntryMock.mock.calls[0]?.arguments[3]?.includeSubtables, false);
  assert.equal(getEntryMock.mock.calls[1]?.arguments[3]?.includeSubtables, true);
});

test("updatePlannedEndDate 遇到無法解析的舊值時在寫入前確定性失敗", async (t) => {
  t.mock.method(
    workReportMutationPreconditionService,
    "assertEntryNotModified",
    async () => undefined
  );
  t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-901",
    "9001057": "legacy-date-value",
  }));
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));

  await assert.rejects(
    () => workReportService.updatePlannedEndDate("901", "E-901", "2026-09-05", { expectedPlannedEndDate: "2026-09-01" }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "RAGIC_PLANNED_END_DATE_UNPARSEABLE"
  );
  assert.equal(updateEntryMock.mock.callCount(), 0);
});

test("updatePlannedEndDate 回讀不一致時回傳 typed upstream error", async (t) => {
  t.mock.method(
    workReportMutationPreconditionService,
    "assertEntryNotModified",
    async () => undefined
  );
  let getEntryCalls = 0;
  t.mock.method(ragicClient, "getEntry", async () => {
    getEntryCalls += 1;
    return {
      _ragicId: "E-901",
      "9001057": getEntryCalls === 1 ? "2026/09/01" : "2026/09/04",
    };
  });
  t.mock.method(ragicClient, "updateEntry", async () => ({}));
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  await assert.rejects(
    () => workReportService.updatePlannedEndDate("901", "E-901", "2026-09-05", { expectedPlannedEndDate: "2026-09-01" }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 502 &&
      error.code === "RAGIC_WRITE_VERIFY_FAILED"
  );
});

test("updatePlannedEndDate 拒絕修改已結案工令", async (t) => {
  t.mock.method(
    workReportMutationPreconditionService,
    "assertEntryNotModified",
    async () => undefined
  );
  t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-901",
    "9001049": "已結案",
    "9001057": "2026/09/01",
  }));
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));

  await assert.rejects(
    () => workReportService.updatePlannedEndDate("901", "E-901", "2026-09-05", { expectedPlannedEndDate: "2026-09-01" }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_CLOSED"
  );
  assert.equal(updateEntryMock.mock.callCount(), 0);
});

test("updatePlannedEndDate 在 raw entry timestamp 已改變時拒絕覆蓋", async (t) => {
  t.mock.method(
    workReportMutationPreconditionService,
    "assertEntryNotModified",
    async () => undefined
  );
  t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-901",
    "9001057": "2026/09/03",
    "9001202": "2026-08-28T01:01:00.000Z",
  }));
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));

  await assert.rejects(
    () =>
      workReportService.updatePlannedEndDate("901", "E-901", "2026-09-05", {
        expectedEntryLastUpdatedAt: "2026-08-28T01:00:00.000Z",
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_CONFLICT"
  );
  assert.equal(updateEntryMock.mock.callCount(), 0);
});

test("updatePlannedEndDate 拒絕無效或非 canonical 日期", async () => {
  for (const value of ["2026-02-30", "2026/09/05", "2026-9-5", ""]) {
    await assert.rejects(
      () => workReportService.updatePlannedEndDate("901", "E-901", value),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 400 &&
        error.code === "INVALID_PAYLOAD"
    );
  }
});
