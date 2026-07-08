import test from "node:test";
import assert from "node:assert/strict";
import {
  ragicClient,
  type RagicFormData,
  type RagicRecord,
} from "../../src/ragic/client";

type RagicClientInternals = {
  runReadRequest<T>(
    label: string,
    request: () => Promise<T>,
    priority?: string,
    options?: { maxRetries?: number }
  ): Promise<T>;
  runWriteRequest<T>(
    label: string,
    request: () => Promise<T>
  ): Promise<T>;
};

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

test("getFormPage 同一個 cache key 的併發讀取只送出一個 upstream request", async (t) => {
  ragicClient.clearCache();
  const client = ragicClient as unknown as RagicClientInternals;
  const gate = deferred<{ data: RagicFormData }>();
  let callCount = 0;

  t.mock.method(client, "runReadRequest", async () => {
    callCount += 1;
    return gate.promise;
  });

  const first = ragicClient.getFormPage("/default/test/1", { limit: 10, offset: 0 }, true);
  const second = ragicClient.getFormPage("/default/test/1", { limit: 10, offset: 0 }, true);

  await nextTick();
  assert.equal(callCount, 1);

  const data = { "1": { _ragicId: "1", name: "A" } };
  gate.resolve({ data });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual([firstResult, secondResult], [data, data]);
  assert.notEqual(firstResult, secondResult);

  firstResult["1"].name = "mutated";
  assert.equal(secondResult["1"].name, "A");
});

test("getEntry in-flight 失敗後會釋放 key，下一次讀取可以重試", async (t) => {
  ragicClient.clearCache();
  const client = ragicClient as unknown as RagicClientInternals;
  const firstGate = deferred<{ data: RagicRecord }>();
  let callCount = 0;

  t.mock.method(client, "runReadRequest", async () => {
    callCount += 1;
    if (callCount === 1) {
      return firstGate.promise;
    }
    return { data: { _ragicId: "E1", name: "ok" } };
  });

  const first = ragicClient.getEntry("/default/test/2", "E1", true);
  const second = ragicClient.getEntry("/default/test/2", "E1", true);

  await nextTick();
  assert.equal(callCount, 1);

  firstGate.reject(new Error("upstream failed"));
  await Promise.all([
    assert.rejects(first, /upstream failed/),
    assert.rejects(second, /upstream failed/),
  ]);

  assert.deepEqual(await ragicClient.getEntry("/default/test/2", "E1", true), {
    _ragicId: "E1",
    name: "ok",
  });
  assert.equal(callCount, 2);
});

test("clearFormCache 會清掉同表單 in-flight read，避免舊結果寫回新 cache", async (t) => {
  ragicClient.clearCache();
  const client = ragicClient as unknown as RagicClientInternals;
  const oldGate = deferred<{ data: RagicFormData }>();
  const newGate = deferred<{ data: RagicFormData }>();
  let callCount = 0;

  t.mock.method(client, "runReadRequest", async () => {
    callCount += 1;
    return callCount === 1 ? oldGate.promise : newGate.promise;
  });

  const oldRead = ragicClient.getFormPage("/default/test/3", { limit: 10, offset: 0 }, true);

  await nextTick();
  assert.equal(callCount, 1);

  ragicClient.clearFormCache("/default/test/3");
  const newRead = ragicClient.getFormPage("/default/test/3", { limit: 10, offset: 0 }, true);

  await nextTick();
  assert.equal(callCount, 2);

  oldGate.resolve({ data: { old: { _ragicId: "old" } } });
  newGate.resolve({ data: { fresh: { _ragicId: "fresh" } } });

  assert.deepEqual(await oldRead, { old: { _ragicId: "old" } });
  assert.deepEqual(await newRead, { fresh: { _ragicId: "fresh" } });
  assert.deepEqual(
    await ragicClient.getFormPage("/default/test/3", { limit: 10, offset: 0 }, true),
    { fresh: { _ragicId: "fresh" } }
  );
  assert.equal(callCount, 2);
});

