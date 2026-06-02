import test from "node:test";
import assert from "node:assert/strict";
import { ragicClient, type RagicRecord } from "../../../src/ragic/client";
import { assertForm16EntryStored } from "../../../src/services/form16/form16WriteVerifier";
import { env } from "../../../src/config/env";
import { HttpError } from "../../../src/utils/httpError";

// 用 node:test 的 mock.method 暫時取代 ragicClient.getEntry / deleteEntry，
// 不影響 module-level singleton 的長期狀態（mock 自動在 test 結束 restore）。

const FORM_PATH = "/default/forms11/16";
const ENTRY_ID = "E-TEST-1";

function buildEntryWith({
  workOrderNo,
  type,
}: {
  workOrderNo?: string;
  type?: string;
}): RagicRecord {
  const record: Record<string, unknown> = {};
  if (workOrderNo !== undefined) {
    record[env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID] = workOrderNo;
  }
  if (type !== undefined) {
    record[env.RAGIC_FORM_16_TYPE_FIELD_ID] = type;
  }
  return record as RagicRecord;
}

test("verify 全部欄位都吻合 → 靜默成功，不呼叫 deleteEntry", async (t) => {
  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () =>
    buildEntryWith({ workOrderNo: "WO-100", type: "TI-ProcessA" })
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assertForm16EntryStored(FORM_PATH, ENTRY_ID, {
    workOrderNo: "WO-100",
    type: "TI-ProcessA",
  });

  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("verify entry 不存在（getEntry 回 null）→ throw RAGIC_WRITE_FAILED，不 delete", async (t) => {
  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () => null);
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    () => assertForm16EntryStored(FORM_PATH, ENTRY_ID, { workOrderNo: "WO-100" }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "RAGIC_WRITE_FAILED");
      assert.equal(err.statusCode, 502);
      return true;
    }
  );
  assert.equal(getEntryMock.mock.callCount(), 1);
  // entry 已不存在，不需要再 delete
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("verify workOrderNo mismatch → DELETE 該 entry + throw", async (t) => {
  t.mock.method(ragicClient, "getEntry", async () =>
    buildEntryWith({ workOrderNo: "", type: "TI-ProcessA" })
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    () =>
      assertForm16EntryStored(FORM_PATH, ENTRY_ID, {
        workOrderNo: "WO-100", // 期望有 WO，實際空 → orphan 種子
      }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "RAGIC_WRITE_FAILED");
      assert.match(err.message, /workOrderNo/);
      assert.match(err.message, /已回滾刪除/);
      return true;
    }
  );
  assert.equal(deleteEntryMock.mock.callCount(), 1);
  assert.deepEqual(deleteEntryMock.mock.calls[0]?.arguments, [FORM_PATH, ENTRY_ID]);
});

test("verify type mismatch → DELETE + throw", async (t) => {
  t.mock.method(ragicClient, "getEntry", async () =>
    buildEntryWith({ workOrderNo: "WO-100", type: "" })
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    () =>
      assertForm16EntryStored(FORM_PATH, ENTRY_ID, {
        workOrderNo: "WO-100",
        type: "TI-ProcessA",
      }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.match(err.message, /type/);
      return true;
    }
  );
  assert.equal(deleteEntryMock.mock.callCount(), 1);
});

test("verify 兩個欄位都 mismatch → 一次列出兩個 + DELETE", async (t) => {
  t.mock.method(ragicClient, "getEntry", async () =>
    buildEntryWith({ workOrderNo: "wrong", type: "wrong" })
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    () =>
      assertForm16EntryStored(FORM_PATH, ENTRY_ID, {
        workOrderNo: "WO-100",
        type: "TI-ProcessA",
      }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.match(err.message, /workOrderNo/);
      assert.match(err.message, /type/);
      return true;
    }
  );
  assert.equal(deleteEntryMock.mock.callCount(), 1);
});

test("verify mismatch 且 DELETE 也失敗 → 仍 throw 原 mismatch error（不掩蓋）", async (t) => {
  t.mock.method(ragicClient, "getEntry", async () =>
    buildEntryWith({ workOrderNo: "wrong", type: "TI-ProcessA" })
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => {
    throw new Error("ragic-delete-failed");
  });

  await assert.rejects(
    () =>
      assertForm16EntryStored(FORM_PATH, ENTRY_ID, {
        workOrderNo: "WO-100",
        type: "TI-ProcessA",
      }),
    (err: unknown) => {
      // 仍丟原本的 verify-failed，不該變成 delete error
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "RAGIC_WRITE_FAILED");
      assert.match(err.message, /workOrderNo/);
      // delete error 訊息不該 leak 出來
      assert.doesNotMatch(err.message, /ragic-delete-failed/);
      return true;
    }
  );

  // 確認 verifier 真的有嘗試 DELETE rollback（不是 silently skip）
  assert.equal(deleteEntryMock.mock.callCount(), 1);
  assert.deepEqual(deleteEntryMock.mock.calls[0]?.arguments, [FORM_PATH, ENTRY_ID]);
});

test("expected 沒給的欄位不驗（例：只驗 workOrderNo）", async (t) => {
  t.mock.method(ragicClient, "getEntry", async () =>
    buildEntryWith({ workOrderNo: "WO-100", type: "wrong-but-not-checked" })
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assertForm16EntryStored(FORM_PATH, ENTRY_ID, {
    workOrderNo: "WO-100",
    // type 沒傳 → 不驗
  });
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("expected.workOrderNo 傳空字串 → 驗證實際也是空（downtime 路徑）", async (t) => {
  t.mock.method(ragicClient, "getEntry", async () =>
    buildEntryWith({ workOrderNo: "", type: "" })
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assertForm16EntryStored(FORM_PATH, ENTRY_ID, {
    workOrderNo: "",
    type: "",
  });
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});
