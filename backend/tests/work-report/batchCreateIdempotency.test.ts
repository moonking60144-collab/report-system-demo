import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import {
  createBatchCreateRowKeyRepository,
  type BatchCreateRowKeyRepository,
} from "../../src/storage/sqlite/batchCreateRowKeyRepository";
import { initializeReadModelSchema } from "../../src/storage/sqlite/readModelSchema";
import { createRowWithIdempotency } from "../../src/services/work-report/workReportBatchCreateTaskService";
import { HttpError, UpstreamError } from "../../src/utils/httpError";

async function buildRepo() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await initializeReadModelSchema(db);
  return createBatchCreateRowKeyRepository(async () => db);
}

test("沒帶 clientRowKey 時拒絕寫入，避免背景重試重複新增", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    return { rowId: `R-${callCount}` };
  };

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 } },
        formId: "104",
        entryId: "E-1",
        createRow,
        rowKeyRepo,
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BATCH_CREATE_ROW_KEY_REQUIRED"
  );
  assert.equal(callCount, 0);
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

test("同 key 但 formId / entryId 不同 → 拒絕重用，不建立新 row", async () => {
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
  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "shared-key" },
        formId: "104",
        entryId: "E-2",
        createRow,
        rowKeyRepo,
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BATCH_CREATE_ROW_KEY_CONFLICT"
  );

  assert.equal(callCount, 1, "跨 entry 不該再 createRow");
  assert.equal(rowId1, "R-1");

  // 原映射應保留為 E-1 → R-1
  const mapping = await rowKeyRepo.lookup("shared-key");
  assert.equal(mapping?.entryId, "E-1");
  assert.equal(mapping?.ragicRowId, "R-1");
});

test("lookup miss 後 reservation 被其他 entry 搶先時拒絕寫入 Ragic", async () => {
  let createRowCalls = 0;
  const rowKeyRepo: BatchCreateRowKeyRepository = {
    lookup: async () => null,
    reservePending: async () => ({
      reserved: false,
      record: {
        clientRowKey: "raced-key",
        formId: "104",
        entryId: "E-other",
        ragicRowId: "",
        status: "pending",
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    }),
    confirm: async () => 0,
    markIndeterminate: async () => {},
    markStalePendingIndeterminate: async () => 0,
    releasePending: async () => 0,
    record: async () => 0,
    deleteByRagicRowId: async () => 0,
    cleanupOlderThan: async () => 0,
  };

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "raced-key" },
        formId: "104",
        entryId: "E-requested",
        rowKeyRepo,
        createRow: async () => {
          createRowCalls += 1;
          return { rowId: "R-SHOULD-NOT-EXIST" };
        },
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BATCH_CREATE_ROW_KEY_CONFLICT"
  );

  assert.equal(createRowCalls, 0);
});

test("Ragic 已建立但 confirm reservation 失去 owner 時回 typed failure", async () => {
  let createRowCalls = 0;
  const rowKeyRepo: BatchCreateRowKeyRepository = {
    lookup: async () => null,
    reservePending: async () => ({
      reserved: true,
      record: {
        clientRowKey: "lost-owner-key",
        formId: "104",
        entryId: "E-1",
        ragicRowId: "",
        status: "pending",
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    }),
    confirm: async () => 0,
    markIndeterminate: async () => {},
    markStalePendingIndeterminate: async () => 0,
    releasePending: async () => 0,
    record: async () => 0,
    deleteByRagicRowId: async () => 0,
    cleanupOlderThan: async () => 0,
  };

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "lost-owner-key" },
        formId: "104",
        entryId: "E-1",
        rowKeyRepo,
        createRow: async () => {
          createRowCalls += 1;
          return { rowId: "R-created" };
        },
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BATCH_CREATE_ROW_KEY_RECORD_FAILED"
  );

  assert.equal(createRowCalls, 1);
});

test("createRow 拋錯 → 不寫入映射，重試時可重新嘗試", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error("ENOTFOUND fdtw.app");
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

test("createRow 回應未知錯誤 → 標成 indeterminate，重試同 key 不再打 Ragic", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    throw new Error("ECONNABORTED");
  };

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "key-unknown" },
        formId: "104",
        entryId: "E-1",
        createRow,
        rowKeyRepo,
      }),
    /ECONNABORTED/
  );

  const mapping = await rowKeyRepo.lookup("key-unknown");
  assert.equal(mapping?.status, "indeterminate");
  assert.equal(mapping?.ragicRowId, "");

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "key-unknown" },
        formId: "104",
        entryId: "E-1",
        createRow,
        rowKeyRepo,
      }),
    (error: unknown) =>
      error instanceof Error &&
      /寫入結果尚未確認/.test(error.message) &&
      (error as { code?: string }).code === "BATCH_CREATE_ROW_INDETERMINATE"
  );
  assert.equal(callCount, 1, "indeterminate key 不應再次 createRow");
});

