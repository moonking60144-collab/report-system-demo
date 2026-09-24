import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../src/i18n";
import "../../src/index.css";
import "../../src/App.css";
import { WorkReportToolbar } from "../../src/features/work-report/components/WorkReportToolbar";
import { WorkReportTableSection } from "../../src/features/work-report/components/WorkReportTableSection";
import { useWorkReportListStatusController } from "../../src/features/work-report/hooks/list/useWorkReportListStatusController";
import type { WorkReportLandingPageKey } from "../../src/features/work-report/types";
import type { WorkReportRecord } from "../../src/api/workReport";

const noop = () => {};
const records: WorkReportRecord[] = [{
  id: "kept-row", workOrderNo: "WO-TEST", status: "未結案", machineCode: "MA01",
  erpPartNo: null, customerPartNo: "PART", sortOrder: 1,
}];

export function Fixture() {
  const { t } = useTranslation(["workReport", "common"]);
  const [landing, setLanding] = useState<WorkReportLandingPageKey>("line-a-901");
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fullHydration, setFullHydration] = useState(false);
  const [softBusy, setSoftBusy] = useState(false);
  const { systemStatusNotice } = useWorkReportListStatusController({
    activeTopView: "report", notice: null, t,
    shouldUseFullHydrationForList: fullHydration, hasHydratedAllRecords: fullHydration,
    backendSnapshotAt: "2026-09-08T04:58:54Z", truncated: false, truncatedCount: 0,
    realtimeConnected: true, realtimeDisconnectedSince: null,
    previewRevalidationError: failed ? "測試錯誤" : null,
    isSyncingFromRagic: false, loading: false, error: null,
  });
  return <main className="ragic-page">
    <nav aria-label="測試控制">
      <button onClick={() => { setRefreshing(true); setFailed(false); }}>開始背景更新</button>
      <button onClick={() => setRefreshing(false)}>完成更新</button>
      <button onClick={() => setFailed(true)}>更新失敗</button>
      <button onClick={() => setFullHydration(value => !value)}>切換全量模式</button>
      <button onClick={() => setSoftBusy(value => !value)}>切換操作鎖定</button>
    </nav>
    <WorkReportToolbar
      uiLanguage="zh" setUiLanguage={noop} activeTopView="report" activeLandingPageKey={landing}
      currentPageGroupLabel={landing === "line-a-901" ? "製程 A 報工" : "製程 B 報工"}
      currentPageContextLabel={landing === "line-a-901" ? "901 / PA" : "902 / PB"}
      onOpenLandingPage={setLanding} onOpenLocalSettingsView={noop}
      columnSettingsOpen={false} setColumnSettingsOpen={noop} selectableColumns={[]}
      columnOrder={[]} hiddenColumnKeys={new Set()} columnColors={{}}
      onToggleColumnVisibility={noop} onMoveColumn={noop} onMoveColumnByOffset={noop}
      onChangeColumnColor={noop} onShowAllColumns={noop} onResetDefaultColumns={noop}
      systemStatusNotice={systemStatusNotice} systemStatusRefreshing={refreshing}
    />
    <WorkReportTableSection
      columns={[{ title: "工令單號", dataIndex: "workOrderNo", width: 180 }]}
      columnDisplayMode="fit" visibleRecords={records}
      backgroundLoading={refreshing} error={null} hasRenderableContent
      softBusy={softBusy} softBusyLabel={null} highlightedEntryId={null}
      markedRow={null} onToggleMarkedRow={noop} onOpenDetail={noop} onPreloadDetail={noop} onRetry={noop}
    />
  </main>;
}

void i18n.changeLanguage("zh-TW").then(() => createRoot(document.getElementById("root")!).render(<MemoryRouter><Fixture /></MemoryRouter>));