test("getFormPage useCache=false 只合併同時段 in-flight，不會寫入 cache", async (t) => {
  ragicClient.clearCache();
  const client = ragicClient as unknown as RagicClientInternals;
  const gate = deferred<{ data: RagicFormData }>();
  let callCount = 0;

  t.mock.method(client, "runReadRequest", async () => {
    callCount += 1;
    if (callCount === 1) {
      return gate.promise;
    }
    return { data: { fresh: { _ragicId: "fresh" } } };
  });

  const first = ragicClient.getFormPage("/default/test/4", { limit: 10, offset: 0 }, false);
  const second = ragicClient.getFormPage("/default/test/4", { limit: 10, offset: 0 }, false);

  await nextTick();
  assert.equal(callCount, 1);

  gate.resolve({ data: { live: { _ragicId: "live", name: "一次性結果" } } });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual([firstResult, secondResult], [
    { live: { _ragicId: "live", name: "一次性結果" } },
    { live: { _ragicId: "live", name: "一次性結果" } },
  ]);
  assert.notEqual(firstResult, secondResult);

  firstResult.live.name = "mutated";
  assert.equal(secondResult.live.name, "一次性結果");

  assert.deepEqual(
    await ragicClient.getFormPage("/default/test/4", { limit: 10, offset: 0 }, true),
    { fresh: { _ragicId: "fresh" } }
  );
  assert.equal(callCount, 2);
});

test("getFormPage 相同資料 key 但不同 priority 或 timeout 不共用 in-flight", async (t) => {
  ragicClient.clearCache();
  const client = ragicClient as unknown as RagicClientInternals;
  const gates = [
    deferred<{ data: RagicFormData }>(),
    deferred<{ data: RagicFormData }>(),
    deferred<{ data: RagicFormData }>(),
  ];
  const priorities: string[] = [];
  let callCount = 0;

  t.mock.method(
    client,
    "runReadRequest",
    async (_label: string, _request: () => Promise<unknown>, priority?: string) => {
      priorities.push(priority ?? "");
      const gate = gates[callCount];
      callCount += 1;
      return gate.promise;
    }
  );

  const first = ragicClient.getFormPage(
    "/default/test/5",
    { limit: 10, offset: 0 },
    true,
    { priority: "user", timeoutMs: 1000 }
  );
  const second = ragicClient.getFormPage(
    "/default/test/5",
    { limit: 10, offset: 0 },
    true,
    { priority: "background", timeoutMs: 1000 }
  );
  const third = ragicClient.getFormPage(
    "/default/test/5",
    { limit: 10, offset: 0 },
    true,
    { priority: "user", timeoutMs: 2000 }
  );

  await nextTick();
  assert.equal(callCount, 3);
  assert.deepEqual(priorities, ["user", "background", "user"]);

  gates[0].resolve({ data: { user: { _ragicId: "user" } } });
  gates[1].resolve({ data: { background: { _ragicId: "background" } } });
  gates[2].resolve({ data: { timeout: { _ragicId: "timeout" } } });

  assert.deepEqual(await Promise.all([first, second, third]), [
    { user: { _ragicId: "user" } },
    { background: { _ragicId: "background" } },
    { timeout: { _ragicId: "timeout" } },
  ]);
});

