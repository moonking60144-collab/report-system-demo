/* eslint-disable react-refresh/only-export-components */
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import "antd/dist/reset.css";
import "../../src/index.css";
import "../../src/App.css";
import "../../src/i18n";
import { WorkReportTableSection } from "../../src/features/work-report/components/WorkReportTableSection";
import { useWorkReportListNavigation } from "../../src/features/work-report/hooks/useWorkReportListNavigation";
import { DEFAULT_GLOBAL_FILTERS } from "../../src/features/work-report/constants";
import { EMPTY_WORK_REPORT_FILTER_GROUP } from "../../src/features/work-report/utils/customFilterUtils";
import type { WorkReportListLocationState } from "../../src/features/work-report/types";

function List() {
  const location = useLocation();
  const size = Number(new URLSearchParams(location.search).get("pageSize") ?? 25);
  const records = useMemo(() => Array.from({ length: size }, (_, index) => ({
    id: String(index), workOrderNo: `WO-${index}`, status: "未結案", siteRunning: "Yes",
  })), [size]);
  const [highlightedEntryId, setHighlightedEntryId] = useState<string | null>(null);
  const { handleOpenDetail } = useWorkReportListNavigation({
    currentFormId: "901", activeLandingPageKey: "line-a-901", activeTopView: "report",
    activePlaceholderViewId: null, globalFilterDraft: DEFAULT_GLOBAL_FILTERS, globalFilters: DEFAULT_GLOBAL_FILTERS,
    customFilterDraft: EMPTY_WORK_REPORT_FILTER_GROUP, customFilters: EMPTY_WORK_REPORT_FILTER_GROUP,
    page: 1, pageSize: size, columnFilterState: {}, columnSortRules: [], loading: false,
    visibleRecords: records, setHighlightedEntryId,
  });
  return <main className="page work-report-viewport"><div className="ragic-list-shell is-settings-view">
    <section className="ragic-list-main"><div className="work-report-list-workspace">
      <h1>捲動恢復測試</h1>
      <WorkReportTableSection columnDisplayMode="fit"
        columns={[{ title: "工令", dataIndex: "workOrderNo", width: 700 }]}
        visibleRecords={records} pageFrom={1} pageTo={size} page={1} loading={false} backgroundLoading={false}
        error={null} hasRenderableContent submitting={false} isHydratingAllRecords={false}
        hasMoreForPager={false} softBusy={false} softBusyLabel={null} highlightedEntryId={highlightedEntryId}
        onPrevPage={() => {}} onNextPage={() => {}} onOpenDetail={handleOpenDetail}
        onPreloadDetail={() => {}} onRetry={() => {}} />
    </div></section>
  </div></main>;
}
function Detail() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as WorkReportListLocationState;
  return <button onClick={() => navigate(`/${state.listSearch}`, { state })}>返回列表</button>;
}
export function mountWorkReportScrollNavigation(root: HTMLElement) {
  createRoot(root).render(<MemoryRouter initialEntries={[`/${window.location.search}`]}>
    <Routes><Route path="/" element={<List />} /><Route path="/reports/:formId/:entryId" element={<Detail />} /></Routes>
  </MemoryRouter>);
}
