import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import router from "../../src/routes/workReport";
import { errorHandler } from "../../src/middleware/errorHandler";
import { getFormConfig } from "../../src/config/forms";
import { ragicClient, type RagicRecord } from "../../src/ragic/client";
import { mapSubtable } from "../../src/services/work-report/queries/rowTransform";
import { workReportMutationPreconditionService } from "../../src/services/work-report/mutation/workReportMutationPreconditionService";
import { workReportMutationProjectionService } from "../../src/services/work-report-sync/workReportMutationProjectionService";
import { workReportTaskRegistryService } from "../../src/services/work-report/workReportTaskRegistryService";
import { recordAuditLogRepository } from "../../src/storage/sqlite/recordAuditLogRepository";

for (const changedTarget of [false, true]) {
  test(`正式刪除 route→batch worker→live row guard ${changedTarget ? "同列衝突" : "無關更新放行"}`, async (t) => {
    const config = getFormConfig("901");
    const row = { [config.writeConfig.subtableWriteFields.remark]: "before" };
    const hash = mapSubtable({ "42": row }, config)[0].snapshotHash!;
    t.mock.method(workReportMutationPreconditionService, "assertEntryLockVersion", () => undefined);
    t.mock.method(workReportMutationPreconditionService, "assertEntryEditableBySession", () => undefined);
    const parentGuard = t.mock.method(workReportMutationPreconditionService, "assertEntryNotModified", async () => { throw new Error("PARENT_GUARD_MUST_NOT_BLOCK"); });
    t.mock.method(recordAuditLogRepository, "insert", async () => undefined);
    t.mock.method(workReportMutationProjectionService, "enqueueEntryAfterMutation", async () => 1);
    t.mock.method(workReportMutationProjectionService, "applyQueuedProjectionAfterMutation", async () => "applied" as const);
    t.mock.method(ragicClient, "clearFormCache", () => undefined);
    t.mock.method(ragicClient, "getEntry", async () => ({ "9001202": "new", [config.writeConfig.subtableId]: { "42": changedTarget ? { ...row, [config.writeConfig.subtableWriteFields.remark]: "third" } : row } }));
    const payloads: RagicRecord[] = [];
    t.mock.method(ragicClient, "updateEntry", async (_path: string, _id: string, body: RagicRecord) => { payloads.push(body); return {}; });
    const app = express(); app.use(express.json()); app.use("/api/forms", router); app.use(errorHandler);
    const server = app.listen(0);
    await new Promise<void>(resolve => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/forms/901/reports/1/42`, {
        method: "DELETE", headers: { "Content-Type": "application/json", "x-entry-last-updated-at": "old" }, body: JSON.stringify({ expectedRowSnapshotHash: hash }),
      });
      assert.equal(response.status, 202);
      const taskId = (await response.json()).data.taskId;
      for (let attempt = 0; attempt < 200; attempt++) {
        const task = workReportTaskRegistryService.getTask(taskId);
        if (task?.status === "success" || task?.status === "failed") {
          assert.equal(task.status, changedTarget ? "failed" : "success", "DELETE_ROUTE_SCOPE");
          assert.equal(payloads.length, changedTarget ? 0 : 2, "DELETE_ROUTE_WRITE_GUARD");
          assert.equal(parentGuard.mock.callCount(), 0);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("DELETE_ROUTE_TASK_DID_NOT_FINISH");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