test("getEntry useCache=false 相同資料 key 但不同 maxRetries 不共用 in-flight", async (t) => {
  ragicClient.clearCache();
  const client = ragicClient as unknown as RagicClientInternals;
  const gates = [
    deferred<{ data: RagicRecord }>(),
    deferred<{ data: RagicRecord }>(),
  ];
  const retryOptions: Array<number | undefined> = [];
  let callCount = 0;

  t.mock.method(
    client,
    "runReadRequest",
    async (
      _label: string,
      _request: () => Promise<unknown>,
      _priority?: string,
      options?: { maxRetries?: number }
    ) => {
      retryOptions.push(options?.maxRetries);
      const gate = gates[callCount];
      callCount += 1;
      return gate.promise;
    }
  );

  const noRetryRead = ragicClient.getEntry(
    "/default/test/entry",
    "E1",
    false,
    { maxRetries: 0 }
  );
  const defaultRetryRead = ragicClient.getEntry(
    "/default/test/entry",
    "E1",
    false
  );

  await nextTick();
  assert.equal(callCount, 2);
  assert.deepEqual(retryOptions, [0, undefined]);

  gates[0].resolve({ data: { _ragicId: "E1", name: "no-retry" } });
  gates[1].resolve({ data: { _ragicId: "E1", name: "default-retry" } });

  assert.deepEqual(await Promise.all([noRetryRead, defaultRetryRead]), [
    { _ragicId: "E1", name: "no-retry" },
    { _ragicId: "E1", name: "default-retry" },
  ]);
});

test("getFormPage 多 where cache key 不會因分隔符碰撞共用錯頁", async (t) => {
  ragicClient.clearCache();
  const client = ragicClient as unknown as RagicClientInternals;
  let callCount = 0;

  t.mock.method(client, "runReadRequest", async () => {
    callCount += 1;
    return callCount === 1
      ? { data: { first: { _ragicId: "first" } } }
      : { data: { second: { _ragicId: "second" } } };
  });

  const first = await ragicClient.getFormPage(
    "/default/test/6",
    { limit: 10, offset: 0, where: ["a|b", "c"] },
    true
  );
  const second = await ragicClient.getFormPage(
    "/default/test/6",
    { limit: 10, offset: 0, where: ["a", "b|c"] },
    true
  );

  assert.deepEqual(first, { first: { _ragicId: "first" } });
  assert.deepEqual(second, { second: { _ragicId: "second" } });
  assert.equal(callCount, 2);
});

test("clearFormCache 不會讓不相關表單的 in-flight read 失去快取寫回", async (t) => {
  ragicClient.clearCache();
  const client = ragicClient as unknown as RagicClientInternals;
  const gate = deferred<{ data: RagicFormData }>();
  let callCount = 0;

  t.mock.method(client, "runReadRequest", async () => {
    callCount += 1;
    if (callCount === 1) {
      return gate.promise;
    }
    return { data: { unexpected: { _ragicId: "unexpected" } } };
  });

  const read = ragicClient.getFormPage("/default/test/7", { limit: 10, offset: 0 }, true);
  await nextTick();
  assert.equal(callCount, 1);

  ragicClient.clearFormCache("/default/other/1");
  gate.resolve({ data: { fresh: { _ragicId: "fresh" } } });

  assert.deepEqual(await read, { fresh: { _ragicId: "fresh" } });
  assert.deepEqual(
    await ragicClient.getFormPage("/default/test/7", { limit: 10, offset: 0 }, true),
    { fresh: { _ragicId: "fresh" } }
  );
  assert.equal(callCount, 1);
});

test("createEntry body-level validation error exposes 400 upstream detail", async (t) => {
  const client = ragicClient as unknown as RagicClientInternals;
  t.mock.method(client, "runWriteRequest", async () => ({
    data: {
      status: "ERROR",
      msg: "Field Type報工類別 contains empty value",
      code: 202,
    },
  }));

  await assert.rejects(
    () => ragicClient.createEntry("/default/test/8", { name: "invalid" }, true),
    (error: unknown) => {
      const detail = (error as { upstreamDetail?: { status?: number; ragicCode?: number } })
        .upstreamDetail;
      assert.equal((error as { code?: string }).code, "RAGIC_WRITE_FAILED");
      assert.equal(detail?.status, 400);
      assert.equal(detail?.ragicCode, 202);
      assert.match((error as Error).message, /Field Type報工類別 contains empty value/);
      return true;
    }
  );
});
