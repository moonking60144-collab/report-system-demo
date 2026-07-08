import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../src/config/env";
import { FORM_104_CONFIG } from "../../src/config/forms/form-104";
import { buildForm16FallbackWritePayload } from "../../src/services/work-report/shared/workReportPayloadHelpers";

test("Form16 fallback payload 會帶入後端已解析的 Type 欄位", () => {
  const payload = buildForm16FallbackWritePayload(
    {
      date: "2026/07/01",
      processCode: "TI",
      machineId: "P10",
      operatorId: "RA004",
      startTime: "08:00",
      endTime: "17:00",
      productionQty: 10,
    },
    "WO-TEST",
    "TI搓牙",
    "C02搓牙組",
    "TI",
    FORM_104_CONFIG
  );

  assert.equal(payload[env.RAGIC_FORM_16_TYPE_FIELD_ID], "TI搓牙");
  assert.equal(payload[env.RAGIC_FORM_16_PROCESS_FIELD_ID], "TI");
  assert.equal(payload[env.RAGIC_FORM_16_DEP_FIELD_ID], "C02搓牙組");
  assert.equal(payload[env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID], "TI");
});
