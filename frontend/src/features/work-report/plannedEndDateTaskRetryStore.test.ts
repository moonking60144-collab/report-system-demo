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
} from "./entryFieldTaskRetryStore";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MemoryWindow {
  readonly localStorage = new MemoryStorage();
  private readonly storageListeners = new Set<(event: StorageEvent) => void>();

  addEventListener(type: string, listener: EventListener): void {
    if (type === "storage") {
      this.storageListeners.add(listener as (event: StorageEvent) => void);
    }
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (type === "storage") {
      this.storageListeners.delete(listener as (event: StorageEvent) => void);
    }
  }

  emitStorage(key: string | null): void {
    for (const listener of this.storageListeners) {
      listener({ key, storageArea: this.localStorage } as unknown as StorageEvent);
    }
  }
}

describe("plannedEndDateTaskRetryStore", () => {
  let memoryWindow: MemoryWindow;

  beforeEach(() => {
    memoryWindow = new MemoryWindow();
    vi.stubGlobal("window", memoryWindow);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("相同日期 mutation 沿用 identity，日期改變時換新 identity", () => {
    const input = {
      operation: "work-report-planned-end-date" as const,
      formId: "901" as const,
      entryId: "E-901",
      value: "2026-09-05",
      previousValue: "2026-09-01",
      expectedEntryLastUpdatedAt: "2026-08-28T00:00:00.000Z",
    };
    const first = getOrCreateRetryableEntryFieldMutation(input);
    const retry = getOrCreateRetryableEntryFieldMutation(input);
    const changed = getOrCreateRetryableEntryFieldMutation({
      ...input,
      value: "2026-09-06",
      previousValue: "2026-09-05",
    });

    expect(retry.clientMutationId).toBe(first.clientMutationId);
    expect(changed.clientMutationId).not.toBe(first.clientMutationId);
  });

  it("accepted task 可在 reload 後恢復 optimistic 日期與 rollback 日期", () => {
    const record = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-planned-end-date",
      formId: "902",
      entryId: "E-902",
      value: "2026-09-05",
      previousValue: "2026-09-01",
    });
    expect(record.pendingPatch).toBeNull();
    bindRetryableEntryFieldMutationTask(
      "work-report-planned-end-date",
      record.clientMutationId,
      "task-902",
      "2026-08-28T02:00:00.000Z"
    );
    const accepted = getRetryableEntryFieldMutationByTaskId("task-902");

    expect(accepted).toMatchObject({
      operation: "work-report-planned-end-date",
      pendingPatch: { plannedEndDate: "2026-09-05" },
      rollbackPatch: { plannedEndDate: "2026-09-01" },
      lifecycle: {
        lifecycleState: "accepted",
        optimisticState: "applied",
        previousSnapshot: { plannedEndDate: "2026-09-01" },
      },
    });
    deleteRetryableEntryFieldMutationByTaskId("task-902");
    expect(listRetryableEntryFieldMutations("902")).toEqual([]);
  });

  it("共用 registry 會合併排序與日期 mutation，並按 task id 一致清理", () => {
    const startSchedule = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-start-schedule",
      formId: "901",
      entryId: "E-START",
      value: true,
      previousValue: false,
    });
    bindRetryableEntryFieldMutationTask(
      startSchedule.operation,
      startSchedule.clientMutationId,
      "task-start"
    );
    const machine = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-main-machine",
      formId: "902",
      entryId: "E-MACHINE",
      value: "MA51",
      previousValue: "MB50",
    });
    bindRetryableEntryFieldMutationTask(
      machine.operation,
      machine.clientMutationId,
      "task-machine"
    );
    const sortOrder = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-sort-order",
      formId: "901",
      entryId: "E-SORT",
      value: 3,
      previousValue: 2,
    });
    bindRetryableEntryFieldMutationTask(
      "work-report-sort-order",
      sortOrder.clientMutationId,
      "task-sort"
    );
    const plannedEndDate = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-planned-end-date",
      formId: "901",
      entryId: "E-DATE",
      value: "2026-09-05",
      previousValue: "2026-09-01",
    });
    bindRetryableEntryFieldMutationTask(
      "work-report-planned-end-date",
      plannedEndDate.clientMutationId,
      "task-date"
    );
    const urgent = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-urgent",
      formId: "901",
      entryId: "E-URGENT",
      value: true,
      previousValue: false,
    });
    bindRetryableEntryFieldMutationTask(
      urgent.operation,
      urgent.clientMutationId,
      "task-urgent"
    );

    expect(listRetryableEntryFieldMutations("901").map((item) => item.operation)).toEqual([
      "work-report-start-schedule",
      "work-report-sort-order",
      "work-report-planned-end-date",
      "work-report-urgent",
    ]);
    expect(getRetryableEntryFieldMutationByTaskId("task-start")).toMatchObject({
      successPatch: { startSchedule: "Yes" },
      rollbackPatch: { startSchedule: "No" },
    });
    expect(getRetryableEntryFieldMutationByTaskId("task-machine")).toMatchObject({
      successPatch: { filterMachineCode: "MA51" },
      rollbackPatch: { filterMachineCode: "MB50" },
    });
    expect(getRetryableEntryFieldMutationByTaskId("task-urgent")).toMatchObject({
      successPatch: { urgent: "Yes" },
      rollbackPatch: { urgent: "No" },
    });
    deleteRetryableEntryFieldMutationByTaskId("task-date");
    expect(listRetryableEntryFieldMutations("901").map((item) => item.operation)).toEqual([
      "work-report-start-schedule",
      "work-report-sort-order",
      "work-report-urgent",
    ]);
  });

  it("terminal settlement 刪除 retry record 時立即發布新 revision", () => {
    const publishedRevisions: number[] = [];
    const unsubscribe = subscribeEntryFieldTaskRetryStore(() => {
      publishedRevisions.push(getEntryFieldTaskRetryStoreRevision());
    });

    try {
      const urgent = getOrCreateRetryableEntryFieldMutation({
        operation: "work-report-urgent",
        formId: "901",
        entryId: "E-URGENT-SETTLED",
        value: true,
        previousValue: false,
      });
      bindRetryableEntryFieldMutationTask(
        urgent.operation,
        urgent.clientMutationId,
        "task-urgent-settled"
      );
      const pendingRevision = getEntryFieldTaskRetryStoreRevision();

      deleteRetryableEntryFieldMutationByTaskId("task-urgent-settled");

      expect(getEntryFieldTaskRetryStoreRevision()).toBeGreaterThan(pendingRevision);
      expect(publishedRevisions.at(-1)).toBe(getEntryFieldTaskRetryStoreRevision());
      expect(listRetryableEntryFieldMutations("901")).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("另一個 tab 更新 entry-field retry store 時也發布新 revision", () => {
    const publishedRevisions: number[] = [];
    const unsubscribe = subscribeEntryFieldTaskRetryStore(() => {
      publishedRevisions.push(getEntryFieldTaskRetryStoreRevision());
    });

    try {
      const before = getEntryFieldTaskRetryStoreRevision();
      memoryWindow.emitStorage("work-report:urgent-retry-store:v1");
      const afterEntryFieldChange = getEntryFieldTaskRetryStoreRevision();
      memoryWindow.emitStorage("unrelated:key");

      expect(afterEntryFieldChange).toBeGreaterThan(before);
      expect(getEntryFieldTaskRetryStoreRevision()).toBe(afterEntryFieldChange);
      expect(publishedRevisions).toEqual([afterEntryFieldChange]);
    } finally {
      unsubscribe();
    }
  });
});
