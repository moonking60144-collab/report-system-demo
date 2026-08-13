import { describe, expect, it } from "vitest";
import {
  applyOptimisticMutation,
  createAcceptedMutationLifecycle,
  normalizeStoredMutationLifecycle,
  reconcileOptimisticMutation,
  resolveTaskMutationLifecycleState,
} from "./mutationLifecycle";

function createLifecycle() {
  return createAcceptedMutationLifecycle({
    mutationId: "mutation-1",
    taskId: "task-1",
    operation: "work-report-update",
    target: {
      domain: "work-report",
      formId: "104",
      entryId: "17382",
      rowId: "1001",
    },
    acceptedAt: "2026-08-12T06:00:00.000Z",
    reconcilePolicy: "replace-target",
    failurePolicy: "rollback",
    previousSnapshot: { productionQty: 10 },
  });
}

describe("optimistic mutation lifecycle", () => {
  it("accepted -> applied -> success 會保留 identity 並標 confirmed", () => {
    const applied = applyOptimisticMutation(createLifecycle());
    const confirmed = reconcileOptimisticMutation(applied, {
      lifecycleState: "success",
      confirmedAt: "2026-08-12T06:00:05.000Z",
    });

    expect(applied.optimisticState).toBe("applied");
    expect(confirmed).toMatchObject({
      mutationId: "mutation-1",
      taskId: "task-1",
      lifecycleState: "success",
      optimisticState: "confirmed",
      confirmedAt: "2026-08-12T06:00:05.000Z",
    });
  });

  it("確定失敗或 conflict 有 previous snapshot 時會 rollback", () => {
    const applied = applyOptimisticMutation(createLifecycle());

    expect(
      reconcileOptimisticMutation(applied, {
        lifecycleState: "failed",
        confirmedAt: "2026-08-12T06:00:05.000Z",
      }).optimisticState
    ).toBe("rolled-back");
    expect(
      reconcileOptimisticMutation(applied, {
        lifecycleState: "conflict",
        confirmedAt: "2026-08-12T06:00:05.000Z",
      }).optimisticState
    ).toBe("rolled-back");
  });

  it("indeterminate 與 polling unknown 會 freeze，不能自動 rollback 或重送", () => {
    const applied = applyOptimisticMutation(createLifecycle());
    const indeterminate = reconcileOptimisticMutation(applied, {
      lifecycleState: "indeterminate",
      confirmedAt: "2026-08-12T06:00:05.000Z",
    });
    const unknown = reconcileOptimisticMutation(applied, {
      lifecycleState: "unknown",
    });

    expect(indeterminate).toMatchObject({
      lifecycleState: "indeterminate",
      optimisticState: "frozen",
      confirmedAt: null,
    });
    expect(unknown).toMatchObject({
      lifecycleState: "unknown",
      optimisticState: "frozen",
      confirmedAt: null,
    });
  });

  it("reload 會保留有效 lifecycle，舊 store 則使用明確 fallback", () => {
    const applied = applyOptimisticMutation(createLifecycle());
    expect(normalizeStoredMutationLifecycle(applied, createLifecycle())).toEqual(applied);

    const fallback = createLifecycle();
    expect(normalizeStoredMutationLifecycle({ taskId: "legacy" }, fallback)).toBe(fallback);
    expect(
      normalizeStoredMutationLifecycle(
        {
          ...applied,
          target: { ...applied.target, domain: "form16-downtime" },
        },
        fallback
      )
    ).toBe(fallback);
    expect(
      normalizeStoredMutationLifecycle(
        {
          ...applied,
          target: { ...applied.target, rowId: 1001 },
        },
        fallback
      )
    ).toBe(fallback);
  });

  it("舊 task shape 仍可推導 conflict 與 indeterminate", () => {
    expect(
      resolveTaskMutationLifecycleState({
        status: "failed",
        errorCode: "ENTRY_CONFLICT",
      })
    ).toBe("conflict");
    expect(
      resolveTaskMutationLifecycleState({
        status: "failed",
        writeIndeterminate: true,
      })
    ).toBe("indeterminate");
  });
});
