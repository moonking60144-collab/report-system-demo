import assert from "node:assert/strict";
import test from "node:test";
import { parseActivityLogFieldPrecondition, resolveActivityLogFieldPatch } from "../../../src/services/activityLog/activityLogFieldPrecondition";
import type { ActivityLogDowntimeRecord } from "../../../src/types/activityLogDowntime";

test("ActivityLog null、零、日期格式與缺少原值有不同語意", () => {
  const current = { date: "2026/09/16", plannedIdleMinutes: null, remark: null } as ActivityLogDowntimeRecord;
  assert.deepEqual(resolveActivityLogFieldPatch(current, { date: "2026-09-17", plannedIdleMinutes: 0, remark: "next" }, {
    date: "2026-09-16", plannedIdleMinutes: null, remark: "",
  }), { date: "2026-09-17", plannedIdleMinutes: 0, remark: "next" });
  assert.throws(() => resolveActivityLogFieldPatch({ ...current, plannedIdleMinutes: 10 }, { plannedIdleMinutes: 0 }, { plannedIdleMinutes: null }));
  for (const expectedValues of [{}, { remark: undefined }, { remark: false }, { remark: null, machineId: "MB50" }]) {
    assert.throws(() => parseActivityLogFieldPrecondition({ fieldPreconditionVersion: 1, expectedValues }, { remark: "next" }));
  }
  assert.deepEqual(parseActivityLogFieldPrecondition({ fieldPreconditionVersion: 1, expectedValues: { remark: null } }, { remark: "next" }), { remark: null });
});
