import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkReportDataPath, resolveWritePath } from "../../src/config/env";
import { getFormConfig } from "../../src/config/forms";
import { ragicClient } from "../../src/ragic/client";
import { getRawEntry } from "../../src/services/work-report/shared/workReportReadHelpers";

for (const formId of ["901", "902"] as const) {
  test(`Form ${formId} test target 的 raw read 與 write path 對齊`, async (t) => {
    const config = getFormConfig(formId);
    const writePath = resolveWritePath(formId, config.ragicPath);
    assert.ok(writePath);
    assert.equal(resolveWorkReportDataPath(formId, config.ragicPath), writePath);

    const getEntryMock = t.mock.method(
      ragicClient,
      "getEntry",
      async (formPath: string, entryId: string) => {
        assert.equal(formPath, writePath);
        assert.equal(entryId, `E-${formId}`);
        return { _ragicId: entryId };
      }
    );

    await getRawEntry(config, `E-${formId}`);
    assert.equal(getEntryMock.mock.callCount(), 1);
  });
}
