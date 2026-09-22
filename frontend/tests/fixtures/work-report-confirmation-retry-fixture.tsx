import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import i18n from "../../src/i18n";
import { useTaskMonitor } from "../../src/features/work-report/hooks/useTaskMonitor";
import { WorkReportStatusArea } from "../../src/features/work-report/components/WorkReportStatusArea";
import { bindRetryableEntryFieldMutationTask, getOrCreateRetryableEntryFieldMutation, listRetryableEntryFieldMutations, isRetryableEntryFieldMutationBlocking } from "../../src/features/work-report/entryFieldTaskRetryStore";
import { useWorkReportDetailStatusController } from "../../src/features/work-report/hooks/detail/useWorkReportDetailStatusController";
import { hasPendingEntryFieldSettlement } from "../../src/features/work-report/hooks/detail/useWorkReportDetailTaskController";

if (new URLSearchParams(location.search).has("boundRetries")) {
  const stored = JSON.parse(localStorage.getItem("work-reports:task-monitor") ?? "[]") as { entryId: string; taskId: string }[];
  for (const monitor of stored) {
    const retry = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-sort-order", formId: "901", entryId: monitor.entryId,
      value: 11, previousValue: 9, workOrderNo: `WO-${monitor.entryId}`,
    });
    bindRetryableEntryFieldMutationTask(retry.operation, retry.clientMutationId, monitor.taskId, new Date().toISOString());
  }
}

export function Probe() {
  const state = useTaskMonitor();
  const initialized = useRef(false);
  const [, render] = useState(0);
  const detail = useWorkReportDetailStatusController({
    formId: "901", safeEntryId: "0", loading: false, refreshing: false, submitting: false,
    editingRowId: null, modalOpen: false, hasActiveMutationTask: false,
    currentEntryTaskMonitors: state.createTaskMonitors.filter(task => task.entryId === "0"),
    retryEntryFieldConfirmation: state.retryEntryFieldConfirmation,
    registerEntryFieldSettlementConsumer: state.registerEntryFieldSettlementConsumer,
    activeMutationTask: null, activeMutationTaskCount: 0, registerAcceptedMutationTask: async () => {},
    pendingMutationReplayStorageKey: "confirmation-fixture-replay", setNotice: () => {},
    setHighlightedDetailRowId: () => {}, loadEntry: async () => {}, currentRecord: null,
    mergeAuthoritativeRecord: () => {}, releaseRowEditLock: async () => {}, notice: null,
    loadError: null, isValidRoute: true, realtimeConnected: true, realtimeDisconnectedSince: null,
    entryEditingSummary: null, t: (key, options) => i18n.t(key, options),
  });
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    state.setTaskMonitorExpanded(true);
    if (state.createTaskMonitors.length) return;
    for (let i = 0; i < 5; i++) {
      const id = String(i);
      const retry = getOrCreateRetryableEntryFieldMutation({
        operation: "work-report-sort-order", formId: "901", entryId: id, value: 11, previousValue: 9, workOrderNo: `WO-${id}`,
      });
      bindRetryableEntryFieldMutationTask(retry.operation, retry.clientMutationId, `task-${id}`, new Date().toISOString());
      state.upsertCreateTaskMonitor({
        taskId: `task-${id}`, kind: "update", formId: "901", entryId: id, workOrderNo: `WO-${id}`,
        status: "running", entryFieldOperation: "work-report-sort-order", message: "running", updatedAt: new Date().toISOString(),
      });
    }
  }, [state]);
  return <>
    <button onClick={() => render(x => x + 1)}>rerender</button>
    <button onClick={() => state.upsertCreateTaskMonitor({
      taskId: "later-terminal", kind: "update", formId: "901", entryId: "0", workOrderNo: "WO-0",
      status: "success", message: "saved", entryFieldOperation: "work-report-sort-order", updatedAt: new Date().toISOString(),
    })}>later terminal</button>
    <button onClick={state.clearFinishedTaskMonitors}>clear</button>
    <button disabled={state.createTaskMonitors.some(task => hasPendingEntryFieldSettlement(task, () => null))}>edit</button>
    <output data-testid="detail-status">{detail.systemStatus.message}</output>
    {detail.systemStatus.onAction && <button onClick={detail.systemStatus.onAction}>detail retry</button>}
    <output data-testid="state">{JSON.stringify(state.createTaskMonitors.map(m => ({
      id: m.taskId, status: m.status, outcome: m.entryFieldSettlementOutcome ?? null, message: m.message,
      lifecycleState: m.lifecycleState, stale: m.stale, errorCode: m.entryFieldSettlementErrorCode,
    })))}</output>
    <output data-testid="retry-evidence">{JSON.stringify(listRetryableEntryFieldMutations().map(retry => ({
      entryId: retry.entryId, outcome: retry.settlementOutcome, blocking: isRetryableEntryFieldMutationBlocking(retry),
    })))}</output>
    <WorkReportStatusArea uiLanguage="zh-TW" hydration={{
      shouldUseFullHydrationForList: false, hasHydratedAllRecords: false, backendSnapshotAt: null,
      truncated: false, truncatedCount: 0, realtimeConnected: false, realtimeDisconnectedSince: null,
      previewRevalidating: false, previewRevalidationError: null,
    }} summary={{ sortedFilteredRecordsLength: 0, visibleRecordsLength: 0, currentPageReportCount: 0 }}
      isSyncingFromRagic={false} notice={null} loading={false} error={null} hasRenderableContent
      taskMonitor={{ ...state, onToggleTaskMonitorExpanded: state.toggleTaskMonitorExpanded,
        onCollapseTaskMonitor: state.collapseTaskMonitor, onClearFinishedTaskMonitors: state.clearFinishedTaskMonitors,
        onRetryEntryFieldConfirmation: state.retryEntryFieldConfirmation }} />
  </>;
}
void i18n.changeLanguage("zh-TW").then(() => createRoot(document.getElementById("root")!).render(<Probe />));
