import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../../src/config/env";
import { FORM_901_CONFIG } from "../../src/config/forms/form-901";
import { FORM_902_CONFIG } from "../../src/config/forms/form-902";
import { MockRagicClient } from "../../src/ragic/mockClient";

test("Demo activity log 備註會回填兩種工令的子表", async () => {
  for (const config of [FORM_901_CONFIG, FORM_902_CONFIG]) {
    const formPath = config.ragicPath;
    assert.ok(formPath);
    const workOrderNo = `WO-${config.formId}`;
    const client = new MockRagicClient({
      [formPath]: {
        "1": { [config.mainFields.workOrderNo]: workOrderNo },
      },
    });
    const created = await client.createEntry("/demo/activity-logs", {
      [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: workOrderNo,
      [env.UPSTREAM_ACTIVITY_LOG_REMARK_FIELD_ID]: "驗收備註",
    });
    const parent = await client.getEntry(formPath, "1");
    const rowId = String(created._ragicId);
    const row = (parent?.[config.subtableId] as Record<string, Record<string, unknown>>)[rowId];
    assert.equal(row[config.writeConfig.subtableWriteFields.remark], "驗收備註");
    assert.equal(row[config.subtableFields.remark], "驗收備註");
  }
});
