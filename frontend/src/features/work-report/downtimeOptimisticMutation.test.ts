import { afterEach, describe, expect, it, vi } from "vitest";
import type { Form16DowntimeRecord } from "../../api/downtime";
import {
  applyDowntimeOptimisticMutations,
  createDowntimeOptimisticMutation,
  pruneProjectedDowntimeMutations,
  readDowntimeOptimisticObservations,
  reconcileDowntimeOptimisticMutation,
  writeDowntimeOptimisticObservations,
} from "./downtimeOptimisticMutation";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

function record(id = "1001"): Form16DowntimeRecord {
  return {
    id,
    snapshotHash: "hash-1",
    date: "2026/08/12",
    machineId: "W23",
    processCode: "TI01",
    operatorId: "A001",
    operatorName: "測試員",
    reportType: "TI搓牙",
    startTime: "08:00",
    endTime: "17:00",
    breakTime: "1.00",
    plannedIdleMinutes: 480,
    remark: "before",
    workOrderNo: null,
  };
}

function observation(patch: Parameters<typeof createDowntimeOptimisticMutation>[0]["patch"]) {
  const mutation = createDowntimeOptimisticMutation({
    mutationId: "mutation-1",
    taskId: "task-1",
    acceptedAt: "2026-08-12T08:00:00.000Z",
    patch,
    previousSnapshot: patch.kind === "create" ? null : record(),
  });
  return { taskId: "task-1", optimisticMutation: mutation };
}

describe("downtimeOptimisticMutation", () => {
  it("create accepted 立即顯示 temporary record，success 後等待 authoritative projection", () => {
    const pending = record("__optimistic__:client-1");
    const accepted = observation({ kind: "create", record: pending });
    expect(applyDowntimeOptimisticMutations([], [accepted])[0].id).toBe(pending.id);

    const confirmed = {
      ...accepted,
      entryId: "2001",
      optimisticMutation: reconcileDowntimeOptimisticMutation(
        accepted.optimisticMutation,
        { lifecycleState: "success" }
      ),
    };
    expect(applyDowntimeOptimisticMutations([], [confirmed])[0].id).toBe("2001");
    expect(pruneProjectedDowntimeMutations([], [confirmed])).toHaveLength(1);
    expect(pruneProjectedDowntimeMutations([record("2001")], [confirmed])).toHaveLength(0);
  });

  it("update accepted 立即覆蓋，conflict 後回滾 authoritative record", () => {
    const updated = { ...record(), remark: "after" };
    const accepted = observation({ kind: "update", record: updated });
    expect(applyDowntimeOptimisticMutations([record()], [accepted])[0].remark).toBe("after");

    const rolledBack = {
      ...accepted,
      optimisticMutation: reconcileDowntimeOptimisticMutation(
        accepted.optimisticMutation,
        { lifecycleState: "conflict" }
      ),
    };
    expect(applyDowntimeOptimisticMutations([record()], [rolledBack])[0].remark).toBe("before");
  });

  it("delete indeterminate 維持隱藏，確定失敗後恢復", () => {
    const accepted = observation({ kind: "delete", entryId: "1001" });
    const frozen = {
      ...accepted,
      optimisticMutation: reconcileDowntimeOptimisticMutation(
        accepted.optimisticMutation,
        { lifecycleState: "indeterminate" }
      ),
    };
    expect(applyDowntimeOptimisticMutations([record()], [frozen])).toEqual([]);

    const rolledBack = {
      ...accepted,
      optimisticMutation: reconcileDowntimeOptimisticMutation(
        accepted.optimisticMutation,
        { lifecycleState: "failed" }
      ),
    };
    expect(applyDowntimeOptimisticMutations([record()], [rolledBack])).toHaveLength(1);
  });

  it("非第一頁可排除 optimistic create，但仍套用 update/delete", () => {
    const created = observation({ kind: "create", record: record("temp") });
    const deleted = observation({ kind: "delete", entryId: "1001" });
    expect(
      applyDowntimeOptimisticMutations([record()], [created, deleted], {
        includeCreates: false,
      })
    ).toEqual([]);
  });

  it("accepted overlay 在 polling 前可同步持久化，reload 後用同一 task identity 還原", () => {
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
    const accepted = observation({ kind: "update", record: { ...record(), remark: "after" } });

    writeDowntimeOptimisticObservations([accepted]);
    const restored = readDowntimeOptimisticObservations();

    expect(restored).toHaveLength(1);
    expect(restored[0].taskId).toBe("task-1");
    expect(restored[0].optimisticMutation.lifecycle.optimisticState).toBe("applied");
    expect(applyDowntimeOptimisticMutations([record()], restored)[0].remark).toBe("after");
  });
});
