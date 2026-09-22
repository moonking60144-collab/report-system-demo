import assert from "node:assert/strict";
import test from "node:test";
import { env, resolveWritePath } from "../../src/config/env";
import { getFormConfig } from "../../src/config/forms";
import {
  ragicClient,
  type RagicReadRequestOptions,
  type RagicRecord,
  type RagicWriteMethod,
  type RagicWriteOptions,
  type RagicWriteRequestOptions,
} from "../../src/ragic/client";
import { workReportService } from "../../src/services/workReportService";
import type {
  WorkReportCommandEntryObservation,
  WorkReportCommandTimingResult,
} from "../../src/services/work-report/mutation/workReportWorkOrderCommandService";
import { HttpError } from "../../src/utils/httpError";
import { TokenBucketAcquireTimeoutError } from "../../src/infra/tokenBucket";

for (const formId of ["901", "902"] as const) {
  test(`Form ${formId} updateUrgent 以 Ragic checkbox Yes/No 寫入並回讀`, async (t) => {
    const config = getFormConfig(formId);
    const writePath = resolveWritePath(formId, config.ragicPath);
    assert.ok(writePath);
    let getEntryCalls = 0;
    const observedTimings: WorkReportCommandTimingResult[] = [];
    const confirmedEntries: WorkReportCommandEntryObservation[] = [];
    const getEntryMock = t.mock.method(
      ragicClient,
      "getEntry",
      async (
        _formPath: string,
        _entryId: string,
        _useCache: boolean,
        requestOptions: RagicReadRequestOptions
      ) => {
        getEntryCalls += 1;
        requestOptions.onAttemptTiming?.({
          requestStarted: true,
          laneWaitMs: getEntryCalls,
          upstreamMs: getEntryCalls + 1,
          totalMs: getEntryCalls * 2 + 1,
          outcome: "success",
        });
        return {
          _ragicId: `E-${formId}`,
          "9001088": getEntryCalls === 1 ? "No" : "Yes",
          "9001202": "2026-08-31T05:00:00.000Z",
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
        options: boolean | RagicWriteOptions,
        requestOptions: RagicWriteRequestOptions
      ) => {
        assert.equal(formPath, writePath);
        assert.equal(entryId, `E-${formId}`);
        assert.deepEqual(body, { "9001088": "Yes" });
        assert.equal(method, "PATCH");
        assert.deepEqual(options, {
          doWorkflow: false,
          doFormula: false,
        });
        assert.equal(typeof requestOptions.onAttemptTiming, "function");
        requestOptions.onAttemptTiming?.({
          requestStarted: true,
          laneWaitMs: 3,
          upstreamMs: 4,
          totalMs: 7,
          outcome: "success",
        });
        return {};
      }
    );
    t.mock.method(ragicClient, "clearFormCache", () => undefined);

    const result = await workReportService.updateUrgent(
      formId,
      `E-${formId}`,
      true,
      {
        expectedEntryLastUpdatedAt: "2026-08-31T05:00:00.000Z",
        onTiming: (timing) => {
          observedTimings.push(timing);
        },
        onConfirmedEntry: (observation) => {
          confirmedEntries.push(observation);
        },
      }
    );

    assert.deepEqual(result, {
      urgent: true,
      previousUrgent: false,
      changed: true,
    });
    const finalTiming = observedTimings.at(-1);
    assert.equal(typeof finalTiming?.writeStartedAt, "string");
    assert.ok((finalTiming?.mutationTimings.currentReadMs ?? -1) >= 0);
    assert.ok((finalTiming?.mutationTimings.writeMs ?? -1) >= 0);
    assert.ok((finalTiming?.mutationTimings.verifyMs ?? -1) >= 0);
    assert.equal(finalTiming?.mutationTimings.currentReadAttempts, 1);
    assert.equal(finalTiming?.mutationTimings.currentReadLaneWaitMs, 1);
    assert.equal(finalTiming?.mutationTimings.currentReadUpstreamMs, 2);
    assert.equal(finalTiming?.mutationTimings.writeAttempts, 1);
    assert.equal(finalTiming?.mutationTimings.writeLaneWaitMs, 3);
    assert.equal(finalTiming?.mutationTimings.writeUpstreamMs, 4);
    assert.equal(finalTiming?.mutationTimings.verifyAttempts, 1);
    assert.equal(finalTiming?.mutationTimings.verifyLaneWaitMs, 2);
    assert.equal(finalTiming?.mutationTimings.verifyUpstreamMs, 3);
    assert.equal(updateEntryMock.mock.callCount(), 1);
    assert.equal(confirmedEntries.length, 1);
    assert.equal(confirmedEntries[0]?.entryId, `E-${formId}`);
    assert.equal(
      confirmedEntries[0]?.entryLastUpdatedAt,
      "2026-08-31T05:00:00.000Z"
    );
    assert.equal(confirmedEntries[0]?.rawEntry["9001088"], "Yes");
    const currentOptions = getEntryMock.mock.calls[0]?.arguments[3];
    assert.equal(currentOptions?.priority, "mutation");
    assert.equal(currentOptions?.timeoutMs, env.RAGIC_MUTATION_READ_TIMEOUT_MS);
    assert.equal(
      currentOptions?.totalBudgetMs,
      env.RAGIC_MUTATION_READ_TOTAL_BUDGET_MS
    );
    assert.equal(currentOptions?.maxRetries, env.RAGIC_MUTATION_READ_MAX_RETRIES);
    assert.equal(currentOptions?.includeSubtables, false);
    assert.equal(typeof currentOptions?.onAttemptTiming, "function");
    const verifyOptions = getEntryMock.mock.calls[1]?.arguments[3];
    assert.equal(verifyOptions?.priority, "mutation");
    assert.equal(verifyOptions?.timeoutMs, env.RAGIC_MUTATION_VERIFY_TIMEOUT_MS);
    assert.equal(verifyOptions?.totalBudgetMs, env.RAGIC_MUTATION_VERIFY_TIMEOUT_MS);
    assert.equal(verifyOptions?.maxRetries, 0);
    assert.equal(verifyOptions?.includeSubtables, true);
    assert.equal(typeof verifyOptions?.onAttemptTiming, "function");
  });
}

test("Form 901 updateStartSchedule 共用 checkbox mutation contract", async (t) => {
  let getEntryCalls = 0;
  t.mock.method(ragicClient, "getEntry", async () => {
    getEntryCalls += 1;
    return {
      _ragicId: "E-901",
      "9001102": getEntryCalls === 1 ? "" : "Yes",
      "9001202": "2026-08-31T05:00:00.000Z",
    };
  });
  const updateEntryMock = t.mock.method(
    ragicClient,
    "updateEntry",
    async (
      _path: string,
      _entryId: string,
      body: RagicRecord,
      method: RagicWriteMethod,
      options: boolean | RagicWriteOptions,
      requestOptions: RagicWriteRequestOptions
    ) => {
      assert.deepEqual(body, { "9001102": "Yes" });
      assert.equal(method, "PATCH");
      assert.deepEqual(options, {
        doWorkflow: false,
        doFormula: false,
      });
      assert.equal(typeof requestOptions.onAttemptTiming, "function");
      return {};
    }
  );
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  const result = await workReportService.updateStartSchedule(
    "901",
    "E-901",
    true,
    { expectedEntryLastUpdatedAt: "2026-08-31T05:00:00.000Z" }
  );

  assert.deepEqual(result, {
    startSchedule: true,
    previousStartSchedule: false,
    changed: true,
  });
  assert.equal(updateEntryMock.mock.callCount(), 1);
});

test("Form 902 沒有開始排程欄位時確定性拒絕，不猜用 901 field id", async (t) => {
  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () => ({}));
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));

  await assert.rejects(
    () => workReportService.updateStartSchedule("902", "E-902", true),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 503 &&
      error.code === "FORM_NOT_CONFIGURED"
  );
  assert.equal(getEntryMock.mock.callCount(), 0);
  assert.equal(updateEntryMock.mock.callCount(), 0);
});

