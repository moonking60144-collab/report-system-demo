import assert from "node:assert/strict";
import test from "node:test";
import { env, resolveWorkReportDataPath, resolveWritePath } from "../../src/config/env";
import { getFormConfig } from "../../src/config/forms";
import { ragicClient } from "../../src/ragic/client";
import { saveActivityLogRow, writeToRagic } from "../../src/services/work-report/shared/workReportWriteHelpers";
import { executeSaveActionButton, triggerActivityLogRowRecalculateFlow } from "../../src/services/work-report/recalculate/workReportRecalculate";

type Transport = { runWriteRequest: (...args: unknown[]) => Promise<unknown> };

for (const kind of ["same", "trailing-slash", "different"] as const) {
  test(`writeToRagic invalidates each affected form once: ${kind}`, async (t) => {
    const config = getFormConfig("901");
    const writePath = resolveWritePath("901", config.ragicPath)!;
    const canonical = kind === "different" ? "/canonical/form-901" : `${writePath}${kind === "trailing-slash" ? "/" : ""}`;
    t.mock.method(ragicClient as unknown as Transport, "runWriteRequest", async () => ({ data: { status: "SUCCESS" } }));
    const notifications: string[] = [];
    const unsubscribe = ragicClient.onFormCacheCleared((path) => notifications.push(path ?? "all"));
    t.after(unsubscribe);
    await writeToRagic("901", { ...config, ragicPath: canonical }, "entry", { value: 1 });
    assert.deepEqual(notifications, kind === "different" ? [writePath, canonical] : [writePath]);
  });
}

test("saveActivityLogRow retains client invalidation and skips empty payload", async (t) => {
  const transport = t.mock.method(ragicClient as unknown as Transport, "runWriteRequest", async () => ({ data: { status: "SUCCESS" } }));
  const notifications: string[] = [];
  t.after(ragicClient.onFormCacheCleared((path) => notifications.push(path ?? "all")));
  await saveActivityLogRow("/test/activity-log", "row", {});
  await saveActivityLogRow("/test/activity-log", "row", { value: 1 });
  assert.equal(transport.mock.callCount(), 1);
  assert.deepEqual(notifications, ["/test/activity-log"]);
});

test("batch action invalidates related forms after each successful row", async (t) => {
  const notifications: string[] = [];
  const writePath = resolveWritePath("903", env.UPSTREAM_ACTIVITY_LOG_PATH)!;
  const expected = [...new Set([writePath, ...["903", "901", "902"].map((id) => resolveWorkReportDataPath(id, getPath(id)))])];
  function getPath(id: string): string {
    return id === "903" ? env.UPSTREAM_ACTIVITY_LOG_PATH : id === "901" ? env.RAGIC_FORM_901_PATH : env.RAGIC_FORM_902_PATH;
  }
  let writes = 0;
  t.mock.method(ragicClient as unknown as Transport, "runWriteRequest", async () => {
    assert.deepEqual(notifications, writes === 0 ? [] : expected);
    writes += 1;
    return { data: { status: "SUCCESS" } };
  });
  t.after(ragicClient.onFormCacheCleared((path) => notifications.push(path ?? "all")));
  await triggerActivityLogRowRecalculateFlow("entry", ["row-1", "row-2"]);
  assert.equal(writes, 2);
  assert.deepEqual(notifications, [...expected, ...expected]);
});

test("rejected action does not emit successful cache invalidation", async (t) => {
  t.mock.method(ragicClient as unknown as Transport, "runWriteRequest", async () => ({ data: { status: "ERROR", msg: "rejected" } }));
  const notifications: unknown[] = [];
  t.after(ragicClient.onFormCacheCleared((path) => notifications.push(path)));
  await assert.rejects(executeSaveActionButton({ source: "activityLog-row", formPath: "/test/activity-log", targetEntryId: "row", buttonId: "9003" }, "entry", "row"));
  assert.deepEqual(notifications, []);
});
