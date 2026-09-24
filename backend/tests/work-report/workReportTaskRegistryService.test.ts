import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../src/config/env";
import { WorkReportTaskRegistryService } from "../../src/services/work-report/workReportTaskRegistryService";

test("同步耗時寫盤後可恢復，舊任務缺少新欄位仍能載入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sync-timing-registry-"));
  const file = join(dir, "tasks.json");
  const previousEnabled = env.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED;
  const previousFile = env.WORK_REPORT_TASK_REGISTRY_STORE_FILE;
  const registries: WorkReportTaskRegistryService[] = [];
  Object.assign(env, {
    WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: true,
    WORK_REPORT_TASK_REGISTRY_STORE_FILE: file,
  });
  try {
    const registry = new WorkReportTaskRegistryService();
    registries.push(registry);
    await registry.initialize();
    const timings = {
      scanMs: 11, snapshotWriteMs: 23, promotionWaitMs: 250,
      finalReplayMs: 300, promotionSlotHeldMs: 307,
    };
    registry.upsertTask({
      taskId: "sync-new", taskType: "sync", status: "success", formId: "902", ...timings,
    });
    registry.upsertTask({ taskId: "sync-legacy", taskType: "sync", status: "success", formId: "902" });
    await registry.flush();
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    const legacy = snapshot.tasks.find((task: { taskId: string }) => task.taskId === "sync-legacy");
    for (const key of Object.keys(timings)) delete legacy[key];
    await writeFile(file, JSON.stringify(snapshot));
    const restored = new WorkReportTaskRegistryService();
    registries.push(restored);
    await restored.initialize();
    assert.ok(restored.getTask("sync-legacy"));
    for (const [key, value] of Object.entries(timings)) {
      assert.equal(restored.getTask("sync-new")?.[key as keyof typeof timings], value);
      assert.equal(restored.getTask("sync-legacy")?.[key as keyof typeof timings], undefined);
    }
  } finally {
    for (const registry of registries) await registry.flush();
    Object.assign(env, {
      WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: previousEnabled,
      WORK_REPORT_TASK_REGISTRY_STORE_FILE: previousFile,
    });
  }
});

test("批次任務進度欄位會正規化並保留後續狀態更新", () => {
  const registry = new WorkReportTaskRegistryService();
  registry.upsertTask({
    taskId: "batch-progress",
    taskType: "create-report-batch",
    status: "running",
    formId: "901",
    batchRequestedCount: 6.9,
    batchCreatedCount: 2.8,
    batchFailedCount: -1,
  });
  registry.upsertTask({
    taskId: "batch-progress",
    taskType: "create-report-batch",
    status: "success",
    formId: "901",
  });

  const task = registry.getTask("batch-progress");
  assert.ok(task);
  assert.deepEqual(
    {
      batchRequestedCount: task.batchRequestedCount,
      batchCreatedCount: task.batchCreatedCount,
      batchFailedCount: task.batchFailedCount,
    },
    {
      batchRequestedCount: 6,
      batchCreatedCount: 2,
      batchFailedCount: 0,
    }
  );
});