test("checkbox main field 的空值視為未勾選，同值不重複寫入", async (t) => {
  let getEntryCalls = 0;
  const getEntryMock = t.mock.method(
    ragicClient,
    "getEntry",
    async (
      _formPath: string,
      _entryId: string,
      _useCache: boolean,
      options: RagicReadRequestOptions
    ) => {
      getEntryCalls += 1;
      if (getEntryCalls === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      return {
        _ragicId: "E-901",
        "9001088": "",
        ...(options.includeSubtables
          ? { _subtable_demo_work_orders: { R1: { _ragicId: "R1" } } }
          : {}),
      };
    }
  );
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));
  const confirmedEntries: WorkReportCommandEntryObservation[] = [];

  const result = await workReportService.updateUrgent("901", "E-901", false, {
    onConfirmedEntry: (observation) => {
      confirmedEntries.push(observation);
    },
  });

  assert.deepEqual(result, {
    urgent: false,
    previousUrgent: false,
    changed: false,
  });
  assert.equal(updateEntryMock.mock.callCount(), 0);
  assert.equal(getEntryMock.mock.callCount(), 2);
  assert.equal(getEntryMock.mock.calls[0]?.arguments[3]?.includeSubtables, false);
  assert.equal(getEntryMock.mock.calls[1]?.arguments[3]?.includeSubtables, true);
  assert.ok(
    (getEntryMock.mock.calls[1]?.arguments[3]?.totalBudgetMs ?? Infinity) <
      (getEntryMock.mock.calls[0]?.arguments[3]?.totalBudgetMs ?? 0)
  );
  assert.equal(confirmedEntries.length, 1);
  assert.equal(confirmedEntries[0]?.rawEntry["9001088"], "");
  assert.ok(confirmedEntries[0]?.rawEntry._subtable_demo_work_orders);
});

