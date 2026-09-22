import assert from "node:assert/strict";
import test from "node:test";
import { getFormConfig } from "../../src/config/forms";
import { ragicClient, type RagicRecord } from "../../src/ragic/client";
import { workReportService } from "../../src/services/workReportService";
import { workReportRowMutationService } from "../../src/services/work-report/mutation/workReportRowMutationService";
import { workReportReadService } from "../../src/services/work-report/workReportReadService";
import { workReportMutationPreconditionService } from "../../src/services/work-report/mutation/workReportMutationPreconditionService";
import { mapSubtable } from "../../src/services/work-report/queries/rowTransform";
import { buildRowSnapshotHash } from "../../src/services/work-report/shared/rowMutationPrecondition";
import { HttpError } from "../../src/utils/httpError";

// 原值由編輯開始時取得；無關資料變動可通過，同一目標變動及結案必須在寫入前被攔截。
for (const formId of ["901", "902"]) {
  for (const kind of ["date", "machine", "urgent", ...(formId === "901" ? ["schedule"] : [])]) {
    test(`${formId} ${kind} 原值相同時忽略其他欄位更新，已達目標時不重寫`, async (t) => {
      const config = getFormConfig(formId);
      const key = kind === "date" ? "plannedEndDate" : kind === "machine" ? "machineCode" : kind === "urgent" ? "urgent" : "startSchedule";
      const fieldId = config.writeConfig.mainWriteFields![key];
      let current = kind === "date" ? "2026/09/01" : kind === "machine" ? "料號@MA18" : "No";
      t.mock.method(ragicClient, "getEntry", async () => ({ [fieldId]: current, "9001202": "new", [config.mainFields.status]: "未結案" }));
      const write = t.mock.method(ragicClient, "updateEntry", async (_path: string, _entry: string, body: RagicRecord) => {
        current = String(body[fieldId]); return {};
      });
      t.mock.method(ragicClient, "clearFormCache", () => undefined);
      const options = { expectedEntryLastUpdatedAt: "old" };
      const run = () => kind === "date" ? workReportService.updatePlannedEndDate(formId, "1", "2026-09-02", { ...options, expectedPlannedEndDate: "2026-09-01" })
        : kind === "machine" ? workReportService.updateMainMachine(formId, "1", "MA19", { ...options, expectedMachineCode: "MA18" })
        : kind === "urgent" ? workReportService.updateUrgent(formId, "1", true, { ...options, expectedUrgent: false })
        : workReportService.updateStartSchedule(formId, "1", true, { ...options, expectedStartSchedule: false });
      assert.equal((await run()).changed, true);
      assert.equal((await run()).changed, false);
      assert.equal(write.mock.callCount(), 1, "FIELD_SCOPE_WRITE_COUNT");
    });
  }
  for (const kind of ["date", "machine"]) {
    test(`${formId} ${kind} 同欄第三值即使 timestamp 相同仍拒絕`, async (t) => {
      const config = getFormConfig(formId);
      const fieldId = config.writeConfig.mainWriteFields![kind === "date" ? "plannedEndDate" : "machineCode"];
      t.mock.method(ragicClient, "getEntry", async () => ({ [fieldId]: kind === "date" ? "2026/09/03" : "MA20", "9001202": "same" }));
      const write = t.mock.method(ragicClient, "updateEntry", async () => ({}));
      await assert.rejects(() => kind === "date"
        ? workReportService.updatePlannedEndDate(formId, "1", "2026-09-02", { expectedPlannedEndDate: "2026-09-01", expectedEntryLastUpdatedAt: "same" })
        : workReportService.updateMainMachine(formId, "1", "MA19", { expectedMachineCode: "MA18", expectedEntryLastUpdatedAt: "same" }),
      (error: unknown) => error instanceof HttpError && error.code === "ENTRY_FIELD_CONFLICT", "SAME_FIELD_CONFLICT");
      assert.equal(write.mock.callCount(), 0);
    });
  }
  for (const action of ["update", "delete"] as const) {
    for (const change of ["unrelated", "same-row", "closed"] as const) {
      test(`${formId} ${action} ${change} 由讀取 mapper 的列版本保護實際寫入`, async (t) => {
        const config = getFormConfig(formId);
        const fields = config.writeConfig.subtableWriteFields;
        const original = { [fields.remark]: "before", [fields.productionQty]: 5 };
        const expectedRowSnapshotHash = mapSubtable({ "42": original }, config)[0].snapshotHash!;
        const row = { ...original, ...(change === "same-row" ? { [fields.productionQty]: 6 } : {}) };
        t.mock.method(ragicClient, "getEntry", async () => ({
          "9001202": "new", [config.mainFields.status]: change === "closed" ? "已結案" : "未結案",
          [config.writeConfig.subtableId]: { "42": row, "43": { [fields.remark]: "another person's update" } },
        }));
        const parentCheck = t.mock.method(workReportMutationPreconditionService, "assertEntryNotModified", async () => { throw new Error("must use row baseline"); });
        t.mock.method(workReportReadService, "getFormOptions", async () => ({ operatorId: [{ value: "A001", label: "Test", display: "Test" }] }));
        t.mock.method(ragicClient, "executeActionButton", async () => ({ status: "SUCCESS", msg: "ok", raw: {} }));
        t.mock.method(ragicClient, "clearFormCache", () => undefined);
        const write = t.mock.method(ragicClient, "updateEntry", async (_path: string, _entry: string, body: RagicRecord) => {
          if (action === "update") assert.ok(body[config.writeConfig.subtableId]);
          else assert.ok(Object.keys(body).some((key) => key.startsWith("_DELSUB_")));
          return {};
        });
        const run = () => action === "delete"
          ? workReportRowMutationService.hardDeleteReport(formId, "1", "42", { expectedRowSnapshotHash, expectedEntryLastUpdatedAt: "old", skipDeleteRecalculate: true })
          : workReportRowMutationService.updateReport(formId, "1", "42", {
            date: "2026-09-16", machineId: "MA18", operatorId: "A001", processCode: "A01",
            startTime: "08:00", endTime: "09:00", productionQty: 5, remark: "after",
          }, { expectedRowSnapshotHash, expectedEntryLastUpdatedAt: "old" });
        if (change === "unrelated") { await run(); assert.equal(write.mock.callCount(), 1, "UNRELATED_ROW_MUST_PASS"); }
        else {
          await assert.rejects(run, (error: unknown) => error instanceof HttpError && error.code === (change === "closed" ? "ENTRY_CLOSED" : "REPORT_ROW_CONFLICT"), "ROW_WRITE_GUARD");
          assert.equal(write.mock.callCount(), 0);
        }
        assert.equal(parentCheck.mock.callCount(), 0);
      });
    }
  }
}

