import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/clientIdentity", () => ({
  getOrCreateClientId: () => "client-test",
}));

import {
  bindRetryableEntryFieldMutationTask,
  deleteRetryableEntryFieldMutationByTaskId,
  getEntryFieldTaskRetryStoreRevision,
  getOrCreateRetryableEntryFieldMutation,
  getRetryableEntryFieldMutationByTaskId,
  listRetryableEntryFieldMutations,
  subscribeEntryFieldTaskRetryStore,
  updateRetryableEntryFieldMutationLifecycleByTaskId,
} from "./entryFieldTaskRetryStore";
import { settleTerminalEntryFieldTask } from "./hooks/useTaskMonitor";
import { createWorkReportOptimisticMutation } from "./workReportOptimisticMutation";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  failNextSet = false;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("transient storage failure");
    }
    this.values.set(key, value);
  }
}

describe("sortOrderTaskRetryStore", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("在 API response 遺失後沿用同一個排序 mutation identity", () => {
    const input = {
      operation: "work-report-sort-order" as const,
      formId: "901" as const,
      entryId: "90002",
      value: 4,
      previousValue: 2,
      workOrderNo: "DEMO-040537",
      expectedEntryLastUpdatedAt: "2026-08-04T00:00:00.000Z",
    };

    const first = getOrCreateRetryableEntryFieldMutation(input);
    const retry = getOrCreateRetryableEntryFieldMutation(input);

    expect(first.clientMutationId).toBeTruthy();
    expect(retry.clientMutationId).toBe(first.clientMutationId);
    expect(retry.fieldPreconditionVersion).toBe(1);
    expect(retry.previousValue).toBe(2);
  });

  it("legacy intent 保留原 wire contract，不能替同一 mutation id 加新前提", () => {
    const key = "work-report:sort-order-retry-store:v1";
    const input = { operation: "work-report-sort-order" as const, formId: "901" as const,
      entryId: "90002", value: 4, previousValue: 2, expectedEntryLastUpdatedAt: "v1" };
    const first = getOrCreateRetryableEntryFieldMutation(input);
    const stored = JSON.parse(storage.getItem(key)!);
    const legacyId = "legacy-sort-id";
    stored[legacyId] = { ...stored[first.clientMutationId], clientMutationId: legacyId };
    delete stored[first.clientMutationId];
    delete stored[legacyId].fieldPreconditionVersion;
    storage.setItem(key, JSON.stringify(stored));
    const retry = getOrCreateRetryableEntryFieldMutation(input);
    expect(retry.clientMutationId).toBe(legacyId);
    expect(retry.hasPreviousValue).toBe(true);
    expect(retry.fieldPreconditionVersion).toBeUndefined();
  });

  it("舊分頁 serializer 抹除新欄位後仍由 immutable identity 保留新契約", () => {
    const key = "work-report:sort-order-retry-store:v1";
    const input = { operation: "work-report-sort-order" as const, formId: "901" as const,
      entryId: "90002", value: 4, previousValue: 2 };
    const first = getOrCreateRetryableEntryFieldMutation(input);
    const stored = JSON.parse(storage.getItem(key)!);
    delete stored[first.clientMutationId].fieldPreconditionVersion;
    storage.setItem(key, JSON.stringify(stored));
    const retry = getOrCreateRetryableEntryFieldMutation(input);
    expect(retry.clientMutationId).toBe(first.clientMutationId);
    expect(retry.fieldPreconditionVersion).toBe(1);
  });

  it("排序值變更時建立新 identity，terminal task 後清除該紀錄", () => {
    const first = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-sort-order",
      formId: "901",
      entryId: "90002",
      value: 4,
      previousValue: 2,
    });
    const changed = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-sort-order",
      formId: "901",
      entryId: "90002",
      value: 5,
      previousValue: 4,
    });

    expect(changed.clientMutationId).not.toBe(first.clientMutationId);
    bindRetryableEntryFieldMutationTask(
      "work-report-sort-order",
      changed.clientMutationId,
      "task-2"
    );
    expect(getRetryableEntryFieldMutationByTaskId("task-2")).toMatchObject({
      previousValue: 4,
      value: 5,
      successPatch: { sortOrder: 5 },
      rollbackPatch: { sortOrder: 4 },
    });
    deleteRetryableEntryFieldMutationByTaskId("task-2");

    const afterTerminal = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-sort-order",
      formId: "901",
      entryId: "90002",
      value: 5,
      previousValue: 4,
    });
    expect(afterTerminal.clientMutationId).not.toBe(changed.clientMutationId);
  });

  it("equal-token superseded evidence 不得被同值重送沿用", () => {
    const first = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-sort-order",
      formId: "901",
      entryId: "E-901",
      value: 11,
      previousValue: 9,
      expectedEntryLastUpdatedAt: "2026/09/02 10:00:00",
    });
    bindRetryableEntryFieldMutationTask(
      first.operation,
      first.clientMutationId,
      "task-superseded"
    );
    const accepted = getRetryableEntryFieldMutationByTaskId("task-superseded");
    expect(accepted?.lifecycle).toBeDefined();
    updateRetryableEntryFieldMutationLifecycleByTaskId(
      "task-superseded",
      {
        ...accepted!.lifecycle!,
        lifecycleState: "conflict",
        optimisticState: "rolled-back",
        confirmedAt: "2026-09-02T02:00:01.000Z",
      },
      "superseded"
    );

    const resubmitted = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-sort-order",
      formId: "901",
      entryId: "E-901",
      value: 11,
      previousValue: 12,
      expectedEntryLastUpdatedAt: "2026/09/02 10:00:00",
    });

    expect(resubmitted.clientMutationId).not.toBe(first.clientMutationId);
    expect(resubmitted).toMatchObject({
      previousValue: 12,
      rollbackPatch: { sortOrder: 12 },
    });
    expect(resubmitted.taskId).toBeUndefined();
    expect(resubmitted.settlementOutcome).toBeUndefined();
    expect(getRetryableEntryFieldMutationByTaskId("task-superseded")).toBeNull();
  });

  it("unknown attempt 仍沿用原 identity，避免盲目建立第二次寫入", () => {
    const input = {
      operation: "work-report-sort-order" as const,
      formId: "901" as const,
      entryId: "E-unknown",
      value: 8,
      previousValue: 7,
      expectedEntryLastUpdatedAt: "2026/09/02 10:03:00",
    };
    const first = getOrCreateRetryableEntryFieldMutation(input);
    bindRetryableEntryFieldMutationTask(
      first.operation,
      first.clientMutationId,
      "task-unknown"
    );
    const accepted = getRetryableEntryFieldMutationByTaskId("task-unknown");
    updateRetryableEntryFieldMutationLifecycleByTaskId("task-unknown", {
      ...accepted!.lifecycle!,
      lifecycleState: "unknown",
      optimisticState: "frozen",
    });

    expect(getOrCreateRetryableEntryFieldMutation(input).clientMutationId).toBe(
      first.clientMutationId
    );
  });

  it("初始 durable intent 無法寫入時 fail closed", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
    });

    expect(() =>
      getOrCreateRetryableEntryFieldMutation({
        operation: "work-report-sort-order",
        formId: "901",
        entryId: "E-storage-failed",
        value: 7,
        previousValue: 6,
        expectedEntryLastUpdatedAt: "2026/09/02 10:05:00",
      })
    ).toThrow("無法保存工令欄位更新的安全重試資料");
  });

  it("其他分頁的 retry store 變更會通知目前頁面的 monitor owner", () => {
    let storageListener: ((event: StorageEvent) => void) | null = null;
    const addEventListener = vi.fn(
      (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageListener = listener;
      }
    );
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener,
      removeEventListener,
    });
    const listener = vi.fn();
    const revisionBefore = getEntryFieldTaskRetryStoreRevision();
    const unsubscribe = subscribeEntryFieldTaskRetryStore(listener);

    expect(addEventListener).toHaveBeenCalledWith("storage", expect.any(Function));
    expect(storageListener).not.toBeNull();
    storageListener!({
      key: "work-report:sort-order-retry-store:v1",
      storageArea: storage,
    } as unknown as StorageEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getEntryFieldTaskRetryStoreRevision()).toBe(revisionBefore + 1);
    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith(
      "storage",
      expect.any(Function)
    );
  });

  it("API accepted 後 bind 寫入失敗仍由 terminal settlement 退休原 identity", async () => {
    const input = {
      operation: "work-report-sort-order" as const,
      formId: "901" as const,
      entryId: "E-bind-loss",
      value: 11,
      previousValue: 9,
      expectedEntryLastUpdatedAt: "2026/09/02 10:20:00",
    };
    const first = getOrCreateRetryableEntryFieldMutation(input);
    storage.failNextSet = true;

    expect(
      bindRetryableEntryFieldMutationTask(
        first.operation,
        first.clientMutationId,
        "task-bind-loss"
      )
    ).toBe(false);
    expect(getRetryableEntryFieldMutationByTaskId("task-bind-loss")).toBeNull();

    const settlement = await settleTerminalEntryFieldTask({
      monitor: {
        taskId: "task-bind-loss",
        kind: "update",
        formId: "901",
        entryId: "E-bind-loss",
        workOrderNo: "WO-bind-loss",
        status: "success",
        lifecycleState: "success",
        entryFieldOperation: first.operation,
        entryFieldClientMutationId: first.clientMutationId,
        optimisticMutation: createWorkReportOptimisticMutation({
          taskId: "task-bind-loss",
          mutationId: first.clientMutationId,
          operation: first.operation,
          target: {
            domain: "work-report",
            formId: "901",
            entryId: "E-bind-loss",
          },
          acceptedAt: "2026-09-02T02:20:00.000Z",
          reconcilePolicy: "replace-target",
          failurePolicy: "rollback",
          previousSnapshot: { sortOrder: 9 },
          patch: {
            kind: "update-entry",
            patch: { sortOrder: 11 },
          },
        }),
        message: "updated",
        updatedAt: "2026-09-02T02:20:01.000Z",
      },
      getRetryMutation: () => null,
      fetchEntry: vi.fn().mockResolvedValue({
        id: "E-bind-loss",
        workOrderNo: "WO-bind-loss",
        status: "未結案",
        customerPartNo: null,
        erpPartNo: null,
        sortOrder: 12,
        lastUpdatedAt: input.expectedEntryLastUpdatedAt,
      }),
      upsertMonitor: vi.fn(),
      successMessage: "updated",
      supersededMessage: "superseded",
    });

    expect(settlement?.monitor).toMatchObject({
      status: "failed",
      lifecycleState: "conflict",
      entryFieldSettlementOutcome: "superseded",
    });
    expect(listRetryableEntryFieldMutations("901")).toMatchObject([
      {
        clientMutationId: first.clientMutationId,
        settlementOutcome: "superseded",
        lifecycle: {
          lifecycleState: "conflict",
          optimisticState: "rolled-back",
        },
      },
    ]);

    const resubmitted = getOrCreateRetryableEntryFieldMutation({
      ...input,
      previousValue: 12,
    });
    expect(resubmitted.clientMutationId).not.toBe(first.clientMutationId);
    expect(resubmitted.previousValue).toBe(12);
  });

  it("accepted task 可恢復 optimistic 排序，舊格式無回滾值則不恢復", () => {
    const record = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-sort-order",
      formId: "902",
      entryId: "E-902",
      value: 8,
      previousValue: 3,
    });
    expect(record.pendingPatch).toBeNull();
    bindRetryableEntryFieldMutationTask(
      "work-report-sort-order",
      record.clientMutationId,
      "task-902",
      "2026-08-12T06:00:00.000Z"
    );
    expect(getRetryableEntryFieldMutationByTaskId("task-902")).toMatchObject({
      pendingPatch: { sortOrder: 8 },
      rollbackPatch: { sortOrder: 3 },
      lifecycle: {
        operation: "work-report-sort-order",
        optimisticState: "applied",
        previousSnapshot: { sortOrder: 3 },
      },
    });
    const accepted = getRetryableEntryFieldMutationByTaskId("task-902");
    expect(accepted?.lifecycle).toBeDefined();
    updateRetryableEntryFieldMutationLifecycleByTaskId("task-902", {
      ...accepted!.lifecycle!,
      lifecycleState: "indeterminate",
      optimisticState: "frozen",
      confirmedAt: null,
    });
    expect(getRetryableEntryFieldMutationByTaskId("task-902")?.lifecycle).toMatchObject({
      lifecycleState: "indeterminate",
      optimisticState: "frozen",
      previousSnapshot: { sortOrder: 3 },
    });

    storage.setItem(
      "work-report:sort-order-retry-store:v1",
      JSON.stringify({
        legacy: {
          clientMutationId: "legacy",
          taskId: "task-legacy",
          formId: "901",
          entryId: "E-legacy",
          sortOrder: 7,
          actorClientId: "client-test",
          createdAt: new Date().toISOString(),
        },
      })
    );
    expect(listRetryableEntryFieldMutations("901")[0]).toMatchObject({
      pendingPatch: null,
      rollbackPatch: null,
      successPatch: { sortOrder: 7 },
    });
  });
});
