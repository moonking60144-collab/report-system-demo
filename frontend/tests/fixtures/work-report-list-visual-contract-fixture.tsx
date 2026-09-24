/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Table } from "antd";
import "antd/dist/reset.css";
import "../../src/index.css";
import "../../src/App.css";
import "../../src/i18n";
import type { WorkReportRecord } from "../../src/api/workReport";
import {
  COLUMN_BOOL_FALSE_TOKEN,
  COLUMN_BOOL_TRUE_TOKEN,
} from "../../src/features/work-report/constants";
import { getSelectableWorkReportColumns } from "../../src/features/work-report/hooks/workReportColumnDefinitions";
import { useColumnMenuState } from "../../src/features/work-report/hooks/useColumnMenuState";
import { useWorkReportColumns } from "../../src/features/work-report/hooks/useWorkReportColumns";
import { useWorkReportMarkedRow } from "../../src/features/work-report/hooks/useWorkReportMarkedRow";
import { WorkReportTableSection } from "../../src/features/work-report/components/WorkReportTableSection";
import { WorkReportWorkspaceToolbar } from "../../src/features/work-report/components/WorkReportWorkspaceToolbar";
import { readColumnDisplayMode, writeColumnDisplayMode } from "../../src/features/work-report/utils/storageUtils";
import type {
  ColumnDisplayMode,
  ColumnKey,
  WorkReportEntryFieldMutationOperation,
} from "../../src/features/work-report/types";

declare global {
  interface Window {
    __workReportListVisualReady?: boolean;
    __workReportListVisualDetailOpenCount?: number;
    __workReportListVisualPlannedEndDateMutationCount?: number;
    __workReportListVisualStartScheduleMutationCount?: number;
    __workReportListVisualMainMachineMutationCount?: number;
    __workReportListVisualUrgentMutationCount?: number;
  }
}

const VISIBLE_COLUMN_ORDER: ColumnKey[] = [
  "startSchedule",
  "previousMachine",
  "forgingMother",
  "workOrderNo",
  "machineCode",
  "customerPartNo",
  "urgent",
  "sortOrder",
  "plannedEndDate",
  "size",
];

const INITIAL_RECORDS: WorkReportRecord[] = [
  {
    id: "empty-previous",
    workOrderNo: "WO-EMPTY-PREV",
    status: "未結案",
    machineCode: "MA51",
    filterMachineCode: "MA51",
    startSchedule: "No",
    previousMachine: "",
    forgingMother: "DEMO-PART-RD",
    customerPartNo: "DEMO-PART-RD",
    urgent: "No",
    plannedEndDate: "2026/09/01",
    size: "06*151",
    sortOrder: 99,
    erpPartNo: null,
  },
  {
    id: "normal",
    workOrderNo: "DEMO-070335",
    status: "未結案",
    machineCode: "MA33",
    filterMachineCode: "MA33",
    startSchedule: "Yes",
    previousMachine: "MB17",
    forgingMother: "PART-003A",
    customerPartNo: "DEMO-PART-003B",
    urgent: "Yes",
    plannedEndDate: "2026/09/01",
    size: "10*114彩將變",
    sortOrder: 2,
    erpPartNo: null,
  },
  {
    id: "running",
    workOrderNo: "WO-RUNNING",
    status: "未結案",
    machineCode: "MA33",
    filterMachineCode: "MA33",
    startSchedule: "Yes",
    previousMachine: "MA51",
    forgingMother: "DEMO-LONG-PART-004-V01-02",
    customerPartNo: "DEMO-LONG-PART-004-V01-02",
    urgent: "Yes",
    plannedEndDate: "2026/09/02",
    size: "10*029.5",
    sortOrder: 3,
    erpPartNo: null,
  },
  {
    id: "closed",
    workOrderNo: "WO-CLOSED",
    status: "已結案",
    machineCode: "MA22",
    filterMachineCode: "MA22",
    startSchedule: "Yes",
    previousMachine: "MB09",
    forgingMother: "DEMO-PART-004",
    customerPartNo: "DEMO-PART-005",
    urgent: "Yes",
    plannedEndDate: "2026/09/03",
    size: "06*012 JC B1",
    sortOrder: 4,
    erpPartNo: null,
  },
];

