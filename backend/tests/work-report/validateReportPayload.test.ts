import test from "node:test";
import assert from "node:assert/strict";
import { getFormConfig } from "../../src/config/forms";
import { validateReportPayload } from "../../src/services/work-report/mutation/validateReportPayload";
import type { ReportWritePayload } from "../../src/types/workReport";

function createValidPayload(): ReportWritePayload {
  return {
    date: "2026/07/01",
    processCode: "PA",
    machineId: "MB50",
    operatorId: "RA004",
    startTime: "08:00",
    endTime: "17:00",
    productionQty: 10,
  };
}

test("901/902 create payload 必須帶 processCode，避免 ActivityLog computed Type 無法推導", () => {
  for (const formId of ["901", "902"]) {
    const config = getFormConfig(formId);
    assert.ok(config.writeConfig.requiredFields.includes("processCode"));
    assert.doesNotThrow(() =>
      validateReportPayload(createValidPayload(), config.writeConfig.requiredFields)
    );

    const payloadWithoutProcessCode = createValidPayload();
    delete payloadWithoutProcessCode.processCode;
    assert.throws(
      () => validateReportPayload(payloadWithoutProcessCode, config.writeConfig.requiredFields),
      /缺少必填欄位：processCode/
    );
  }
});
