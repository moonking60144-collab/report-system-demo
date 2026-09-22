import assert from "node:assert/strict";
import test from "node:test";
import { reconcileHardDeleteWriteFailure } from "../../src/services/workReportService";
import { HttpError } from "../../src/utils/httpError";

test("刪除回應失敗但讀回確認明細已不存在時視為成功", async () => {
  await assert.doesNotReject(() =>
    reconcileHardDeleteWriteFailure(new Error("ECONNABORTED"), async () => {
      throw new HttpError(404, "找不到報工明細", "REPORT_NOT_FOUND");
    })
  );
});

test("刪除回應失敗且讀回確認明細仍存在時不自動送出第二次刪除", async () => {
  const writeError = new Error("Ragic rejected delete payload");
  await assert.rejects(
    () => reconcileHardDeleteWriteFailure(writeError, async () => {}),
    (error: unknown) => error === writeError
  );
});

test("刪除回應與讀回結果都不可確認時回 typed indeterminate error", async () => {
  await assert.rejects(
    () =>
      reconcileHardDeleteWriteFailure(new Error("ECONNABORTED"), async () => {
        throw new Error("ETIMEDOUT");
      }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.statusCode === 502 &&
      error.code === "RAGIC_DELETE_INDETERMINATE"
  );
});
