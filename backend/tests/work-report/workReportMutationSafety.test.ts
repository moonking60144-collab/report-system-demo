import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AxiosError } from "axios";
import { env } from "../../src/config/env";
import { createReportTaskService } from "../../src/services/createReportTaskService";
import { runWorkReportEntryMutationExclusive } from "../../src/services/work-report/workReportEntryMutationQueue";
import { workReportTaskRegistryService } from "../../src/services/work-report/workReportTaskRegistryService";
import { workReportService } from "../../src/services/workReportService";
import { ragicClient, type RagicWriteRequestOptions } from "../../src/ragic/client";
import { RagicRequestScheduler } from "../../src/infra/ragicRequestScheduler";
import { CircuitBreakerOpenError } from "../../src/infra/circuitBreaker";
import { runWithWriteRetry } from "../../src/infra/ragicWriteRetry";

test("任務狀態落盤前不呼叫 worker，保存失敗也不派送", async (t) => {
  const internals = createReportTaskService as unknown as { persistToDisk: () => Promise<void> };
  const previousEnabled = env.CREATE_TASK_PERSIST_ENABLED;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  let failPersist = false;
  t.mock.method(internals, "persistToDisk", async () => {
    await barrier;
    if (failPersist) throw new Error("ENOSPC fixture");
  });
  Object.assign(env, { CREATE_TASK_PERSIST_ENABLED: true });
  try {
    const enqueue = (entryId: string) => createReportTaskService.enqueue({
      taskType: "update-report", operationKind: "update-sort-order", formId: "901", entryId,
      queueKey: `901:${entryId}`, worker: async () => { writes += 1; return {}; },
    });
    const task = enqueue("E-PERSIST-BARRIER");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(writes, 0, "DISPATCH_MUST_WAIT_FOR_DURABLE_RUNNING");
    release();
    await runWorkReportEntryMutationExclusive("901", task.entryId, async () => undefined);
    await createReportTaskService.flush();
    assert.equal(writes, 1);
    assert.equal(createReportTaskService.getTask(task.taskId)?.status, "success");

    failPersist = true;
    const failed = enqueue("E-PERSIST-FAILURE");
    await runWorkReportEntryMutationExclusive("901", failed.entryId, async () => undefined);
    await createReportTaskService.flush();
    assert.equal(writes, 1, "PERSISTENCE_FAILURE_MUST_NOT_DISPATCH");
    assert.equal(createReportTaskService.getTask(failed.taskId)?.error?.code, "TASK_PERSISTENCE_FAILED");
    assert.equal(createReportTaskService.getTask(failed.taskId)?.writeIndeterminate, false);
  } finally {
    release();
    await createReportTaskService.flush();
    Object.assign(env, { CREATE_TASK_PERSIST_ENABLED: previousEnabled });
  }
});

