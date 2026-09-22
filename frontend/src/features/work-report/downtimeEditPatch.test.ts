import { describe, expect, it } from "vitest";
import type { ActivityLogDowntimeRecord } from "../../api/downtime";
import { buildDowntimeEditPatch } from "./downtimeEditPatch";
import { applyDowntimeOptimisticMutations, createDowntimeOptimisticMutation, pruneProjectedDowntimeMutations, reconcileDowntimeOptimisticMutation } from "./downtimeOptimisticMutation";

const original: ActivityLogDowntimeRecord = {
  id: "1", snapshotHash: "old", date: "2026/09/16", machineId: "MB50", processCode: "A01",
  operatorId: null, operatorName: null, reportType: "PROC-A", startTime: null, endTime: null,
  breakTime: null, plannedIdleMinutes: null, remark: "before", workOrderNo: null,
};
const draft = { date: "2026-09-16", machineId: "MB50", processCode: "A01", operatorId: "", plannedIdleMinutes: "", remark: "after" };

describe("ActivityLog 編輯原值與局部樂觀更新", () => {
  it("只送異動欄位，日期表示法及空值不製造額外 patch", () => {
    expect(buildDowntimeEditPatch(original, draft)).toEqual({ remark: "after", fieldPreconditionVersion: 1, expectedValues: { remark: "before" } });
    expect(buildDowntimeEditPatch(original, { ...draft, plannedIdleMinutes: "0", remark: "before" })).toEqual({ plannedIdleMinutes: 0, fieldPreconditionVersion: 1, expectedValues: { plannedIdleMinutes: null } });
  });
  it("背景改機台不會被備註 overlay 蓋回舊值，確認後能完成移除", () => {
    const payload = buildDowntimeEditPatch(original, draft);
    const pending = createDowntimeOptimisticMutation({
      mutationId: "m1", taskId: "t1", acceptedAt: new Date().toISOString(), previousSnapshot: original,
      patch: { kind: "update", record: { ...original, remark: payload.remark! }, changedFields: ["remark"] },
    });
    const latest = { ...original, machineId: "MA51", snapshotHash: "new" };
    expect(applyDowntimeOptimisticMutations([latest], [{ taskId: "t1", optimisticMutation: pending }])[0], "ACTIVITY_LOG_OVERLAY_PRESERVES_UNRELATED").toMatchObject({ machineId: "MA51", remark: "after", snapshotHash: "new" });
    const confirmed = reconcileDowntimeOptimisticMutation(pending, { lifecycleState: "success" });
    expect(pruneProjectedDowntimeMutations([{ ...latest, remark: "after" }], [{ taskId: "t1", optimisticMutation: confirmed }])).toEqual([]);
    expect(buildDowntimeEditPatch(original, draft).expectedValues).toEqual({ remark: "before" });
  });
});
