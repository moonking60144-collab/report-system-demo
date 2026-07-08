import test from "node:test";
import assert from "node:assert/strict";
import { ragicClient, type RagicFormData } from "../../src/ragic/client";
import { getFormConfig } from "../../src/config/forms";
import { workReportReadService } from "../../src/services/work-report/workReportReadService";
import {
  clearOperatorOptionMapCache,
  getOperatorOptionMap,
} from "../../src/services/work-report/operator/operatorOptionCache";
import {
  clearPreparedLinkedSourceMapCache,
  prepareLinkedSourceMaps,
} from "../../src/services/work-report/queries/linkedSources";
import { WorkReportOptionsReadService } from "../../src/services/work-report/workReportOptionsReadService";
import type { LinkedFieldMapping } from "../../src/types/formConfig";

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

test("prepareLinkedSourceMaps 會合併同 source/lookup 的併發 map build，並回傳隔離的 Map", async (t) => {
  clearPreparedLinkedSourceMapCache();
  const gate = deferred<RagicFormData>();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormDataWithOptions", async () => {
    callCount += 1;
    return gate.promise;
  });

  const linkedFields: LinkedFieldMapping = {
    machineId: {
      sourceFormPath: "/default/source/1",
      lookupFieldId: "code",
      displayFieldId: "name",
    },
    machineAlias: {
      sourceFormPath: "/default/source/1",
      lookupFieldId: "code",
      displayFieldId: "name",
    },
  };

  const first = prepareLinkedSourceMaps(linkedFields, "user");
  const second = prepareLinkedSourceMaps(linkedFields, "user");

  await nextTick();
  assert.equal(callCount, 1);

  gate.resolve({
    "1": { _ragicId: "1", code: "M1", name: "機台一" },
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  const firstMap = firstResult.get("machineId");
  const secondMap = secondResult.get("machineId");

  assert.equal(firstMap?.get("M1")?.name, "機台一");
  assert.equal(secondMap?.get("M1")?.name, "機台一");
  assert.notEqual(firstMap, secondMap);

  firstMap?.set("mutated", { name: "不應污染其他 caller" });
  assert.equal(secondMap?.has("mutated"), false);

  const cachedResult = await prepareLinkedSourceMaps(linkedFields, "user");
  assert.equal(callCount, 1);
  assert.equal(cachedResult.get("machineId")?.has("mutated"), false);
});

test("prepareLinkedSourceMaps 同 source form 但不同 lookupFieldId 時會建立各自的 lookup map", async (t) => {
  clearPreparedLinkedSourceMapCache();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormDataWithOptions", async () => {
    callCount += 1;
    return {
      "1": { _ragicId: "1", code: "C1", alt: "A1", name: "第一筆" },
      "2": { _ragicId: "2", code: "A1", alt: "B1", name: "第二筆" },
    };
  });

  const linkedFields: LinkedFieldMapping = {
    byCode: {
      sourceFormPath: "/default/source/2",
      lookupFieldId: "code",
      displayFieldId: "name",
    },
    byAlt: {
      sourceFormPath: "/default/source/2",
      lookupFieldId: "alt",
      displayFieldId: "name",
    },
  };

  const result = await prepareLinkedSourceMaps(linkedFields, "user");

  assert.equal(result.get("byCode")?.get("A1")?.name, "第二筆");
  assert.equal(result.get("byAlt")?.get("A1")?.name, "第一筆");
  assert.equal(callCount, 2);
});

test("prepareLinkedSourceMaps 同 source/lookup 但不同 priority 不共用 in-flight", async (t) => {
  clearPreparedLinkedSourceMapCache();
  const gates = [deferred<RagicFormData>(), deferred<RagicFormData>()];
  const priorities: string[] = [];
  let callCount = 0;

  t.mock.method(
    ragicClient,
    "getFormDataWithOptions",
    async (_sourceFormPath: string, _useCache: boolean, options?: { priority?: string }) => {
      priorities.push(options?.priority ?? "");
      const gate = gates[callCount];
      callCount += 1;
      return gate.promise;
    }
  );

  const linkedFields: LinkedFieldMapping = {
    machineId: {
      sourceFormPath: "/default/source/priority",
      lookupFieldId: "code",
      displayFieldId: "name",
    },
  };

  const backgroundRead = prepareLinkedSourceMaps(linkedFields, "background");
  const userRead = prepareLinkedSourceMaps(linkedFields, "user");

  await nextTick();
  assert.equal(callCount, 2);
  assert.deepEqual(priorities, ["background", "user"]);

  gates[0].resolve({
    "1": { _ragicId: "1", code: "M1", name: "背景名稱" },
  });
  gates[1].resolve({
    "1": { _ragicId: "1", code: "M1", name: "使用者名稱" },
  });

  assert.equal((await backgroundRead).get("machineId")?.get("M1")?.name, "背景名稱");
  assert.equal((await userRead).get("machineId")?.get("M1")?.name, "使用者名稱");
});

test("ragicClient.clearFormCache 會清掉 linked source map cache", async (t) => {
  clearPreparedLinkedSourceMapCache();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormDataWithOptions", async () => {
    callCount += 1;
    return {
      "1": { _ragicId: "1", code: "M1", name: callCount === 1 ? "舊名稱" : "新名稱" },
    };
  });

  const linkedFields: LinkedFieldMapping = {
    machineId: {
      sourceFormPath: "/default/source/3",
      lookupFieldId: "code",
      displayFieldId: "name",
    },
  };

  const first = await prepareLinkedSourceMaps(linkedFields, "user");
  assert.equal(first.get("machineId")?.get("M1")?.name, "舊名稱");

  const cached = await prepareLinkedSourceMaps(linkedFields, "user");
  assert.equal(cached.get("machineId")?.get("M1")?.name, "舊名稱");
  assert.equal(callCount, 1);

  ragicClient.clearFormCache("/default/source/3");

  const refreshed = await prepareLinkedSourceMaps(linkedFields, "user");
  assert.equal(refreshed.get("machineId")?.get("M1")?.name, "新名稱");
  assert.equal(callCount, 2);
});

