import { describe, expect, it } from "vitest";
import { workReportDetailEditorModeReducer } from "./detailEditorMode";

describe("workReportDetailEditorModeReducer", () => {
  it("batch create 與 batch delete 由單一 mode 保證互斥", () => {
    const creating = workReportDetailEditorModeReducer("idle", {
      type: "enter-batch-create",
    });
    const deleting = workReportDetailEditorModeReducer(creating, {
      type: "enter-batch-delete",
    });

    expect(creating).toBe("batch-create");
    expect(deleting).toBe("batch-delete");
  });

  it("切換 entry 時 reset 回 idle", () => {
    expect(
      workReportDetailEditorModeReducer("batch-delete", { type: "reset" })
    ).toBe("idle");
  });
});