test("blocking schedule aggregate 不受 200 筆 task list 上限截斷", () => {
  const registry = new WorkReportTaskRegistryService();
  registry.upsertTask({
    taskId: "planned-date-oldest",
    taskType: "update-report",
    operationKind: "update-planned-end-date",
    status: "pending",
    formId: "901",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  for (let index = 0; index < 201; index += 1) {
    const timestamp = `2026-02-01T00:${String(index % 60).padStart(2, "0")}:${String(
      Math.floor(index / 60)
    ).padStart(2, "0")}.000Z`;
    registry.upsertTask({
      taskId: `row-update-${index}`,
      taskType: "update-report",
      operationKind: "update-report-row",
      status: "pending",
      formId: "901",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const cappedTasks = registry.listTasks({
    formId: "901",
    status: "pending",
    taskType: "update-report",
    limit: 200,
  });
  assert.equal(cappedTasks.length, 200);
  assert.equal(
    cappedTasks.some((task) => task.taskId === "planned-date-oldest"),
    false
  );
  assert.deepEqual(registry.getBlockingScheduleMutationSummary("901"), {
    hasBlockingScheduleMutation: true,
    count: 1,
  });
});

test("五種列表 entry-field mutation 都會進入 blocking aggregate", () => {
  const registry = new WorkReportTaskRegistryService();
  const operationKinds = [
    "update-start-schedule",
    "update-main-machine",
    "update-urgent",
    "update-sort-order",
    "update-planned-end-date",
  ] as const;

  operationKinds.forEach((operationKind, index) => {
    registry.upsertTask({
      taskId: `entry-field-${index}`,
      taskType: "update-report",
      operationKind,
      status: "pending",
      formId: "901",
      entryId: `E-${index}`,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
  });

  assert.deepEqual(registry.getBlockingScheduleMutationSummary("901"), {
    hasBlockingScheduleMutation: true,
    count: 5,
  });
  assert.equal(registry.hasBlockingScheduleMutationForEntry("901", "E-1"), true);
});

test("blocking schedule aggregate 與 entry guard 都保留 indeterminate mutation", () => {
  const registry = new WorkReportTaskRegistryService();
  registry.upsertTask({
    taskId: "sort-indeterminate",
    taskType: "update-report",
    operationKind: "update-sort-order",
    status: "failed",
    formId: "901",
    entryId: "E-901",
    writeIndeterminate: true,
    errorCode: "RAGIC_WRITE_INDETERMINATE",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:01.000Z",
  });
  registry.upsertTask({
    taskId: "sort-deterministic-failure",
    taskType: "update-report",
    operationKind: "update-sort-order",
    status: "failed",
    formId: "901",
    entryId: "E-FAILED",
    writeIndeterminate: false,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:01.000Z",
  });

  assert.deepEqual(registry.getBlockingScheduleMutationSummary("901"), {
    hasBlockingScheduleMutation: true,
    count: 1,
  });
  assert.equal(registry.hasBlockingScheduleMutationForEntry("901", "E-901"), true);
  assert.equal(
    registry.hasBlockingScheduleMutationForEntry("901", "E-FAILED"),
    false
  );

  assert.equal(
    registry.acknowledgeScheduleMutationObservation(
      "901",
      "E-901",
      registry.getUnresolvedScheduleMutationTaskIds("901", "E-901"),
      "2026-08-31T00:00:02.000Z"
    ),
    1
  );
  assert.equal(registry.hasBlockingScheduleMutationForEntry("901", "E-901"), false);
  assert.deepEqual(registry.getBlockingScheduleMutationSummary("901"), {
    hasBlockingScheduleMutation: false,
    count: 0,
  });
});

test("較新的 authoritative schedule observation 不會在 restart merge 被舊 uncertainty 蓋回", () => {
  const registry = new WorkReportTaskRegistryService();
  registry.upsertTask({
    taskId: "sort-reconciled",
    taskType: "update-report",
    operationKind: "update-sort-order",
    status: "failed",
    formId: "901",
    entryId: "E-RECONCILED",
    writeIndeterminate: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:01.000Z",
  });
  registry.upsertTask({
    taskId: "sort-reconciled",
    taskType: "update-report",
    operationKind: "update-sort-order",
    status: "failed",
    formId: "901",
    entryId: "E-RECONCILED",
    writeIndeterminate: false,
    confirmedAt: "2026-08-31T00:00:02.000Z",
    scheduleMutationObservedAt: "2026-08-31T00:00:02.000Z",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:02.000Z",
  });
  registry.upsertTask({
    taskId: "sort-reconciled",
    taskType: "update-report",
    operationKind: "update-sort-order",
    status: "failed",
    formId: "901",
    entryId: "E-RECONCILED",
    writeIndeterminate: true,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:01.000Z",
  });

  assert.equal(
    registry.hasBlockingScheduleMutationForEntry("901", "E-RECONCILED"),
    false
  );
  assert.equal(registry.getTask("sort-reconciled")?.writeIndeterminate, false);
  assert.equal(
    registry.getTask("sort-reconciled")?.confirmedAt,
    "2026-08-31T00:00:02.000Z"
  );
});
