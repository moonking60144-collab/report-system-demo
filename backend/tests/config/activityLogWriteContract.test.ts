import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../../src/config/env";
import { FORM_901_CONFIG } from "../../src/config/forms/form-901";

test("activity log required field 與 action IDs 都是非空 numeric contract", () => {
  const ids = [
    env.UPSTREAM_ACTIVITY_LOG_SAVE_ACTION_BUTTON_ID,
    env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID,
    env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID,
    env.UPSTREAM_ACTIVITY_LOG_PROCESS_FIELD_ID,
    env.UPSTREAM_ACTIVITY_LOG_DEP_FIELD_ID,
    env.UPSTREAM_ACTIVITY_LOG_PROD_TYPE_FIELD_ID,
    env.UPSTREAM_ACTIVITY_LOG_REMARK_FIELD_ID,
    env.UPSTREAM_ACTIVITY_LOG_DATE_FIELD_ID,
  ];

  assert.ok(ids.every((id) => /^\d+$/.test(id)));
});

test("Form 901 subtable 與 activity log 共用的 date/process field 只讀同一份 env contract", () => {
  assert.equal(
    FORM_901_CONFIG.writeConfig.subtableWriteFields.date,
    env.UPSTREAM_ACTIVITY_LOG_DATE_FIELD_ID
  );
  assert.equal(
    FORM_901_CONFIG.writeConfig.subtableWriteFields.processCode,
    env.UPSTREAM_ACTIVITY_LOG_PROCESS_FIELD_ID
  );
});
