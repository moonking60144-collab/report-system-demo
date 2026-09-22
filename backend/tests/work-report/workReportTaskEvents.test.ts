import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "../../src/config/env";
import { realtimeEventBus } from "../../src/events/realtimeEventBus";
import { WorkReportTaskRegistryService } from "../../src/services/work-report/workReportTaskRegistryService";

const mutableEnv = env as unknown as { WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: boolean; WORK_REPORT_TASK_REGISTRY_STORE_FILE: string };

test("task SSE follows persisted state; timing updates do not generate event storms", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "task-events-"));
  const previous = { enabled: mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED, file: mutableEnv.WORK_REPORT_TASK_REGISTRY_STORE_FILE };
  mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = true;
  mutableEnv.WORK_REPORT_TASK_REGISTRY_STORE_FILE = path.join(directory, "tasks.json");
  const registry = new WorkReportTaskRegistryService();
  const observed: string[] = [];
  const unsubscribe = realtimeEventBus.subscribe((event) => {
    if (event.type !== "work-report-task-updated" || event.workReportTask?.taskId !== "event-task") return;
    const snapshot = JSON.parse(readFileSync(mutableEnv.WORK_REPORT_TASK_REGISTRY_STORE_FILE, "utf8"));
    observed.push(`${event.workReportTask.status}:${snapshot.tasks.find((task: { taskId: string }) => task.taskId === "event-task").status}:${registry.getTask("event-task")?.status}`);
  });
  try {
    registry.upsertTask({ taskId: "event-task", taskType: "update-report", formId: "901", status: "running" });
    assert.deepEqual(observed, []);
    await registry.flush();
    assert.deepEqual(observed, ["running:running:running"]);
    for (let index = 0; index < 20; index++) {
      registry.upsertTask({ taskId: "event-task", taskType: "update-report", formId: "901", status: "running", updatedAt: new Date().toISOString() });
    }
    await registry.flush();
    assert.equal(observed.length, 1);
    registry.upsertTask({ taskId: "event-task", taskType: "update-report", formId: "901", status: "success" });
    assert.equal(observed.length, 1);
    await registry.flush();
    assert.deepEqual(observed, ["running:running:running", "success:success:success"]);
  } finally {
    await registry.flush(); unsubscribe();
    mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = previous.enabled;
    mutableEnv.WORK_REPORT_TASK_REGISTRY_STORE_FILE = previous.file;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("failed persistence does not publish completion; a later successful save releases the hint", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "task-events-failure-"));
  const previous = { enabled: mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED, file: mutableEnv.WORK_REPORT_TASK_REGISTRY_STORE_FILE };
  mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = true;
  const blocked = path.join(directory, "file");
  await fs.writeFile(blocked, "not a directory");
  mutableEnv.WORK_REPORT_TASK_REGISTRY_STORE_FILE = path.join(blocked, "tasks.json");
  const registry = new WorkReportTaskRegistryService();
  const observed: string[] = [];
  const unsubscribe = realtimeEventBus.subscribe((event) => {
    if (event.workReportTask?.taskId === "failed-save-task") observed.push(event.workReportTask.status);
  });
  try {
    const task = { taskId: "failed-save-task", taskType: "create-downtime" as const, formId: "903", status: "success" as const };
    registry.upsertTask(task);
    await registry.flush();
    assert.deepEqual(observed, []);
    mutableEnv.WORK_REPORT_TASK_REGISTRY_STORE_FILE = path.join(directory, "tasks.json");
    await registry.flush();
    assert.deepEqual(observed, ["success"]);
  } finally {
    await registry.flush(); unsubscribe();
    mutableEnv.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED = previous.enabled;
    mutableEnv.WORK_REPORT_TASK_REGISTRY_STORE_FILE = previous.file;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