test("checkbox no-op full observation 若已成第三值則回 conflict", async (t) => {
  let getEntryCalls = 0;
  t.mock.method(ragicClient, "getEntry", async () => {
    getEntryCalls += 1;
    return {
      _ragicId: "E-901",
      "9001088": getEntryCalls === 1 ? "No" : "Yes",
    };
  });
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));

  await assert.rejects(
    () => workReportService.updateUrgent("901", "E-901", false),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 409 &&
      error.code === "ENTRY_CONFLICT"
  );
  assert.equal(updateEntryMock.mock.callCount(), 0);
});

test("checkbox main field 回讀不一致時維持 typed verify failure", async (t) => {
  t.mock.method(ragicClient, "getEntry", async () => ({
    _ragicId: "E-901",
    "9001088": "No",
  }));
  t.mock.method(ragicClient, "updateEntry", async () => ({}));
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  await assert.rejects(
    () => workReportService.updateUrgent("901", "E-901", true, { expectedUrgent: false }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 502 &&
      error.code === "RAGIC_WRITE_VERIFY_FAILED"
  );
});

test("checkbox 寫入後 scheduler budget timeout 仍標成 verify indeterminate", async (t) => {
  let getEntryCalls = 0;
  t.mock.method(ragicClient, "getEntry", async () => {
    getEntryCalls += 1;
    if (getEntryCalls === 1) {
      return {
        _ragicId: "E-901",
        "9001088": "No",
      };
    }
    throw new TokenBucketAcquireTimeoutError(10_000);
  });
  t.mock.method(ragicClient, "updateEntry", async () => ({}));
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  await assert.rejects(
    () => workReportService.updateUrgent("901", "E-901", true, { expectedUrgent: false }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 502 &&
      error.code === "RAGIC_WRITE_VERIFY_FAILED"
  );
});
