import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../src/config/env";
import { FORM_901_CONFIG } from "../../src/config/forms/form-901";
import { buildActivityLogFallbackWritePayload } from "../../src/services/work-report/shared/workReportPayloadHelpers";

test("ActivityLog fallback payload 會帶入後端已解析的 Type 欄位", () => {
  const payload = buildActivityLogFallbackWritePayload(
    {
      date: "2026/07/01",
      processCode: "PA",
      machineId: "MB50",
      operatorId: "RA004",
      startTime: "08:00",
      endTime: "17:00",
      productionQty: 10,
    },
    "WO-TEST",
    "PROC-A",
    "P01加工一組",
    "PA",
    FORM_901_CONFIG
  );

  assert.equal(payload[env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID], "PROC-A");
  assert.equal(payload[env.UPSTREAM_ACTIVITY_LOG_PROCESS_FIELD_ID], "PA");
  assert.equal(payload[env.UPSTREAM_ACTIVITY_LOG_DEP_FIELD_ID], "P01加工一組");
  assert.equal(payload[env.UPSTREAM_ACTIVITY_LOG_PROD_TYPE_FIELD_ID], "PA");
});
