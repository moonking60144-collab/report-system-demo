/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "../../src/i18n";
import { WorkReportTaskMonitorProvider } from "../../src/features/work-report/context/WorkReportTaskMonitorProvider";
import { useWorkReportTaskMonitorContext } from "../../src/features/work-report/context/useWorkReportTaskMonitorContext";
import {
  bindRetryableEntryFieldMutationTask,
  getOrCreateRetryableEntryFieldMutation,
  listRetryableEntryFieldMutations,
} from "../../src/features/work-report/entryFieldTaskRetryStore";
import { createWorkReportOptimisticMutation } from "../../src/features/work-report/workReportOptimisticMutation";

declare global {
  interface Window {
    __workReportTaskConvergenceReady?: boolean;
    __workReportTaskConvergenceState?: {
      status: string | null;
      lifecycleState: string | null;
      optimisticState: string | null;
      retryCount: number;
    };
  }
}

function ConvergenceProbe() {
  const { createTaskMonitors, upsertCreateTaskMonitor } =
    useWorkReportTaskMonitorContext();
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const retryMutation = getOrCreateRetryableEntryFieldMutation({
      operation: "work-report-sort-order",
      formId: "901",
      entryId: "E-GLOBAL",
      value: 11,
      previousValue: 9,
      workOrderNo: "WO-GLOBAL",
    });
    bindRetryableEntryFieldMutationTask(
      retryMutation.operation,
      retryMutation.clientMutationId,
      "task-global",
      "2026-08-31T00:00:00.000Z"
    );
    upsertCreateTaskMonitor({
      taskId: "task-global",
      kind: "update",
      formId: "901",
      entryId: "E-GLOBAL",
      workOrderNo: "WO-GLOBAL",
      status: "pending",
      lifecycleState: "accepted",
      acceptedAt: "2026-08-31T00:00:00.000Z",
      confirmedAt: null,
      entryFieldOperation: "work-report-sort-order",
      message: "排序碼已排入更新佇列。",
      updatedAt: "2026-08-31T00:00:00.000Z",
      optimisticMutation: createWorkReportOptimisticMutation({
        taskId: "task-global",
        mutationId: retryMutation.clientMutationId,
        operation: "work-report-sort-order",
        target: {
          domain: "work-report",
          formId: "901",
          entryId: "E-GLOBAL",
        },
        acceptedAt: "2026-08-31T00:00:00.000Z",
        reconcilePolicy: "replace-target",
        failurePolicy: "rollback",
        previousSnapshot: { sortOrder: 9 },
        patch: { kind: "update-entry", patch: { sortOrder: 11 } },
      }),
    });
    window.__workReportTaskConvergenceReady = true;
  }, [upsertCreateTaskMonitor]);

  useEffect(() => {
    const monitor = createTaskMonitors.find(
      (item) => item.taskId === "task-global"
    );
    window.__workReportTaskConvergenceState = {
      status: monitor?.status ?? null,
      lifecycleState: monitor?.lifecycleState ?? null,
      optimisticState:
        monitor?.optimisticMutation?.lifecycle.optimisticState ?? null,
      retryCount: listRetryableEntryFieldMutations("901").length,
    };
  }, [createTaskMonitors]);

  return <div data-testid="surface">detail-without-list-controller</div>;
}

export function mountWorkReportTaskMonitorConvergence(container: Element) {
  createRoot(container).render(
    <WorkReportTaskMonitorProvider>
      <ConvergenceProbe />
    </WorkReportTaskMonitorProvider>
  );
}