test("實際程序中斷後保留 running 寫入意圖，並區分新舊 pending 快照", () => {
  const store = join(mkdtempSync(join(tmpdir(), "mutation-restart-")), "tasks.json");
  const servicePath = require.resolve("../../src/services/createReportTaskService");
  const envPath = require.resolve("../../src/config/env");
  const child = (action: string) => {
    const source = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const { env } = require(${JSON.stringify(envPath)});
      const { createReportTaskService: service } = require(${JSON.stringify(servicePath)});
      env.CREATE_TASK_PERSIST_ENABLED = true;
      (async () => { await service.initialize(); ${action} })().catch(error => { console.error(error); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, [
      ...(servicePath.endsWith(".ts") ? ["--import", "tsx"] : []), "-e", source,
    ], { env: { ...process.env, CREATE_TASK_PERSIST_ENABLED: "false", CREATE_TASK_STORE_FILE: store,
      WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: "false" }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  };
  child(`service.enqueue({ formId: '901', entryId: 'CRASH', queueKey: '901:CRASH',
    taskType: 'update-report', operationKind: 'update-sort-order', clientMutationId: 'crash-id',
    worker: async () => {
      const disk = JSON.parse(fs.readFileSync(env.CREATE_TASK_STORE_FILE, 'utf8'));
      assert.equal(disk.version, 'v1', 'ROLLBACK_MUST_STILL_ACCEPT_SNAPSHOT');
      assert.equal(disk.dispatchBarrierVersion, 1);
      assert.equal(disk.tasks[0].status, 'running', 'DISPATCH_MUST_HAVE_DURABLE_RUNNING');
      process.exit(0);
    } });`);
  const snapshot = JSON.parse(readFileSync(store, "utf8"));
  const taskId = snapshot.tasks[0].taskId;
  child(`const task = service.getTask(${JSON.stringify(taskId)});
    assert.equal(task.writeIndeterminate, true, 'CRASH_MUST_PRESERVE_UNCERTAINTY');
    const duplicate = service.enqueue({ formId: '901', entryId: 'CRASH', queueKey: '901:CRASH',
      clientMutationId: 'crash-id', worker: async () => { throw new Error('must not repeat'); } });
    assert.equal(duplicate.taskId, task.taskId);
    await service.flush(); process.exit(0);`);
  for (const dispatchBarrierVersion of [undefined, 1]) {
    writeFileSync(store, JSON.stringify({ ...snapshot, dispatchBarrierVersion, tasks: [{ ...snapshot.tasks[0], status: "pending", startedAt: undefined }] }));
    child(`const task = service.getTask(${JSON.stringify(taskId)});
      assert.equal(task.writeIndeterminate, ${dispatchBarrierVersion === undefined}, 'LEGACY_PENDING_CANNOT_PROVE_NO_DISPATCH');
      assert.equal(task.status, 'failed'); await service.flush(); process.exit(0);`);
  }
});

test("真正 scheduler 拒絕派送經 command/helper/task 仍是已知失敗，派送後斷線則保留不明", async (t) => {
  const previousThreshold = env.RAGIC_CIRCUIT_FAILURE_THRESHOLD;
  Object.assign(env, { RAGIC_CIRCUIT_FAILURE_THRESHOLD: 1 });
  try {
    const scheduler = new RagicRequestScheduler();
    await assert.rejects(scheduler.runWrite("open-write-circuit", async () => { throw new Error("fixture upstream down"); }));
    let upstreamWrites = 0;
    const read = t.mock.method(ragicClient, "getEntry", async () => ({ "9001088": "No", "9001202": "2026-09-24T00:00:00Z" }));
    const update = t.mock.method(ragicClient, "updateEntry", async (...args: unknown[]) => {
      const options = args[5] as RagicWriteRequestOptions;
      return scheduler.runWrite("blocked-write", async () => { upstreamWrites += 1; return {}; }, { onTiming: options.onAttemptTiming });
    });
    const enqueue = (entryId: string) => createReportTaskService.enqueue({
      taskType: "update-report", operationKind: "update-urgent", formId: "901", entryId, queueKey: `901:${entryId}`,
      worker: async (context) => workReportService.updateUrgent("901", entryId, true, {
        expectedEntryLastUpdatedAt: "2026-09-24T00:00:00Z", onTiming: context?.updateMutationTiming,
      }),
    });
    const rejected = enqueue("E-ADMISSION-REJECTED");
    await runWorkReportEntryMutationExclusive("901", rejected.entryId, async () => undefined);
    const failed = createReportTaskService.getTask(rejected.taskId);
    assert.equal(upstreamWrites, 0);
    assert.equal(failed?.error?.code, "RAGIC_CIRCUIT_OPEN", "ADMISSION_MUST_KEEP_ORIGINAL_ERROR");
    assert.equal(failed?.writeIndeterminate, false);
    assert.equal(workReportTaskRegistryService.getUnresolvedScheduleMutationTaskIds("901", rejected.entryId).length, 0);

    update.mock.mockImplementation(async () => runWithWriteRetry(async () => {
      upstreamWrites += 1;
      throw new AxiosError("connection lost after dispatch", "ECONNABORTED");
    }, { maxRetries: 2, baseDelayMs: 0 }));
    const unknown = enqueue("E-DISPATCHED-TIMEOUT");
    await runWorkReportEntryMutationExclusive("901", unknown.entryId, async () => undefined);
    assert.equal(upstreamWrites, 1);
    assert.equal(createReportTaskService.getTask(unknown.taskId)?.writeIndeterminate, true);
    assert.deepEqual(workReportTaskRegistryService.getUnresolvedScheduleMutationTaskIds("901", unknown.entryId), [unknown.taskId]);

    let writeAccepted = false;
    update.mock.mockImplementation(async () => { writeAccepted = true; return {}; });
    read.mock.mockImplementation(async () => {
      if (writeAccepted) throw new CircuitBreakerOpenError("verify", 1000);
      return { "9001088": "No", "9001202": "2026-09-24T00:00:00Z" };
    });
    const verifyFailed = enqueue("E-VERIFY-ADMISSION-FAILED");
    await runWorkReportEntryMutationExclusive("901", verifyFailed.entryId, async () => undefined);
    assert.equal(writeAccepted, true);
    assert.equal(createReportTaskService.getTask(verifyFailed.taskId)?.error?.code, "RAGIC_WRITE_VERIFY_FAILED");
    assert.equal(createReportTaskService.getTask(verifyFailed.taskId)?.writeIndeterminate, true, "VERIFY_ADMISSION_MUST_NOT_HIDE_ACCEPTED_WRITE");
  } finally {
    Object.assign(env, { RAGIC_CIRCUIT_FAILURE_THRESHOLD: previousThreshold });
  }
});