test("明細 hash 在欄位 ID 與名稱讀取格式間保持一致，空字串與零不同", () => {
  const config = getFormConfig("901");
  const numeric = { [config.writeConfig.subtableWriteFields.productionQty]: 0 };
  const named = { [config.subtableFields.productionQty]: "0" };
  assert.equal(buildRowSnapshotHash(config, "42", numeric), buildRowSnapshotHash(config, "42", named));
  assert.notEqual(buildRowSnapshotHash(config, "42", numeric), buildRowSnapshotHash(config, "42", {}));
});

test("902 欄位名稱回應只比較內製指定機台，不把 上游機台當成原值", async (t) => {
  let machine = "MB50";
  t.mock.method(ragicClient, "getEntry", async () => ({ demo_machine_code: machine, demo_line_b_machine: "LINE-B", "9001202": "new" }));
  t.mock.method(ragicClient, "clearFormCache", () => undefined);
  const write = t.mock.method(ragicClient, "updateEntry", async (_path: string, _id: string, body: RagicRecord) => { machine = String(body["9001045"]); return {}; });
  await workReportService.updateMainMachine("902", "1", "MA51", { expectedMachineCode: "MB50", expectedEntryLastUpdatedAt: "old" });
  assert.equal(write.mock.callCount(), 1);
});

test("明細 hash 比較 Ragic scalar wrapper 實際值，不能把不同物件當成相同字串", () => {
  const config = getFormConfig("901");
  const fieldId = config.writeConfig.subtableWriteFields.remark;
  const hash = (value: unknown) => buildRowSnapshotHash(config, "42", { [fieldId]: value });
  assert.equal(hash({ value: "before" }), hash("before"));
  assert.equal(hash({ label: "before" }), hash("before"));
  assert.notEqual(hash({ label: "before" }), hash({ label: "after" }));
  assert.notEqual(hash({ nested: "before" }), hash({ nested: "after" }));
});