test("createRow 拋出 RAGIC_WRITE_FAILED 5xx HttpError → 標成 indeterminate，避免重送重複新增", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    throw new HttpError(502, "建立 Ragic 紀錄失敗：Bad gateway", "RAGIC_WRITE_FAILED");
  };

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "key-http-502" },
        formId: "104",
        entryId: "E-1",
        createRow,
        rowKeyRepo,
      }),
    /Bad gateway/
  );

  const mapping = await rowKeyRepo.lookup("key-http-502");
  assert.equal(mapping?.status, "indeterminate");

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "key-http-502" },
        formId: "104",
        entryId: "E-1",
        createRow,
        rowKeyRepo,
      }),
    /寫入結果尚未確認/
  );
  assert.equal(callCount, 1, "RAGIC_WRITE_FAILED 5xx 應封鎖同 key 重送");
});

test("createRow 拋出新增後讀不到明細列 → 標成 indeterminate，避免重送重複新增", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    throw new HttpError(502, "新增成功但讀不到新明細列", "RAGIC_WRITE_FAILED");
  };

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "key-created-not-found" },
        formId: "104",
        entryId: "E-1",
        createRow,
        rowKeyRepo,
      }),
    /新增成功但讀不到新明細列/
  );

  const mapping = await rowKeyRepo.lookup("key-created-not-found");
  assert.equal(mapping?.status, "indeterminate");
  assert.equal(callCount, 1);
});

test("createRow 拋出 Ragic 寫入後結果不可確認 code → 標成 indeterminate，避免重送重複新增", async () => {
  const indeterminateCodes = [
    "RAGIC_WRITE_GONE",
    "RAGIC_WRITE_ROLLBACK_UNCONFIRMED",
  ];

  for (const code of indeterminateCodes) {
    const rowKeyRepo = await buildRepo();
    let callCount = 0;
    const clientRowKey = `key-${code}`;
    const createRow = async () => {
      callCount += 1;
      throw new HttpError(502, `Form 16 寫入結果不可確認：${code}`, code);
    };

    await assert.rejects(
      () =>
        createRowWithIdempotency({
          row: { payload: { a: 1 }, clientRowKey },
          formId: "104",
          entryId: "E-1",
          createRow,
          rowKeyRepo,
        }),
      new RegExp(code)
    );

    const mapping = await rowKeyRepo.lookup(clientRowKey);
    assert.equal(mapping?.status, "indeterminate", `${code} should pin key`);

    await assert.rejects(
      () =>
        createRowWithIdempotency({
          row: { payload: { a: 1 }, clientRowKey },
          formId: "104",
          entryId: "E-1",
          createRow,
          rowKeyRepo,
        }),
      /寫入結果尚未確認/
    );
    assert.equal(callCount, 1, `${code} should not retry createRow`);
  }
});

test("createRow 拋出上游 4xx RAGIC_WRITE_FAILED → 釋放 pending，修正後可重試", async () => {
  const rowKeyRepo = await buildRepo();
  let callCount = 0;
  const createRow = async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new UpstreamError(
        "建立 Ragic 紀錄失敗 (HTTP 400)：invalid payload",
        "RAGIC_WRITE_FAILED",
        { status: 400, message: "invalid payload" }
      );
    }
    return { rowId: "R-2" };
  };

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "key-http-400" },
        formId: "104",
        entryId: "E-1",
        createRow,
        rowKeyRepo,
      }),
    /invalid payload/
  );

  assert.equal(await rowKeyRepo.lookup("key-http-400"), null);

  const rowId = await createRowWithIdempotency({
    row: { payload: { a: 1 }, clientRowKey: "key-http-400" },
    formId: "104",
    entryId: "E-1",
    createRow,
    rowKeyRepo,
  });
  assert.equal(rowId, "R-2");
  assert.equal(callCount, 2);
});

test("已存在 pending key 但不是本次 reserve → 重試同 key 不再打 Ragic", async () => {
  const rowKeyRepo = await buildRepo();
  await rowKeyRepo.reservePending({
    clientRowKey: "key-pending",
    formId: "104",
    entryId: "E-1",
  });
  let callCount = 0;

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "key-pending" },
        formId: "104",
        entryId: "E-1",
        createRow: async () => {
          callCount += 1;
          return { rowId: "R-SHOULD-NOT-CREATE" };
        },
        rowKeyRepo,
      }),
    /寫入結果尚未確認/
  );

  assert.equal(callCount, 0);
});

test("lookup 本身 throw → fail closed，不寫 Ragic", async () => {
  let callCount = 0;
  const brokenRepo = {
    lookup: async () => {
      throw new Error("sqlite down");
    },
    reservePending: async () => {
      throw new Error("sqlite down");
    },
    confirm: async () => 1,
    markIndeterminate: async () => {},
    markStalePendingIndeterminate: async () => 0,
    releasePending: async () => 0,
    record: async () => 1,
    deleteByRagicRowId: async () => 0,
    cleanupOlderThan: async () => 0,
  };

  await assert.rejects(
    () =>
      createRowWithIdempotency({
        row: { payload: { a: 1 }, clientRowKey: "key-fallback" },
        formId: "104",
        entryId: "E-1",
        createRow: async (payload) => {
          callCount += 1;
          void payload;
          return { rowId: "R-fallback" };
        },
        rowKeyRepo: brokenRepo,
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BATCH_CREATE_ROW_KEY_STORE_UNAVAILABLE"
  );
  assert.equal(callCount, 0);
});
