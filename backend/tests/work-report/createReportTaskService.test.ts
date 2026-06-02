import test from "node:test";
import assert from "node:assert/strict";
import { createReportTaskService } from "../../src/services/createReportTaskService";

test("相同 clientMutationId 不會重複 enqueue 任務", async () => {
  let callCount = 0;

  const firstTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-100",
    queueKey: "104:E-100",
    clientMutationId: "mutation-dup-001",
    worker: async () => {
      callCount += 1;
      return { rowId: "R-1" };
    },
  });

  const secondTask = createReportTaskService.enqueue({
    formId: "104",
    entryId: "E-100",
    queueKey: "104:E-100",
    clientMutationId: "mutation-dup-001",
    worker: async () => {
      callCount += 1;
      return { rowId: "R-2" };
    },
  });

  assert.equal(firstTask.taskId, secondTask.taskId);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(callCount, 1);
});
