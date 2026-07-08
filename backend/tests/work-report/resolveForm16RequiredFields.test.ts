import test from "node:test";
import assert from "node:assert/strict";
import { ragicClient, type RagicFormData } from "../../src/ragic/client";
import {
  clearForm16RequiredFieldsCache,
  resolveForm16RequiredFields,
} from "../../src/services/work-report/create/resolveForm16RequiredFields";

function form16Page(depUnit = "D01生產", prodType = "HF"): RagicFormData {
  return {
    "100": {
      _ragicId: "100",
      "Dep.報工單位別": depUnit,
      "Prod.Type製程大分類代碼": prodType,
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

test("resolveForm16RequiredFields 相同 key 的成功結果會短期重用 cache", async (t) => {
  clearForm16RequiredFieldsCache();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormPage", async () => {
    callCount += 1;
    return form16Page();
  });

  const first = await resolveForm16RequiredFields(
    "/default/forms16/1",
    "WO-001",
    "HF-01",
    ""
  );
  const second = await resolveForm16RequiredFields(
    "/default/forms16/1",
    "WO-001",
    "HF-01",
    ""
  );

  assert.equal(callCount, 1);
  assert.deepEqual(first, {
    depUnit: "D01生產",
    prodType: "HF",
    source: "processCode-history",
  });
  assert.deepEqual(second, first);
});

test("resolveForm16RequiredFields 已知報工類別直接使用對照表，不打 Ragic 歷史查詢", async (t) => {
  clearForm16RequiredFieldsCache();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormPage", async () => {
    callCount += 1;
    return form16Page();
  });

  const resolved = await resolveForm16RequiredFields(
    "/default/forms16/1",
    "WO-003",
    "TI",
    "TI搓牙"
  );

  assert.equal(callCount, 0);
  assert.deepEqual(resolved, {
    depUnit: "C02搓牙組",
    prodType: "TI",
    source: "reportType-fallback-map",
  });
});

test("resolveForm16RequiredFields 相同 key 的並發查詢只送出一個 upstream request", async (t) => {
  clearForm16RequiredFieldsCache();
  const gate = deferred<RagicFormData>();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormPage", async () => {
    callCount += 1;
    return gate.promise;
  });

  const first = resolveForm16RequiredFields(
    "/default/forms16/1",
    "WO-002",
    "HF-02",
    ""
  );
  const second = resolveForm16RequiredFields(
    "/default/forms16/1",
    "WO-002",
    "HF-02",
    ""
  );

  await nextTick();
  assert.equal(callCount, 1);

  gate.resolve(form16Page("D02生產", "TI"));

  assert.deepEqual(await Promise.all([first, second]), [
    { depUnit: "D02生產", prodType: "TI", source: "processCode-history" },
    { depUnit: "D02生產", prodType: "TI", source: "processCode-history" },
  ]);
});
