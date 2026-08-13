import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/clientIdentity", () => ({
  getOrCreateClientId: () => "client-test",
}));

import {
  getRetryableMutationRecord,
  replaceRetryableMutationRecord,
  saveRetryableMutationRecord,
} from "./taskRetryStore";
import {
  applyOptimisticMutation,
  createAcceptedMutationLifecycle,
} from "./mutationLifecycle";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("taskRetryStore create idempotency chain", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps one durable create idempotency key while the task attempt id changes", () => {
    saveRetryableMutationRecord({
      taskId: "task-1",
      retryRootTaskId: "task-1",
      kind: "create",
      formId: "104",
      entryId: "17382",
      payload: {
        date: "2026-07-20",
        machineId: "P10",
        operatorId: "TEST",
        startTime: "08:00",
        endTime: "09:00",
      },
      clientMutationId: "attempt-1",
      createIdempotencyKey: "durable-create-1",
      createdAt: new Date().toISOString(),
    });

    replaceRetryableMutationRecord("task-1", {
      ...getRetryableMutationRecord("task-1")!,
      taskId: "task-2",
      retriedFromTaskId: "task-1",
      clientMutationId: "attempt-2",
      createdAt: new Date().toISOString(),
    });

    expect(getRetryableMutationRecord("task-2")).toMatchObject({
      clientMutationId: "attempt-2",
      createIdempotencyKey: "durable-create-1",
    });
    expect(getRetryableMutationRecord("task-1")?.latestRetryTaskId).toBe("task-2");
  });

  it("新 lifecycle envelope 可持久化，舊 record 不帶 envelope 仍可讀", () => {
    saveRetryableMutationRecord({
      taskId: "task-legacy",
      retryRootTaskId: "task-legacy",
      kind: "create",
      formId: "104",
      entryId: "17382",
      payload: {
        date: "2026-08-12",
        machineId: "P10",
        operatorId: "TEST",
        startTime: "08:00",
        endTime: "09:00",
      },
      clientMutationId: "mutation-legacy",
      createdAt: "2026-08-12T05:59:00.000Z",
    });
    saveRetryableMutationRecord({
      taskId: "task-lifecycle",
      retryRootTaskId: "task-lifecycle",
      kind: "update",
      formId: "105",
      entryId: "17382",
      rowId: "1001",
      payload: {
        date: "2026-08-12",
        machineId: "P10",
        operatorId: "TEST",
        startTime: "08:00",
        endTime: "09:00",
      },
      clientMutationId: "mutation-lifecycle",
      createdAt: "2026-08-12T06:00:00.000Z",
      lifecycle: applyOptimisticMutation(
        createAcceptedMutationLifecycle({
          mutationId: "mutation-lifecycle",
          taskId: "task-lifecycle",
          operation: "work-report-update",
          target: {
            domain: "work-report",
            formId: "105",
            entryId: "17382",
            rowId: "1001",
          },
          acceptedAt: "2026-08-12T06:00:00.000Z",
          reconcilePolicy: "replace-target",
          failurePolicy: "rollback",
          previousSnapshot: { productionQty: 10 },
        })
      ),
    });

    expect(getRetryableMutationRecord("task-lifecycle")?.lifecycle).toMatchObject({
      lifecycleState: "accepted",
      optimisticState: "applied",
      previousSnapshot: { productionQty: 10 },
    });
    expect(getRetryableMutationRecord("task-legacy")?.lifecycle).toBeUndefined();
  });
});
