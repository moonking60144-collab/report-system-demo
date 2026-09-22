/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "../../src/index.css";
import "../../src/App.css";
import "../../src/i18n";
import { WorkReportFilterPanel } from "../../src/features/work-report/components/WorkReportFilterPanel";
import type {
  ColumnSortRule,
  WorkReportFilterGroup,
} from "../../src/features/work-report/types";

declare global {
  interface Window {
    __workReportFilterPanelReady?: boolean;
    __workReportFilterPanelApplyCount?: number;
    __workReportFilterPanelSavedApplyCount?: number;
    __workReportFilterPanelGroup?: WorkReportFilterGroup;
  }
}

const INITIAL_FILTER_GROUP: WorkReportFilterGroup = {
  joinMode: "all",
  conditions: [
    {
      id: "status-open",
      field: "status",
      operator: "isAnyOf",
      values: ["未結案"],
    },
    {
      id: "schedule-started",
      field: "startSchedule",
      operator: "isAnyOf",
      values: ["yes"],
    },
  ],
};

const SORT_RULES: ColumnSortRule[] = [
  { key: "machineCode", direction: "asc", type: "text" },
];

function WorkReportFilterPanelFixture() {
  const [filterGroup, setFilterGroup] = useState<WorkReportFilterGroup>(INITIAL_FILTER_GROUP);
  const [sortRules, setSortRules] = useState<ColumnSortRule[]>(SORT_RULES);

  useEffect(() => {
    window.__workReportFilterPanelReady = true;
    window.__workReportFilterPanelGroup = filterGroup;
  }, [filterGroup]);

  return (
    <main style={{ maxWidth: 1440, margin: "0 auto", padding: 16 }}>
      <WorkReportFilterPanel
        currentFormId="901"
        activeLandingPageKey="line-a-901"
        filterGroup={filterGroup}
        onFilterGroupChange={setFilterGroup}
        machineFilterOptions={[
          { value: "__all__", label: "全部機台", display: "全部機台" },
          { value: "MA18", label: "MA18", display: "MA18" },
          { value: "MA23", label: "MA23", display: "MA23" },
          { value: "MA36", label: "MA36", display: "MA36" },
        ]}
        statusFilterOptions={[
          { value: "__all__", label: "全部狀態", display: "全部狀態" },
          { value: "未結案", label: "未結案", display: "未結案" },
          { value: "已結案", label: "已結案", display: "已結案" },
        ]}
        siteRunningFilterOptions={[
          { value: "all", label: "全部", display: "全部" },
          { value: "yes", label: "是", display: "是" },
          { value: "no", label: "否", display: "否" },
        ]}
        columnSortRules={sortRules}
        filterControlDisabled={false}
        activeFilterChips={[]}
        columnFilterCount={0}
        machineColumnFilterTokens={[]}
        hasPendingChanges={true}
        onRemoveActiveFilterChip={() => undefined}
        onClearMachineColumnFilter={() => undefined}
        onApplyFilters={() => {
          window.__workReportFilterPanelApplyCount =
            (window.__workReportFilterPanelApplyCount ?? 0) + 1;
        }}
        onClearFilters={() => setFilterGroup({ joinMode: "all", conditions: [] })}
        onApplySavedFilter={(savedGroup, savedSortRules) => {
          window.__workReportFilterPanelSavedApplyCount =
            (window.__workReportFilterPanelSavedApplyCount ?? 0) + 1;
          setFilterGroup(savedGroup);
          setSortRules(savedSortRules);
        }}
      />
    </main>
  );
}

export function mountWorkReportFilterPanel(container: Element | null): void {
  if (!container) {
    throw new Error("missing filter panel fixture root");
  }
  createRoot(container).render(<WorkReportFilterPanelFixture />);
}
