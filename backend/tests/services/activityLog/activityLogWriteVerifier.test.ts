import test from "node:test";
import assert from "node:assert/strict";
import { ragicClient, type RagicRecord } from "../../../src/ragic/client";
import {
  inspectActivityLogEntryStored,
  verifyNewlyCreatedActivityLogEntryOrRollback,
  type VerifyActivityLogEntryExpected,
  type VerifyActivityLogEntryOptions,
} from "../../../src/services/activityLog/activityLogWriteVerifier";
import { env } from "../../../src/config/env";
import { HttpError } from "../../../src/utils/httpError";

// 用 node:test 的 mock.method 暫時取代 ragicClient.getEntry / deleteEntry，
// 不影響 module-level singleton 的長期狀態（mock 自動在 test 結束 restore）。

const FORM_PATH = "/demo/activity-log-tests";
const ENTRY_ID = "E-TEST-1";

function assertActivityLogEntryStored(
  activityLogPath: string,
  entryId: string,
  expected: VerifyActivityLogEntryExpected,
  options?: VerifyActivityLogEntryOptions
) {
  return verifyNewlyCreatedActivityLogEntryOrRollback({
    activityLogPath,
    entryId,
    expected,
    createOperationId: "test-create-operation",
    options,
  });
}

function found(record: RagicRecord) {
  return { kind: "found" as const, record };
}

function buildEntryWith({
  workOrderNo,
  type,
}: {
  workOrderNo?: string;
  type?: string;
}): RagicRecord {
  const record: Record<string, unknown> = {};
  if (workOrderNo !== undefined) {
    record[env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID] = workOrderNo;
  }
  if (type !== undefined) {
    record[env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID] = type;
  }
  return record as RagicRecord;
}

