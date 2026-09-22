import assert from "node:assert/strict";
import test from "node:test";
import { env, resolveWritePath } from "../../src/config/env";
import { getFormConfig } from "../../src/config/forms";
import { ragicClient } from "../../src/ragic/client";
import { WorkReportWorkOrderCommandService } from "../../src/services/work-report/mutation/workReportWorkOrderCommandService";

test("updateMainMachine 從同一 write target 回傳 live before snapshot", async (t) => {
  const config = getFormConfig("901");
  const writePath = resolveWritePath("901", config.ragicPath);
  assert.ok(writePath);
  let getEntryCalls = 0;
  t.mock.method(ragicClient, "getEntry", async (formPath: string) => {
    assert.equal(formPath, writePath);
    getEntryCalls += 1;
    return { "9001045": getEntryCalls === 1 ? "MB50" : "MA51" };
  });
  t.mock.method(ragicClient, "updateEntry", async (formPath: string) => {
    assert.equal(formPath, writePath);
    return {};
  });
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  const result = await new WorkReportWorkOrderCommandService().updateMainMachine(
    "901",
    "E-901",
    "MA51",
    { expectedMachineCode: "MB50" }
  );

  assert.deepEqual(result, {
    machineCode: "MA51",
    previousMachineCode: "MB50",
    changed: true,
  });
  assert.equal(getEntryCalls, 2);
});

test("updateMainMachine 同值不寫入，已結案則在寫入前拒絕", async (t) => {
  const updateEntryMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));
  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () => ({
    "9001045": "MA51",
    "9001049": "未結案",
  }));

  const unchanged = await new WorkReportWorkOrderCommandService().updateMainMachine(
    "901",
    "E-901",
    "MA51"
  );
  assert.deepEqual(unchanged, {
    machineCode: "MA51",
    previousMachineCode: "MA51",
    changed: false,
  });
  assert.equal(updateEntryMock.mock.callCount(), 0);

  getEntryMock.mock.mockImplementation(async () => ({
    "9001045": "MB50",
    "9001049": "已結案",
  }));
  await assert.rejects(
    () =>
      new WorkReportWorkOrderCommandService().updateMainMachine(
        "901",
        "E-CLOSED",
        "MA51"
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "ENTRY_CLOSED"
  );
  assert.equal(updateEntryMock.mock.callCount(), 0);
});

test("manualCloseWorkOrder 從 action target 回傳 live previous status", async (t) => {
  const config = getFormConfig("901");
  const writePath = resolveWritePath("901", config.ragicPath);
  assert.ok(writePath);
  const mutableEnv = env as { RAGIC_FORM_901_CLOSE_ACTION_BUTTON_ID: string };
  const originalButtonId = mutableEnv.RAGIC_FORM_901_CLOSE_ACTION_BUTTON_ID;
  mutableEnv.RAGIC_FORM_901_CLOSE_ACTION_BUTTON_ID = "9001";
  t.after(() => {
    mutableEnv.RAGIC_FORM_901_CLOSE_ACTION_BUTTON_ID = originalButtonId;
  });
  t.mock.method(ragicClient, "getEntry", async (formPath: string) => {
    assert.equal(formPath, writePath);
    return { "9001049": "未結案" };
  });
  t.mock.method(ragicClient, "executeActionButton", async (formPath: string) => {
    assert.equal(formPath, writePath);
    return { status: "SUCCESS", msg: "ok", raw: {} };
  });
  t.mock.method(ragicClient, "clearFormCache", () => undefined);

  const result = await new WorkReportWorkOrderCommandService().manualCloseWorkOrder(
    "901",
    "E-901",
    "close"
  );

  assert.deepEqual(result, {
    action: "close",
    previousStatus: "未結案",
  });
});
