import { describe, expect, it } from "vitest";
import { normalizeWorkReportListViewState } from "./listViewStateUtils";

describe("normalizeWorkReportListViewState", () => {
  it("保留明確存在的空白 custom filter draft", () => {
    const appliedCondition = {
      id: "applied-status",
      field: "status" as const,
      operator: "isAnyOf" as const,
      values: ["未結案"],
    };

    const normalized = normalizeWorkReportListViewState({
      customFilterDraft: { joinMode: "all", conditions: [] },
      customFilters: { joinMode: "all", conditions: [appliedCondition] },
    });

    expect(normalized?.customFilterDraft).toEqual({
      joinMode: "all",
      conditions: [],
    });
    expect(normalized?.customFilters?.conditions).toEqual([appliedCondition]);
  });
});
