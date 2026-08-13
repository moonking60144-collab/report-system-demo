import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../../src/config/env";
import { FORM_104_CONFIG } from "../../src/config/forms/form-104";

test("Form 16 required field 與 action IDs 都是非空 numeric contract", () => {
  const ids = [
    env.RAGIC_FORM_16_SAVE_ACTION_BUTTON_ID,
    env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID,
    env.RAGIC_FORM_16_TYPE_FIELD_ID,
    env.RAGIC_FORM_16_PROCESS_FIELD_ID,
    env.RAGIC_FORM_16_DEP_FIELD_ID,
    env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID,
    env.RAGIC_FORM_16_REMARK_FIELD_ID,
    env.RAGIC_FORM_16_DATE_FIELD_ID,
  ];

  assert.ok(ids.every((id) => /^\d+$/.test(id)));
});

test("Form 104 subtable 與 Form 16 共用的 date/process field 只讀同一份 env contract", () => {
  assert.equal(
    FORM_104_CONFIG.writeConfig.subtableWriteFields.date,
    env.RAGIC_FORM_16_DATE_FIELD_ID
  );
  assert.equal(
    FORM_104_CONFIG.writeConfig.subtableWriteFields.processCode,
    env.RAGIC_FORM_16_PROCESS_FIELD_ID
  );
});
