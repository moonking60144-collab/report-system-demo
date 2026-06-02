import test from "node:test";
import assert from "node:assert/strict";
import { form16ClientRowKeyRepository } from "../../../src/storage/sqlite/form16ClientRowKeyRepository";
import { checkOrCreateForm16Entry } from "../../../src/services/form16/form16IdempotencyService";

// 用 t.mock.method 暫時 stub repository 的 lookup / record，
// 不打真實 SQLite，只驗 service 層 idempotency 邏輯。
//
// 已知未涵蓋：`if (!env.SQLITE_ENABLED)` 那條分支（service line 52-55）。
// env 是 module-load const，runtime 改不了；要測這條只能 refactor 成 DI 注入 env-checker。
// 取捨上 keep production code 簡單，這條 branch 用 manual review 守住。

test("clientRowKey 為空字串 → 直接 create、不 lookup、不 record", async (t) => {
  const lookupMock = t.mock.method(form16ClientRowKeyRepository, "lookup", async () => null);
  const recordMock = t.mock.method(form16ClientRowKeyRepository, "record", async () => undefined);
  const createMock = t.mock.fn(async () => ({ entryId: "E-NEW" }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.entryId, "E-NEW");
  assert.equal(result.reused, false);
  assert.equal(lookupMock.mock.callCount(), 0);
  assert.equal(recordMock.mock.callCount(), 0);
  assert.equal(createMock.mock.callCount(), 1);
});

test("clientRowKey 為純空白 → 視為空，直接 create", async (t) => {
  const lookupMock = t.mock.method(form16ClientRowKeyRepository, "lookup", async () => null);
  const createMock = t.mock.fn(async () => ({ entryId: "E-NEW" }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "   ",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.reused, false);
  assert.equal(lookupMock.mock.callCount(), 0);
  assert.equal(createMock.mock.callCount(), 1);
});

test("clientRowKey null / undefined 都當空 key 處理", async (t) => {
  t.mock.method(form16ClientRowKeyRepository, "lookup", async () => null);
  const createMock = t.mock.fn(async () => ({ entryId: "E-1" }));

  await checkOrCreateForm16Entry({
    clientRowKey: null,
    source: "downtime",
    create: createMock,
  });
  await checkOrCreateForm16Entry({
    clientRowKey: undefined,
    source: "downtime",
    create: createMock,
  });

  assert.equal(createMock.mock.callCount(), 2);
});

test("lookup 命中既有映射 → reused=true、不 call create", async (t) => {
  t.mock.method(form16ClientRowKeyRepository, "lookup", async () => ({
    entryId: "E-EXISTING",
    source: "downtime",
    createdAt: "2026-04-01T00:00:00.000Z",
  }));
  const recordMock = t.mock.method(form16ClientRowKeyRepository, "record", async () => undefined);
  const createMock = t.mock.fn(async () => ({ entryId: "E-NEW" }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "uuid-1",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.entryId, "E-EXISTING");
  assert.equal(result.reused, true);
  assert.equal(createMock.mock.callCount(), 0);
  // 命中 idempotency 不應該重新 record
  assert.equal(recordMock.mock.callCount(), 0);
});

test("lookup miss → create + record 映射", async (t) => {
  t.mock.method(form16ClientRowKeyRepository, "lookup", async () => null);
  const recordMock = t.mock.method(form16ClientRowKeyRepository, "record", async () => undefined);
  const createMock = t.mock.fn(async () => ({ entryId: "E-NEW" }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "uuid-2",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.entryId, "E-NEW");
  assert.equal(result.reused, false);
  assert.equal(createMock.mock.callCount(), 1);
  assert.equal(recordMock.mock.callCount(), 1);
  assert.deepEqual(recordMock.mock.calls[0]?.arguments[0], {
    clientRowKey: "uuid-2",
    entryId: "E-NEW",
    source: "downtime",
  });
});

test("create 回 entryId=null → 不 record（讓下次 retry 同 key 能重新嘗試）", async (t) => {
  t.mock.method(form16ClientRowKeyRepository, "lookup", async () => null);
  const recordMock = t.mock.method(form16ClientRowKeyRepository, "record", async () => undefined);
  const createMock = t.mock.fn(async () => ({ entryId: null }));

  const result = await checkOrCreateForm16Entry({
    clientRowKey: "uuid-3",
    source: "downtime",
    create: createMock,
  });

  assert.equal(result.entryId, null);
  assert.equal(result.reused, false);
  assert.equal(createMock.mock.callCount(), 1);
  // entryId=null 不該 pollute SQLite mapping
  assert.equal(recordMock.mock.callCount(), 0);
});

test("create 拋錯 → 不 record、原 error 往外丟（同 key retry 仍可重新嘗試）", async (t) => {
  t.mock.method(form16ClientRowKeyRepository, "lookup", async () => null);
  const recordMock = t.mock.method(form16ClientRowKeyRepository, "record", async () => undefined);
  const createMock = t.mock.fn(async () => {
    throw new Error("ragic-write-failed");
  });

  await assert.rejects(
    () =>
      checkOrCreateForm16Entry({
        clientRowKey: "uuid-4",
        source: "downtime",
        create: createMock,
      }),
    /ragic-write-failed/
  );

  assert.equal(createMock.mock.callCount(), 1);
  assert.equal(recordMock.mock.callCount(), 0);
});
