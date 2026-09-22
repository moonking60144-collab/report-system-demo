import test from "node:test";
import assert from "node:assert/strict";
import { resolveFieldMutationPrecondition } from "../../src/services/work-report/shared/fieldMutationPrecondition";
import { parseSortOrderUpdatePayload } from "../../src/routes/workReportRequest";
import { workReportService } from "../../src/services/workReportService";
import { ragicClient } from "../../src/ragic/client";
import { getFormConfig } from "../../src/config/forms";

test("共用單欄位契約：相同新值免寫、相同舊值可寫、第三值衝突", () => {
  for (const values of [[null, 0, 7], ["MA01", "MA05", "MA09"], [false, true]] as const) {
    for (const current of values) for (const expected of values) for (const intended of values) {
      const input = { current, expected, intended, label: "欄位" };
      if (current === intended) assert.equal(resolveFieldMutationPrecondition(input), "unchanged");
      else if (current === expected) assert.equal(resolveFieldMutationPrecondition(input), "write");
      else assert.throws(() => resolveFieldMutationPrecondition(input), { code: "ENTRY_FIELD_CONFLICT" });
    }
  }
});

test("排序 payload 區分 null 與舊版缺少條件，拒絕無效舊值", () => {
  assert.deepEqual(parseSortOrderUpdatePayload({ sortOrder: 7, expectedSortOrder: null }), { sortOrder: 7, expectedSortOrder: null });
  assert.deepEqual(parseSortOrderUpdatePayload({ sortOrder: 7 }), { sortOrder: 7 });
  for (const expectedSortOrder of ["5", false, -1, 0.5, {}, []]) {
    assert.throws(() => parseSortOrderUpdatePayload({ sortOrder: 7, expectedSortOrder }), { code: "INVALID_PAYLOAD" });
  }
});

for (const formId of ["901", "902"]) {
  for (const scenario of ["third-value", "unrelated-change", "already-applied", "empty", "legacy-stale", "missing", "legacy-current"]) {
    test(`${formId} 排序契約 ${scenario}`, async t => {
      const config = getFormConfig(formId);
      const field = config.writeConfig.mainWriteFields!.sortOrder!;
      const timestamp = config.mainFields.lastUpdatedAt!;
      let current: number | null = scenario === "third-value" ? 9 : scenario === "already-applied" ? 7 : scenario === "empty" ? null : 5;
      const write = t.mock.method(ragicClient, "updateEntry", async () => { current = 7; return {}; });
      t.mock.method(ragicClient, "getEntry", async () => ({ [field]: current, [timestamp]: "2026-09-07T00:01:00Z" }));
      t.mock.method(ragicClient, "clearFormCache", () => {});
      const payload = parseSortOrderUpdatePayload({ sortOrder: 7,
        ...(!scenario.startsWith("legacy") && scenario !== "missing" ? { expectedSortOrder: scenario === "empty" ? null : 5 } : {}) });
      const execute = () => workReportService.updateSortOrder(formId, "E1", payload.sortOrder, {
        expectedSortOrder: payload.expectedSortOrder,
        expectedEntryLastUpdatedAt: scenario === "missing" ? undefined : scenario === "legacy-current" ? "2026-09-07T00:01:00Z" : "2026-09-07T00:00:00Z",
      });
      if (["third-value", "legacy-stale", "missing"].includes(scenario)) {
        await assert.rejects(execute(), { code: "ENTRY_FIELD_CONFLICT" });
        assert.equal(write.mock.callCount(), 0, "conflicting writes must not reach Ragic");
      } else {
        const result = await execute();
        assert.equal(result.sortOrder, 7);
        assert.equal(write.mock.callCount(), scenario === "already-applied" ? 0 : 1);
      }
    });
  }
}
