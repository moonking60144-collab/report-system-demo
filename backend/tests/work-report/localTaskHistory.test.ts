import test from "node:test";
import assert from "node:assert/strict";
import {
  pruneTerminalTaskHistory,
  type LocalTaskHistoryItem,
} from "../../src/services/work-report/localTaskHistory";

function task(
  taskId: string,
  status: LocalTaskHistoryItem["status"],
  timestamp: string
): LocalTaskHistoryItem {
  return {
    taskId,
    status,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(status === "success" || status === "failed" ? { finishedAt: timestamp } : {}),
  };
}

test("pruneTerminalTaskHistory 只淘汰最舊終態任務，保留進行中任務", () => {
  const tasks = new Map<string, LocalTaskHistoryItem>([
    ["old-success", task("old-success", "success", "2026-07-02T00:00:00.000Z")],
    ["running", task("running", "running", "2026-07-02T00:01:00.000Z")],
    ["new-failed", task("new-failed", "failed", "2026-07-02T00:02:00.000Z")],
  ]);

  const deletedCount = pruneTerminalTaskHistory(tasks, 1);

  assert.equal(deletedCount, 1);
  assert.equal(tasks.has("old-success"), false);
  assert.equal(tasks.has("running"), true);
  assert.equal(tasks.has("new-failed"), true);
});