test("immediate rollback wrapper 缺少 create operation ownership 時不讀也不刪", async (t) => {
  const observeMock = t.mock.method(ragicClient, "observeEntry", async () =>
    found(buildEntryWith({ workOrderNo: "WO-100", type: "PROC-A" }))
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    verifyNewlyCreatedActivityLogEntryOrRollback({
      activityLogPath: FORM_PATH,
      entryId: ENTRY_ID,
      expected: { workOrderNo: "WO-100" },
      createOperationId: "   ",
    }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "ACTIVITY_LOG_WRITE_ROLLBACK_OWNER_REQUIRED"
  );
  assert.equal(observeMock.mock.callCount(), 0);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("pure inspector 遇到 mismatch 只回 observation，不會 rollback", async (t) => {
  t.mock.method(ragicClient, "observeEntry", async () =>
    found(buildEntryWith({ workOrderNo: "WO-OBSERVED", type: "PROC-A" }))
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const observation = await inspectActivityLogEntryStored(
    FORM_PATH,
    ENTRY_ID,
    { workOrderNo: "WO-EXPECTED", type: "PROC-A" }
  );

  assert.equal(observation.kind, "mismatch");
  assert.deepEqual(observation.kind === "mismatch" ? observation.mismatches : [], [
    { field: "workOrderNo", expected: "WO-EXPECTED", actual: "WO-OBSERVED" },
  ]);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("verify 全部欄位都吻合 → 回傳 verified entry，不呼叫 deleteEntry", async (t) => {
  const storedEntry = buildEntryWith({ workOrderNo: "WO-100", type: "PROC-A" });
  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () => found(storedEntry));
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  const result = await assertActivityLogEntryStored(FORM_PATH, ENTRY_ID, {
    workOrderNo: "WO-100",
    type: "PROC-A",
  });

  assert.equal(result, storedEntry);
  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("verify 可由 caller 指定讀取 lane、timeout 與 retry", async (t) => {
  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () =>
    found(buildEntryWith({ workOrderNo: "WO-100", type: "PROC-A" }))
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assertActivityLogEntryStored(
    FORM_PATH,
    ENTRY_ID,
    {
      workOrderNo: "WO-100",
      type: "PROC-A",
    },
    {
      readPriority: "user",
      timeoutMs: 4321,
      maxRetries: 0,
    }
  );

  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.deepEqual(getEntryMock.mock.calls[0]?.arguments, [
    FORM_PATH,
    ENTRY_ID,
    { timeoutMs: 4321, priority: "user", maxRetries: 0 },
  ]);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("verify entry 不存在（getEntry 回 null）→ throw RAGIC_WRITE_GONE，不 delete", async (t) => {
  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () => ({ kind: "gone" }));
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    () => assertActivityLogEntryStored(FORM_PATH, ENTRY_ID, { workOrderNo: "WO-100" }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "RAGIC_WRITE_GONE");
      assert.equal(err.statusCode, 502);
      return true;
    }
  );
  assert.equal(getEntryMock.mock.callCount(), 1);
  // entry 已不存在，不需要再 delete
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("verify 讀取錯誤預設仍會往外 throw，不 delete", async (t) => {
  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    () => assertActivityLogEntryStored(FORM_PATH, ENTRY_ID, { workOrderNo: "WO-100" }),
    /ECONNABORTED/
  );
  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("verify 讀取錯誤可標記為狀態未知後放行，避免慢但已寫入被當失敗", async (t) => {
  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);
  const indeterminatePayloads: unknown[] = [];

  const result = await assertActivityLogEntryStored(
    FORM_PATH,
    ENTRY_ID,
    { workOrderNo: "WO-100" },
    {
      continueOnReadError: true,
      onReadIndeterminate: (payload) => {
        indeterminatePayloads.push(payload);
      },
    }
  );

  assert.equal(result, null);
  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.equal(deleteEntryMock.mock.callCount(), 0);
  assert.equal(indeterminatePayloads.length, 1);
  assert.deepEqual(
    {
      activityLogPath: (indeterminatePayloads[0] as { activityLogPath: string }).activityLogPath,
      entryId: (indeterminatePayloads[0] as { entryId: string }).entryId,
      errorMessage: (indeterminatePayloads[0] as { errorMessage: string }).errorMessage,
    },
    {
      activityLogPath: FORM_PATH,
      entryId: ENTRY_ID,
      errorMessage: "ECONNABORTED",
    }
  );
});

test("verify workOrderNo mismatch → DELETE 該 entry + throw", async (t) => {
  let reads = 0;
  t.mock.method(ragicClient, "observeEntry", async () => ++reads === 1
    ? found(buildEntryWith({ workOrderNo: "", type: "PROC-A" }))
    : { kind: "gone" as const });
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    () =>
      assertActivityLogEntryStored(FORM_PATH, ENTRY_ID, {
        workOrderNo: "WO-100", // 期望有 WO，實際空 → orphan 種子
      }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "RAGIC_WRITE_ROLLBACK_CONFIRMED");
      assert.match(err.message, /workOrderNo/);
      assert.match(err.message, /已回滾刪除/);
      return true;
    }
  );
  assert.equal(deleteEntryMock.mock.callCount(), 1);
  assert.deepEqual(deleteEntryMock.mock.calls[0]?.arguments, [FORM_PATH, ENTRY_ID]);
});

test("verify type mismatch → DELETE + throw", async (t) => {
  t.mock.method(ragicClient, "observeEntry", async () =>
    found(buildEntryWith({ workOrderNo: "WO-100", type: "" }))
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    () =>
      assertActivityLogEntryStored(FORM_PATH, ENTRY_ID, {
        workOrderNo: "WO-100",
        type: "PROC-A",
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
  t.mock.method(ragicClient, "observeEntry", async () =>
    found(buildEntryWith({ workOrderNo: "wrong", type: "wrong" }))
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assert.rejects(
    () =>
      assertActivityLogEntryStored(FORM_PATH, ENTRY_ID, {
        workOrderNo: "WO-100",
        type: "PROC-A",
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
  t.mock.method(ragicClient, "observeEntry", async () =>
    found(buildEntryWith({ workOrderNo: "wrong", type: "PROC-A" }))
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => {
    throw new Error("ragic-delete-failed");
  });

  await assert.rejects(
    () =>
      assertActivityLogEntryStored(FORM_PATH, ENTRY_ID, {
        workOrderNo: "WO-100",
        type: "PROC-A",
      }),
    (err: unknown) => {
      // 仍丟原本的 verify-failed，不該變成 delete error
      assert.ok(err instanceof HttpError);
      assert.equal(err.code, "RAGIC_WRITE_ROLLBACK_UNCONFIRMED");
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
  t.mock.method(ragicClient, "observeEntry", async () =>
    found(buildEntryWith({ workOrderNo: "WO-100", type: "wrong-but-not-checked" }))
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assertActivityLogEntryStored(FORM_PATH, ENTRY_ID, {
    workOrderNo: "WO-100",
    // type 沒傳 → 不驗
  });
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});

test("expected.workOrderNo 傳空字串 → 驗證實際也是空（downtime 路徑）", async (t) => {
  t.mock.method(ragicClient, "observeEntry", async () =>
    found(buildEntryWith({ workOrderNo: "", type: "" }))
  );
  const deleteEntryMock = t.mock.method(ragicClient, "deleteEntry", async () => undefined);

  await assertActivityLogEntryStored(FORM_PATH, ENTRY_ID, {
    workOrderNo: "",
    type: "",
  });
  assert.equal(deleteEntryMock.mock.callCount(), 0);
});
