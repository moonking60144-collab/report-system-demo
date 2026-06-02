import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createBatchCreateRowKeyRepository } from "../../src/storage/sqlite/batchCreateRowKeyRepository";
import { initializeReadModelSchema } from "../../src/storage/sqlite/readModelSchema";
import { createRowWithIdempotency } from "../../src/services/work-report/workReportBatchCreateTaskService";

async function buildRepo() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await initializeReadModelSchema(db);
  return createBatchCreateRowKeyRepository(async () => db);
}

test("沒帶 clientRowKey 時每次都呼 createRow 建新 row", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    return { rowId: `R-${callCount}` };
  };

  const rowId1 = await createRowWithIdempotency({
    row: { payload: { a: 1 } },
    formId: "104",
    entryId: "E-1",
    createRow,
    rowKeyRepo,
  });
  const rowId2 = await createRowWithIdempotency({
    row: { payload: { a: 1 } },
    formId: "104",
    entryId: "E-1",
    createRow,
    rowKeyRepo,
  });

  assert.equal(callCount, 2);
  assert.equal(rowId1, "R-1");
  assert.equal(rowId2, "R-2");
});

test("第一次建立成功 → 記錄映射；第二次同 key 命中 SQLite，不再呼 createRow", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    return { rowId: `R-${callCount}` };
  };

  const rowId1 = await createRowWithIdempotency({
    row: { payload: { a: 1 }, clientRowKey: "key-alpha" },
    formId: "104",
    entryId: "E-1",
    createRow,
    rowKeyRepo,
  });
  const rowId2 = await createRowWithIdempotency({
    row: { payload: { a: 1 }, clientRowKey: "key-alpha" },
    formId: "104",
    entryId: "E-1",
    createRow,
    rowKeyRepo,
  });

  assert.equal(callCount, 1, "第二次不該再 createRow");
  assert.equal(rowId1, "R-1");
  assert.equal(rowId2, "R-1", "idempotent hit 應回傳同 rowId");
});

test("同 key 但 formId / entryId 不同 → 不命中，建新 row，不覆蓋舊映射", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    return { rowId: `R-${callCount}` };
  };

  const rowId1 = await createRowWithIdempotency({
    row: { payload: { a: 1 }, clientRowKey: "shared-key" },
    formId: "104",
    entryId: "E-1",
    createRow,
    rowKeyRepo,
  });
  // 換 entry，但帶同樣 key
  const rowId2 = await createRowWithIdempotency({
    row: { payload: { a: 1 }, clientRowKey: "shared-key" },
    formId: "104",
    entryId: "E-2",
    createRow,
    rowKeyRepo,
  });

  assert.equal(callCount, 2, "跨 entry 應該還是建新 row");
  assert.equal(rowId1, "R-1");
  assert.equal(rowId2, "R-2");

  // 原映射應保留為 E-1 → R-1
  const mapping = await rowKeyRepo.lookup("shared-key");
  assert.equal(mapping?.entryId, "E-1");
  assert.equal(mapping?.ragicRowId, "R-1");
});

test("createRow 拋錯 → 不寫入映射，重試時可重新嘗試", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error("ENOTFOUND demo.local");
    }
    return { rowId: "R-2" };
  };

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "key-retry" },
        formId: "104",
        entryId: "E-1",
        createRow,
        rowKeyRepo,
      }),
    /ENOTFOUND/
  );

  // 映射不該被寫入
  assert.equal(await rowKeyRepo.lookup("key-retry"), null);

  // 第二次 retry 應走「無映射 → 真的建立」路徑
  const rowId = await createRowWithIdempotency({
    row: { payload: { a: 1 }, clientRowKey: "key-retry" },
    formId: "104",
    entryId: "E-1",
    createRow,
    rowKeyRepo,
  });
  assert.equal(callCount, 2);
  assert.equal(rowId, "R-2");

  // 這次成功後映射應已建立
  const mapping = await rowKeyRepo.lookup("key-retry");
  assert.equal(mapping?.ragicRowId, "R-2");
});

test("lookup 本身 throw → 降級為無映射，仍會建 row（不讓 SQLite 問題擋功能）", async () => {
  const createRow = async () => ({ rowId: "R-fallback" });
  const brokenRepo = {
    lookup: async () => {
      throw new Error("sqlite down");
    },
    record: async () => {},
    cleanupOlderThan: async () => 0,
  };

  const rowId = await createRowWithIdempotency({
    row: { payload: { a: 1 }, clientRowKey: "key-fallback" },
    formId: "104",
    entryId: "E-1",
    createRow,
    rowKeyRepo: brokenRepo,
  });
  assert.equal(rowId, "R-fallback");
});
