import test from "node:test";
import assert from "node:assert/strict";
import { ragicClient, type RagicFormData } from "../../src/ragic/client";
import {
  clearActivityLogRequiredFieldsCache,
  resolveActivityLogRequiredFields,
} from "../../src/services/work-report/create/resolveActivityLogRequiredFields";

function activityLogPage(depUnit = "D01生產", prodType = "PB"): RagicFormData {
  return {
    "100": {
      _ragicId: "100",
      "demo_department_group": depUnit,
      "demo_prod_type": prodType,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("resolveActivityLogRequiredFields 相同 key 的成功結果會短期重用 cache", async (t) => {
  clearActivityLogRequiredFieldsCache();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormPage", async () => {
    callCount += 1;
    return activityLogPage();
  });

  const first = await resolveActivityLogRequiredFields(
    "/demo/reference/activity-types",
    "WO-001",
    "PB-01",
    ""
  );
  const second = await resolveActivityLogRequiredFields(
    "/demo/reference/activity-types",
    "WO-001",
    "PB-01",
    ""
  );

  assert.equal(callCount, 1);
  assert.deepEqual(first, {
    depUnit: "D01生產",
    prodType: "PB",
    source: "processCode-history",
  });
  assert.deepEqual(second, first);
});

test("resolveActivityLogRequiredFields 已知報工類別直接使用對照表，不打 Ragic 歷史查詢", async (t) => {
  clearActivityLogRequiredFieldsCache();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormPage", async () => {
    callCount += 1;
    return activityLogPage();
  });

  const resolved = await resolveActivityLogRequiredFields(
    "/demo/reference/activity-types",
    "WO-003",
    "PA",
    "PROC-A"
  );

  assert.equal(callCount, 0);
  assert.deepEqual(resolved, {
    depUnit: "P01加工一組",
    prodType: "PA",
    source: "reportType-fallback-map",
  });
});

test("resolveActivityLogRequiredFields 相同 key 的並發查詢只送出一個 upstream request", async (t) => {
  clearActivityLogRequiredFieldsCache();
  const gate = deferred<RagicFormData>();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormPage", async () => {
    callCount += 1;
    return gate.promise;
  });

  const first = resolveActivityLogRequiredFields(
    "/demo/reference/activity-types",
    "WO-002",
    "PB-02",
    ""
  );
  const second = resolveActivityLogRequiredFields(
    "/demo/reference/activity-types",
    "WO-002",
    "PB-02",
    ""
  );

  await nextTick();
  assert.equal(callCount, 1);

  gate.resolve(activityLogPage("P02加工二組", "PA"));

  assert.deepEqual(await Promise.all([first, second]), [
    { depUnit: "P02加工二組", prodType: "PA", source: "processCode-history" },
    { depUnit: "P02加工二組", prodType: "PA", source: "processCode-history" },
  ]);
});