test("linked source 舊 in-flight 在 clear 後完成不會回寫 stale map cache", async (t) => {
  clearPreparedLinkedSourceMapCache();
  const oldGate = deferred<RagicFormData>();
  const freshGate = deferred<RagicFormData>();
  let callCount = 0;

  t.mock.method(ragicClient, "getFormDataWithOptions", async () => {
    callCount += 1;
    return callCount === 1 ? oldGate.promise : freshGate.promise;
  });

  const linkedFields: LinkedFieldMapping = {
    machineId: {
      sourceFormPath: "/default/source/4",
      lookupFieldId: "code",
      displayFieldId: "name",
    },
  };

  const staleRead = prepareLinkedSourceMaps(linkedFields, "user");
  await nextTick();
  assert.equal(callCount, 1);

  ragicClient.clearFormCache("/default/source/4");
  const freshRead = prepareLinkedSourceMaps(linkedFields, "user");
  await nextTick();
  assert.equal(callCount, 2);

  oldGate.resolve({
    "1": { _ragicId: "1", code: "M1", name: "舊名稱" },
  });
  assert.equal((await staleRead).get("machineId")?.get("M1")?.name, "舊名稱");

  freshGate.resolve({
    "1": { _ragicId: "1", code: "M1", name: "新名稱" },
  });
  assert.equal((await freshRead).get("machineId")?.get("M1")?.name, "新名稱");

  const cached = await prepareLinkedSourceMaps(linkedFields, "user");
  assert.equal(cached.get("machineId")?.get("M1")?.name, "新名稱");
  assert.equal(callCount, 2);
});

test("ragicClient.clearFormCache 會清掉 work report options cache", async (t) => {
  ragicClient.clearCache();
  const service = new WorkReportOptionsReadService();
  const sourceFormPath = getFormConfig("104").linkedFields?.machineId?.sourceFormPath ?? "";
  let callCount = 0;

  t.mock.method(ragicClient, "getFormDataWithOptions", async () => {
    callCount += 1;
    return {
      "1": {
        _ragicId: "1",
        "機台代碼": "M1",
        "機台簡稱": callCount === 1 ? "舊機台" : "新機台",
      },
    };
  });

  const first = await service.getFormOptions("104", ["machineId"], "user");
  assert.equal(first.machineId?.[0]?.display, "舊機台");

  const cached = await service.getFormOptions("104", ["machineId"], "user");
  assert.equal(cached.machineId?.[0]?.display, "舊機台");
  assert.equal(callCount, 1);

  ragicClient.clearFormCache(sourceFormPath);

  const refreshed = await service.getFormOptions("104", ["machineId"], "user");
  assert.equal(refreshed.machineId?.[0]?.display, "新機台");
  assert.equal(callCount, 2);
});

test("getFormOptions 同 form/fields 但不同 priority 不共用 in-flight", async (t) => {
  ragicClient.clearCache();
  const service = new WorkReportOptionsReadService();
  const gates = [deferred<RagicFormData>(), deferred<RagicFormData>()];
  const priorities: string[] = [];
  let callCount = 0;

  t.mock.method(
    ragicClient,
    "getFormDataWithOptions",
    async (_sourceFormPath: string, _useCache: boolean, options?: { priority?: string }) => {
      priorities.push(options?.priority ?? "");
      const gate = gates[callCount];
      callCount += 1;
      return gate.promise;
    }
  );

  const backgroundRead = service.getFormOptions("104", ["machineId"], "background");
  const userRead = service.getFormOptions("104", ["machineId"], "user");

  await nextTick();
  assert.equal(callCount, 2);
  assert.deepEqual(priorities, ["background", "user"]);

  gates[0].resolve({
    "1": { _ragicId: "1", "機台代碼": "M1", "機台簡稱": "背景機台" },
  });
  gates[1].resolve({
    "1": { _ragicId: "1", "機台代碼": "M1", "機台簡稱": "使用者機台" },
  });

  assert.equal((await backgroundRead).machineId?.[0]?.display, "背景機台");
  assert.equal((await userRead).machineId?.[0]?.display, "使用者機台");
});

test("ragicClient.clearFormCache 會清掉 operator option cache", async (t) => {
  clearOperatorOptionMapCache();
  const config = getFormConfig("104");
  const sourceFormPath = config.linkedFields?.operatorId?.sourceFormPath ?? "";
  let callCount = 0;

  t.mock.method(workReportReadService, "getFormOptions", async () => {
    callCount += 1;
    return {
      operatorId: [
        {
          value: "OP1",
          label: "OP1",
          display: callCount === 1 ? "舊人員" : "新人員",
        },
      ],
    };
  });

  const first = await getOperatorOptionMap("104", config);
  assert.equal(first.get("OP1"), "舊人員");

  const cached = await getOperatorOptionMap("104", config);
  assert.equal(cached.get("OP1"), "舊人員");
  assert.equal(callCount, 1);

  ragicClient.clearFormCache(sourceFormPath);

  const refreshed = await getOperatorOptionMap("104", config);
  assert.equal(refreshed.get("OP1"), "新人員");
  assert.equal(callCount, 2);
});