function WorkReportListVisualContractFixture() {
  const statusProbe = new URLSearchParams(window.location.search).has("statusProbe");
  const showSidebar = statusProbe && window.innerWidth > 960;
  const [statusPageSize, setStatusPageSize] = useState(25);
  const statusRecords = Array.from({ length: statusPageSize }, (_, index) => ({
    ...INITIAL_RECORDS[index < 4 ? index : 1],
    id: index < 4 ? INITIAL_RECORDS[index].id : `status-${index}`,
    siteRunning: index === 2 || index === 3 ? "Yes" : "No",
  }));
  const formId: "901" | "902" =
    new URLSearchParams(window.location.search).get("formId") === "902" ? "902" : "901";
  const { markedRow, toggleMarkedRow, clearMarkedRow } = useWorkReportMarkedRow(formId);
  const visibleColumnOrder = useMemo(() => new URLSearchParams(window.location.search).has("denseColumns")
    ? getSelectableWorkReportColumns(formId, "fit").map((column) => column.key)
    : VISIBLE_COLUMN_ORDER, [formId]);
  const [page, setPage] = useState(1);
  const [records, setRecords] = useState<WorkReportRecord[]>(() =>
    INITIAL_RECORDS.map((record) => ({ ...record }))
  );
  const [columnDisplayMode, setColumnDisplayMode] = useState<ColumnDisplayMode>(
    readColumnDisplayMode
  );
  const [entryFieldMutationSyncingEntryIdsByOperation] = useState<
    ReadonlyMap<WorkReportEntryFieldMutationOperation, ReadonlySet<string>>
  >(() => {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get("dateSyncing") === "1") {
      return new Map([["work-report-planned-end-date", new Set(["normal"])]]);
    }
    if (searchParams.get("sortSyncing") === "1") {
      return new Map([["work-report-sort-order", new Set(["normal"])]]);
    }
    return new Map();
  });
  const [entryFieldMutationBlockedEntryIds] = useState<ReadonlySet<string>>(() => {
    const blockedEntryIds = new Set<string>();
    for (const entryIds of entryFieldMutationSyncingEntryIdsByOperation.values()) {
      for (const entryId of entryIds) blockedEntryIds.add(entryId);
    }
    return blockedEntryIds;
  });
  const [showBooleanHeaderBadges] = useState(
    () => new URLSearchParams(window.location.search).get("booleanBadges") === "1"
  );
  const {
    columnFilterState,
    columnSortRules,
    columnMenuOpenKey,
    columnMenuOpenOwnerId,
    columnMenuSearchState,
    clearColumnFilter,
    applyColumnSortRule,
    clearColumnSortRule,
    openColumnAnalysis,
    handleColumnMenuSearchChange,
    markColumnMenuInteract,
    openColumnTextFilterDialog,
    toggleColumnFilterToken,
    clearColumnMenuSettings,
    handleColumnMenuOpenChange,
  } = useColumnMenuState({
    setPage,
    initialState: {
      columnFilterState: showBooleanHeaderBadges
        ? {
            startSchedule: { selectedTokens: [COLUMN_BOOL_TRUE_TOKEN] },
            urgent: { selectedTokens: [COLUMN_BOOL_TRUE_TOKEN] },
          }
        : undefined,
      columnSortRules: [
        { key: "machineCode", direction: "asc", type: "text" },
        { key: "sortOrder", direction: "asc", type: "number" },
        ...(showBooleanHeaderBadges
          ? [
              { key: "startSchedule", direction: "asc" as const, type: "boolean" as const },
              { key: "urgent", direction: "asc" as const, type: "boolean" as const },
            ]
          : []),
      ],
    },
  });
  const hiddenColumnKeys = useMemo(() => {
    const availableKeys = getSelectableWorkReportColumns(formId, columnDisplayMode).map(
      (column) => column.key
    );
    return new Set(availableKeys.filter((key) => !visibleColumnOrder.includes(key)));
  }, [columnDisplayMode, formId, visibleColumnOrder]);
  const { columns } = useWorkReportColumns({
    currentFormId: formId,
    columnDisplayMode,
    columnWidthOverrides: {},
    columnOrder: visibleColumnOrder,
    hiddenColumnKeys,
    columnColors: {},
    onColumnResizeStart: () => undefined,
    disableFixedColumns: true,
    uiLanguage: "zh",
    onOpenDetail: () => {
      window.__workReportListVisualDetailOpenCount =
        (window.__workReportListVisualDetailOpenCount ?? 0) + 1;
    },
    onUpdateStartSchedule: async (record, startSchedule) => {
      window.__workReportListVisualStartScheduleMutationCount =
        (window.__workReportListVisualStartScheduleMutationCount ?? 0) + 1;
      setRecords((current) =>
        current.map((item) =>
          String(item.id) === String(record.id)
            ? { ...item, startSchedule: startSchedule ? "Yes" : "No" }
            : item
        )
      );
    },
    onUpdateMainMachine: async (record, machineCode) => {
      window.__workReportListVisualMainMachineMutationCount =
        (window.__workReportListVisualMainMachineMutationCount ?? 0) + 1;
      setRecords((current) =>
        current.map((item) =>
          String(item.id) === String(record.id)
            ? formId === "902"
              ? { ...item, filterMachineCode: machineCode }
              : { ...item, machineCode }
            : item
        )
      );
    },
    onUpdateUrgent: async (record, urgent) => {
      window.__workReportListVisualUrgentMutationCount =
        (window.__workReportListVisualUrgentMutationCount ?? 0) + 1;
      setRecords((current) =>
        current.map((item) =>
          String(item.id) === String(record.id)
            ? { ...item, urgent: urgent ? "Yes" : "No" }
            : item
        )
      );
    },
    onUpdateSortOrder: async () => undefined,
    onUpdatePlannedEndDate: async (record, plannedEndDate) => {
      window.__workReportListVisualPlannedEndDateMutationCount =
        (window.__workReportListVisualPlannedEndDateMutationCount ?? 0) + 1;
      setRecords((current) =>
        current.map((item) =>
          String(item.id) === String(record.id) ? { ...item, plannedEndDate } : item
        )
      );
    },
    entryFieldMutationSyncingEntryIdsByOperation,
    entryFieldMutationBlockedEntryIds,
    machineOptions: [
      { value: "MA51", label: "MA51", display: "MA51" },
      { value: "MA33", label: "MA33", display: "MA33" },
      { value: "MA22", label: "MA22", display: "MA22" },
    ],
    globalSearchKeyword: "",
    menuState: {
      columnFilterState,
      columnSortRules,
      columnMenuOpenKey,
      columnMenuOpenOwnerId,
      openColumnFacetOptionsFiltered:
        columnMenuOpenKey === "urgent"
          ? [
              { token: COLUMN_BOOL_FALSE_TOKEN, label: "否" },
              { token: COLUMN_BOOL_TRUE_TOKEN, label: "是" },
            ]
          : [],
      columnMenuSearchState,
    },
    menuActions: {
      clearColumnFilter,
      applyColumnSortRule,
      clearColumnSortRule,
      openColumnAnalysis,
      handleColumnMenuSearchChange,
      markColumnMenuInteract,
      openColumnTextFilterDialog,
      toggleColumnFilterToken,
      clearColumnMenuSettings,
      handleColumnMenuOpenChange,
    },
  });

  useEffect(() => {
    window.__workReportListVisualDetailOpenCount = 0;
    window.__workReportListVisualPlannedEndDateMutationCount = 0;
    window.__workReportListVisualReady = true;
  }, []);

  return (
    <main
      className={statusProbe ? "page work-report-viewport" : undefined}
      style={statusProbe ? undefined : { width: 1200, maxWidth: "100%", padding: 24 }}
    >
      <div
        className={statusProbe ? `ragic-list-shell${showSidebar ? "" : " is-settings-view"}` : undefined}
      >
        {showSidebar ? (
          <aside className="fixed-filter-sidebar-shell" aria-label="篩選側欄測試">
            <div className="fixed-filter-sidebar">
              <header className="fixed-filter-sidebar-header">
                <div className="fixed-filter-sidebar-title">
                  <strong>篩選</strong>
                  <p>保留於畫面左側</p>
                </div>
              </header>
              <div className="fixed-filter-sidebar-body">
                <button type="button" className="fixed-filter-item is-active">所有資料</button>
              </div>
            </div>
          </aside>
        ) : null}
        <section className={statusProbe ? "ragic-list-main" : undefined}>
          <div className={statusProbe ? "work-report-list-workspace" : undefined}>
      <WorkReportWorkspaceToolbar
        currentPageGroupLabel="製程 A 報工"
        currentPageContextLabel={formId === "901" ? "901 / PA" : "902 / PB"}
        matchedCount={statusProbe ? statusRecords.length : records.length}
        markedRow={markedRow}
        onClearMarkedRow={clearMarkedRow}
        searchValue=""
        onSearchValueChange={() => undefined}
        onSearchSubmit={() => undefined}
        page={page}
        hasMoreForPager={statusProbe}
        onPrevPage={() => setPage(previous => Math.max(1, previous - 1))}
        onNextPage={() => setPage(previous => previous + 1)}
        activeFilterCount={0}
        hasPendingFilterChanges={false}
        filterPanelOpen={false}
        onOpenFilters={() => undefined}
        columnDisplayMode={columnDisplayMode}
        onChangeColumnDisplayMode={(mode) => {
          setColumnDisplayMode(mode);
          writeColumnDisplayMode(mode);
        }}
        columnSettingsOpen={false}
        onOpenColumnSettings={() => undefined}
        onOpenTaskQueue={() => undefined}
        onOpenPrintView={() => undefined}
        printViewChecking={false}
        pageSize={statusProbe ? statusPageSize : 25}
        pageSizeOptions={(statusProbe ? ["25", "50", "100"] : ["25"]).map((value) => ({
          value,
          label: value,
          display: value,
        }))}
        onChangePageSize={statusProbe ? setStatusPageSize : () => undefined}
        controlsDisabled={false}
        isSyncingFromRagic={false}
        onRefresh={() => undefined}
        stickyEnabled={statusProbe}
        onHeightChange={() => undefined}
      />
      {statusProbe ? (
        <WorkReportTableSection
          showScrollHintButton={new URLSearchParams(window.location.search).has("scrollHint")}
          columns={columns}
          columnDisplayMode={columnDisplayMode}
          visibleRecords={statusRecords}
          backgroundLoading={false}
          error={null}
          hasRenderableContent
          softBusy={false}
          softBusyLabel={null}
          highlightedEntryId="normal"
          markedRow={markedRow}
          onToggleMarkedRow={toggleMarkedRow}
          onOpenDetail={() => {
            window.__workReportListVisualDetailOpenCount =
              (window.__workReportListVisualDetailOpenCount ?? 0) + 1;
          }}
          onPreloadDetail={() => undefined}
          onRetry={() => undefined}
        />
      ) : (
        <Table<WorkReportRecord>
        className={`ragic-table ${columnDisplayMode === "fit" ? "is-fit" : ""}`}
        columns={columns}
        dataSource={records}
        pagination={false}
        rowKey="id"
        rowClassName={(record) => {
          if (record.id === "running") return "row-running";
          if (record.id === "closed") return "row-closed";
          return "";
        }}
        scroll={{ x: 900 }}
        tableLayout="fixed"
        onRow={() => ({
          onClick: () => {
            window.__workReportListVisualDetailOpenCount =
              (window.__workReportListVisualDetailOpenCount ?? 0) + 1;
          },
        })}
      />
      )}
          </div>
        </section>
      </div>
    </main>
  );
}

export function mountWorkReportListVisualContract(root: HTMLElement): void {
  createRoot(root).render(<WorkReportListVisualContractFixture />);
}
