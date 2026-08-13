import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/clientIdentity", () => ({
  getOrCreateClientId: () => "client-test",
}));

import {
  bindRetryableSortOrderMutationTask,
  deleteRetryableSortOrderMutationByTaskId,
  getOrCreateRetryableSortOrderMutation,
  getRetryableSortOrderMutationByTaskId,
  listRetryableSortOrderMutations,
  resolveSortOrderTaskRecordPatch,
} from "./sortOrderTaskRetryStore";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("sortOrderTaskRetryStore", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("在 API response 遺失後沿用同一個排序 mutation identity", () => {
    const input = {
      formId: "104" as const,
      entryId: "17382",
      sortOrder: 4,
      previousSortOrder: 2,
      workOrderNo: "WO-25040537",
      expectedEntryLastUpdatedAt: "2026-08-04T00:00:00.000Z",
    };

    const first = getOrCreateRetryableSortOrderMutation(input);
    const retry = getOrCreateRetryableSortOrderMutation(input);

    expect(first.clientMutationId).toBeTruthy();
    expect(retry.clientMutationId).toBe(first.clientMutationId);
  });

  it("排序值變更時建立新 identity，terminal task 後清除該紀錄", () => {
    const first = getOrCreateRetryableSortOrderMutation({
      formId: "104",
      entryId: "17382",
      sortOrder: 4,
      previousSortOrder: 2,
    });
    const changed = getOrCreateRetryableSortOrderMutation({
      formId: "104",
      entryId: "17382",
      sortOrder: 5,
      previousSortOrder: 4,
    });

    expect(changed.clientMutationId).not.toBe(first.clientMutationId);

    bindRetryableSortOrderMutationTask(changed.clientMutationId, "task-2");
    expect(getRetryableSortOrderMutationByTaskId("task-2")).toEqual(
      expect.objectContaining({
        previousSortOrder: 4,
        sortOrder: 5,
      })
    );
    expect(listRetryableSortOrderMutations("104")).toEqual([
      expect.objectContaining({
        clientMutationId: changed.clientMutationId,
        taskId: "task-2",
      }),
    ]);
    deleteRetryableSortOrderMutationByTaskId("task-2");

    const afterTerminal = getOrCreateRetryableSortOrderMutation({
      formId: "104",
      entryId: "17382",
      sortOrder: 5,
      previousSortOrder: 4,
    });
    expect(afterTerminal.clientMutationId).not.toBe(changed.clientMutationId);
  });

  it("terminal success 保留目標排序，failed 則回復送出前排序", () => {
    const record = getOrCreateRetryableSortOrderMutation({
      formId: "105",
      entryId: "E-105",
      sortOrder: 8,
      previousSortOrder: 3,
    });

    expect(resolveSortOrderTaskRecordPatch(record, "success")).toEqual({
      formId: "105",
      entryId: "E-105",
      sortOrder: 8,
    });
    expect(resolveSortOrderTaskRecordPatch(record, "pending")).toBeNull();
    bindRetryableSortOrderMutationTask(
      record.clientMutationId,
      "task-105",
      "2026-08-12T06:00:00.000Z"
    );
    const acceptedRecord = getRetryableSortOrderMutationByTaskId("task-105");
    expect(acceptedRecord?.lifecycle).toMatchObject({
      mutationId: record.clientMutationId,
      taskId: "task-105",
      operation: "work-report-sort-order",
      lifecycleState: "accepted",
      optimisticState: "applied",
      acceptedAt: "2026-08-12T06:00:00.000Z",
      previousSnapshot: 3,
    });
    expect(resolveSortOrderTaskRecordPatch(acceptedRecord, "pending")).toEqual({
      formId: "105",
      entryId: "E-105",
      sortOrder: 8,
    });
    expect(resolveSortOrderTaskRecordPatch(record, "failed")).toEqual({
      formId: "105",
      entryId: "E-105",
      sortOrder: 3,
    });
  });

  it("舊格式沒有回滾值時不恢復 pending optimistic 排序", () => {
    const record = getOrCreateRetryableSortOrderMutation({
      formId: "104",
      entryId: "E-legacy",
      sortOrder: 7,
      previousSortOrder: 2,
    });
    const legacyRecord = {
      ...record,
      taskId: "task-legacy",
    };
    delete legacyRecord.previousSortOrder;

    expect(resolveSortOrderTaskRecordPatch(legacyRecord, "pending")).toBeNull();
    expect(resolveSortOrderTaskRecordPatch(legacyRecord, "failed")).toBeNull();
    expect(resolveSortOrderTaskRecordPatch(legacyRecord, "success")).toEqual({
      formId: "104",
      entryId: "E-legacy",
      sortOrder: 7,
    });
  });
});
