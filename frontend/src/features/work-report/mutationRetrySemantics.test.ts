import { describe, expect, it } from "vitest";
import {
  isCreateMutationWriteIndeterminate,
  isEntryLevelUpdateWithoutRetryPayload,
} from "./mutationRetrySemantics";

describe("isCreateMutationWriteIndeterminate", () => {
  it("blocks a create task when backend marks the write outcome indeterminate", () => {
    expect(
      isCreateMutationWriteIndeterminate({
        taskType: "create-report",
        writeIndeterminate: true,
        errorCode: "RAGIC_WRITE_FAILED",
      })
    ).toBe(true);
  });

  it("keeps legacy indeterminate create tasks blocked without the new flag", () => {
    expect(
      isCreateMutationWriteIndeterminate({
        taskType: "create-report",
        writeIndeterminate: null,
        errorCode: "FORM16_WRITE_INDETERMINATE",
      })
    ).toBe(true);
  });

  it("uses an explicit backend false instead of legacy error-code inference", () => {
    expect(
      isCreateMutationWriteIndeterminate({
        taskType: "create-report",
        writeIndeterminate: false,
        errorCode: "RAGIC_WRITE_FAILED",
      })
    ).toBe(false);
  });

  it("does not apply create idempotency semantics to update tasks", () => {
    expect(
      isCreateMutationWriteIndeterminate({
        taskType: "update-report",
        writeIndeterminate: true,
        errorCode: "RAGIC_WRITE_FAILED",
      })
    ).toBe(false);
  });
});

describe("isEntryLevelUpdateWithoutRetryPayload", () => {
  it("failed row update 以本機 retry rowId 辨識，不因 registry 尚無 rowId 被誤擋", () => {
    expect(
      isEntryLevelUpdateWithoutRetryPayload(
        { taskType: "update-report", rowId: null },
        "122298"
      )
    ).toBe(false);
  });

  it("真正的工令層級 update 沒有 row payload 時維持不可直接重送", () => {
    expect(
      isEntryLevelUpdateWithoutRetryPayload({
        taskType: "update-report",
        rowId: null,
      })
    ).toBe(true);
  });
});
