import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import "../../../i18n";
import { ALL_FILTER_VALUE } from "../constants";
import type { WorkReportFormId } from "../types";
import { getWorkReportFilterFields } from "../utils";
import { WorkReportFilterPanel } from "./WorkReportFilterPanel";

const allOption = [{ value: ALL_FILTER_VALUE, label: "全部", display: "全部" }];
const booleanOptions = [
  { value: "all", label: "全部", display: "全部" },
  { value: "yes", label: "是", display: "是" },
  { value: "no", label: "否", display: "否" },
];

function renderPanel(
  currentFormId: WorkReportFormId,
  machineColumnFilterTokens: readonly string[] = []
): string {
  return renderToStaticMarkup(
    <WorkReportFilterPanel
      currentFormId={currentFormId}
      activeLandingPageKey={currentFormId === "901" ? "line-a-901" : "line-b-902"}
      filterGroup={{ joinMode: "all", conditions: [] }}
      onFilterGroupChange={vi.fn()}
      machineFilterOptions={allOption}
      statusFilterOptions={allOption}
      siteRunningFilterOptions={booleanOptions}
      columnSortRules={[]}
      filterControlDisabled={false}
      activeFilterChips={[]}
      columnFilterCount={machineColumnFilterTokens.length > 0 ? 1 : 0}
      machineColumnFilterTokens={machineColumnFilterTokens}
      hasPendingChanges={false}
      onRemoveActiveFilterChip={vi.fn()}
      onClearMachineColumnFilter={vi.fn()}
      onApplyFilters={vi.fn()}
      onClearFilters={vi.fn()}
      onApplySavedFilter={vi.fn()}
    />
  );
}

describe("WorkReportFilterPanel", () => {
  it("901 顯示開始排程篩選，902 不暴露未支援的條件", () => {
    expect(getWorkReportFilterFields("901")).toContain("startSchedule");
    expect(getWorkReportFilterFields("902")).not.toContain("startSchedule");
  });

  it("顯示實際套用的本站機台欄位篩選，不只顯示條件數", () => {
    const markup = renderPanel("902", ["MB41", "PA"]);
    expect(markup).toContain("MB41、PA");
    expect(markup.match(/class="filter-active-chip"/g)).toHaveLength(1);
  });
});
