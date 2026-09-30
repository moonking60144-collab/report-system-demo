import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import router from "../../src/routes/workReport";
import { errorHandler } from "../../src/middleware/errorHandler";
import { ragicClient, type RagicRecord } from "../../src/ragic/client";
import { getFormConfig } from "../../src/config/forms";
import { env } from "../../src/config/env";
import { workReportTaskRegistryService, WorkReportTaskRegistryService } from "../../src/services/work-report/workReportTaskRegistryService";
import { WorkReportBatchDeleteTaskService } from "../../src/services/work-report/workReportBatchDeleteTaskService";
import { workReportMutationProjectionService } from "../../src/services/work-report-sync/workReportMutationProjectionService";
import { recordAuditLogRepository } from "../../src/storage/sqlite/recordAuditLogRepository";

async function finished(registry: WorkReportTaskRegistryService, taskId: string) {
  for (let i = 0; i < 200; i++) {
    const task = registry.getTask(taskId);
    if (task?.status === "failed" || task?.status === "success") return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("DELETE_RECOVERY_TIMEOUT");
}

test("真實 delete route 失敗後由 retry-finalize 恢復，不重刪明細且更新 projection", async (t) => {
  const config = getFormConfig("901");
  let deleted = false, recalculations = 0, projections = 0;
  t.mock.method(ragicClient, "getEntry", async () => ({
    [config.mainFields.status]: "未結案", [config.writeConfig.subtableId]: deleted ? {} : { "42": { remark: "before" } },
  }));
  t.mock.method(ragicClient, "clearFormCache", () => {});
  t.mock.method(recordAuditLogRepository, "insert", async () => {});
  t.mock.method(workReportMutationProjectionService, "enqueueEntryAfterMutation", async () => { projections++; return 1; });
  t.mock.method(workReportMutationProjectionService, "applyQueuedProjectionAfterMutation", async () => "applied" as const);
  const writes: RagicRecord[] = [];
  t.mock.method(ragicClient, "updateEntry", async (_p: string, _id: string, body: RagicRecord) => {
    writes.push(body);
    if (Object.keys(body).some(key => key.startsWith("_DELSUB_"))) { assert.equal(deleted, false); deleted = true; }
    else if (++recalculations === 1) throw new Error("fixture recalculation failure");
    return {};
  });
  const app = express(); app.use(express.json()); app.use("/api/forms", router); app.use(errorHandler);
  const server = app.listen(0); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/forms/901/reports/recovery-entry`;
  try {
    const response = await fetch(`${base}/42`, { method: "DELETE" });
    assert.equal(response.status, 202);
    const first = await finished(workReportTaskRegistryService, (await response.json()).data.taskId);
    assert.equal(first.deleteFinalizeFailed, true);
    assert.deepEqual(first.deletedRowIds, ["42"]);
    const retry = await fetch(`${base}/batch-delete/${first.taskId}/retry-finalize`, { method: "POST" });
    assert.equal(retry.status, 202);
    const child = await finished(workReportTaskRegistryService, (await retry.json()).data.taskId);
    assert.equal(child.status, "success", "DELETE_FINALIZE_RECOVERY");
    assert.equal(writes.filter(body => Object.keys(body).some(key => key.startsWith("_DELSUB_"))).length, 1);
    assert.equal(recalculations, 2);
    assert.equal(projections, 2, "Deleted state must be projected even when recalculation fails");
    const repeat = await fetch(`${base}/batch-delete/${first.taskId}/retry-finalize`, { method: "POST" });
    assert.equal((await repeat.json()).data.taskId, child.taskId);
    assert.equal(recalculations, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("保存中的刪除任務重載後可收尾，保留未確認項目且拒絕錯誤 ownership", async () => {
  const folder = await mkdtemp(join(tmpdir(), "delete-recovery-"));
  const previous = { enabled: env.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED, file: env.WORK_REPORT_TASK_REGISTRY_STORE_FILE };
  Object.assign(env, { WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: true, WORK_REPORT_TASK_REGISTRY_STORE_FILE: join(folder, "tasks.json") });
  const registry = new WorkReportTaskRegistryService();
  let restored: WorkReportTaskRegistryService | undefined;
  try {
    await registry.initialize();
    registry.upsertTask({ taskId: "interrupted-delete", taskType: "delete-report-batch", status: "running", formId: "901", entryId: "entry", actorClientId: "owner", deletedCount: 1, deletedRowIds: ["101"], deleteFinalizeFailed: false });
    await registry.flush();
    restored = new WorkReportTaskRegistryService(); await restored.initialize();
    const source = restored.getTask("interrupted-delete")!;
    assert.equal(source.status, "failed");
    assert.equal(source.deleteFinalizeFailed, true, "RESTART_FINALIZE_RECOVERY");
    assert.equal(source.batchWriteIndeterminate, true);
    const service = new WorkReportBatchDeleteTaskService(restored);
    let releases!: () => void;
    const gate = new Promise<void>(resolve => { releases = resolve; });
    let finalized = 0;
    const input = { formId: "901", entryId: "entry", taskId: source.taskId, actorClientId: "owner", finalizeAfterDelete: async ({ deletedRowIds }: { deletedRowIds: string[] }) => { assert.deepEqual(deletedRowIds, ["101"]); finalized++; await gate; } };
    assert.throws(() => service.requestBatchDeleteFinalizeRetry({ ...input, entryId: "other" }), /找不到/);
    assert.throws(() => service.requestBatchDeleteFinalizeRetry({ ...input, actorClientId: "other" }), /此裝置/);
    const first = service.requestBatchDeleteFinalizeRetry(input);
    assert.equal(service.requestBatchDeleteFinalizeRetry(input).taskId, first.taskId);
    releases();
    assert.equal((await finished(restored, first.taskId)).status, "success");
    assert.equal(finalized, 1);
    assert.equal(restored.getTask(source.taskId)?.batchWriteIndeterminate, true);
    assert.equal(restored.getTask(source.taskId)?.status, "failed");
  } finally {
    await registry.flush(); await restored?.flush();
    Object.assign(env, { WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: previous.enabled, WORK_REPORT_TASK_REGISTRY_STORE_FILE: previous.file });
  }
});
