import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateRetryableEntryFieldMutation, listRetryableEntryFieldMutations } from "./entryFieldTaskRetryStore";
import { saveRetryableMutationRecord, getRetryableMutationRecord } from "./taskRetryStore";
vi.mock("../../utils/clientIdentity", () => ({ getOrCreateClientId: () => "test-client" }));
let values: Map<string, string>;
beforeEach(() => { values = new Map(); vi.stubGlobal("window", { localStorage: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
} }); });
afterEach(() => vi.unstubAllGlobals());
describe("欄位與明細原值持久化", () => {
  it.each([
    { operation: "work-report-planned-end-date" as const, value: "2026-09-17", previousValue: null },
    { operation: "work-report-main-machine" as const, value: "MA51", previousValue: "MB50" },
    { operation: "work-report-urgent" as const, value: true, previousValue: false },
    { operation: "work-report-start-schedule" as const, value: true, previousValue: false },
  ])("$operation 重播保留原值、版本與 identity", input => {
    const first = getOrCreateRetryableEntryFieldMutation({ ...input, formId: "901", entryId: "1", expectedEntryLastUpdatedAt: "old" });
    expect(first.fieldPreconditionVersion).toBe(1);
    expect(first.clientMutationId.startsWith("entry-field-v1:")).toBe(true);
    // 模擬舊分頁 serializer 遺失新 metadata；immutable identity 必須保住原契約。
    for (const [key, text] of values) {
      const saved = JSON.parse(text);
      for (const record of Object.values(saved) as Array<Record<string, unknown>>) delete record.fieldPreconditionVersion;
      values.set(key, JSON.stringify(saved));
    }
    const restored = listRetryableEntryFieldMutations("901")[0];
    expect(restored.previousValue).toBe(input.previousValue);
    expect(restored.fieldPreconditionVersion).toBe(1);
    const retry = getOrCreateRetryableEntryFieldMutation({ ...input, formId: "901", entryId: "1", expectedEntryLastUpdatedAt: "old" });
    expect(retry.clientMutationId).toBe(first.clientMutationId);
    expect(retry.previousValue).toBe(input.previousValue);
  });
  it("明細 retry payload 保留原始 hash", () => {
    const payload = { date: "2026-09-16", operatorId: "A001", machineId: "MB50", startTime: "08:00", endTime: "09:00", expectedRowSnapshotHash: "a".repeat(64) };
    saveRetryableMutationRecord({ taskId: "t1", retryRootTaskId: "t1", kind: "update", formId: "901", entryId: "1", rowId: "42", clientMutationId: "m1", payload, createdAt: new Date().toISOString() });
    expect(getRetryableMutationRecord("t1")?.payload.expectedRowSnapshotHash).toBe("a".repeat(64));
  });
});
