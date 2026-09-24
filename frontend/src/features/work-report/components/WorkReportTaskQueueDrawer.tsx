import { useCallback, useEffect, useMemo, useState } from "react";
import { Drawer, Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  createReportAccepted,
  updateReportAccepted,
  type CreateReportTaskAcceptedResult,
  type WorkReportQueueTask,
  type WorkReportQueueTaskStatus,
  type WorkReportQueueTaskType,
} from "../../../api/workReport";
import { getOrCreateClientId } from "../../../utils/clientIdentity";
import { formatStatusDateTime, getWorkReportTaskErrorMessage } from "../utils";
import {
  createRetryClientMutationId,
  getRetryableMutationRecord,
  replaceRetryableMutationRecord,
} from "../taskRetryStore";
import {
  isCreateMutationWriteIndeterminate,
  isEntryLevelUpdateWithoutRetryPayload,
} from "../mutationRetrySemantics";
import {
  deleteRetryableBatchCreateRecordChain,
  getRetryableBatchCreateRecord,
} from "../taskBatchRetryStore";
import { getBatchCreateRetryBlockReason, retryBatchCreateFromRecord } from "../retryBatchCreate";
import { useTaskQueueQuery } from "../hooks/useTaskQueueQuery";
import {
  getBatchTaskProgress,
  isMutationQueueTask,
  summarizeTaskQueue,
} from "../taskQueuePresentation";

type TaskQueueScope = "entry" | "mine" | "all" | "failed" | "created-all";

const CREATED_TASK_TYPES: WorkReportQueueTaskType[] = [
  "create-report",
  "create-report-batch",
];

function isCreatedTaskType(taskType: WorkReportQueueTaskType): boolean {
  return CREATED_TASK_TYPES.includes(taskType);
}

function collectCreatedRowIds(task: WorkReportQueueTask): string[] {
  if (task.taskType === "create-report-batch") {
    return Array.isArray(task.batchCreatedRowIds) ? task.batchCreatedRowIds : [];
  }
  if (task.taskType === "create-report") {
    return task.rowId ? [task.rowId] : [];
  }
  return [];
}

interface WorkReportTaskQueueDrawerProps {
  open: boolean;
  context?: "entry" | "list";
  formId: string | null;
  entryId: string | null;
  workOrderNo?: string | null;
  refreshToken?: number;
  onRetryAccepted?: (
    kind: "create" | "update",
    accepted: CreateReportTaskAcceptedResult,
    rowId?: string
  ) => Promise<void>;
  onClose: () => void;
}

function getTaskScopeQuery(
  scope: TaskQueueScope,
  options: {
    entryId: string | null;
    actorClientId: string;
  }
): {
  entryId?: string;
  status?: WorkReportQueueTaskStatus;
  taskType?: WorkReportQueueTaskType;
  taskTypes?: WorkReportQueueTaskType[];
  actorClientId?: string;
  limit: number;
} {
  if (scope === "entry" && options.entryId) {
    return {
      entryId: options.entryId,
      limit: 50,
    };
  }

  if (scope === "mine") {
    return {
      actorClientId: options.actorClientId,
      limit: 50,
    };
  }

  if (scope === "failed") {
    return {
      status: "failed",
      limit: 50,
    };
  }

  if (scope === "created-all") {
    return {
      taskTypes: CREATED_TASK_TYPES,
      limit: 100,
    };
  }

  return {
    limit: 50,
  };
}

function getTaskTypeLabel(
  task: WorkReportQueueTask,
  t: (key: string) => string
): string {
  if (task.operationKind === "update-sort-order") {
    return t("workReport:taskQueue.taskTypes.updateSortOrder");
  }
  if (task.operationKind === "update-start-schedule") {
    return t("workReport:taskQueue.taskTypes.updateStartSchedule");
  }
  if (task.operationKind === "update-main-machine") {
    return t("workReport:taskQueue.taskTypes.updateMainMachine");
  }
  if (task.operationKind === "update-urgent") {
    return t("workReport:taskQueue.taskTypes.updateUrgent");
  }
  if (task.operationKind === "update-planned-end-date") {
    return t("workReport:taskQueue.taskTypes.updatePlannedEndDate");
  }
  if (task.operationKind === "close-work-order") {
    return t("workReport:taskQueue.taskTypes.closeWorkOrder");
  }
  if (task.operationKind === "reopen-work-order") {
    return t("workReport:taskQueue.taskTypes.reopenWorkOrder");
  }
  const taskType = task.taskType;
  if (taskType === "create-report") {
    return t("workReport:taskQueue.taskTypes.create");
  }
  if (taskType === "update-report") {
    return t("workReport:taskQueue.taskTypes.update");
  }
  if (taskType === "create-report-batch") {
    return t("workReport:taskQueue.taskTypes.createBatch");
  }
  if (taskType === "delete-report") {
    return t("workReport:taskQueue.taskTypes.delete");
  }
  if (taskType === "delete-report-batch") {
    return t("workReport:taskQueue.taskTypes.deleteBatch");
  }
  if (taskType === "sync") {
    return t("workReport:taskQueue.taskTypes.sync");
  }
  return t("workReport:taskQueue.taskTypes.callback");
}

function getTaskStatusLabel(
  task: WorkReportQueueTask,
  t: (key: string) => string
): string {
  if (isMutationQueueTask(task)) {
    if (task.status === "pending") {
      return t("workReport:taskQueue.status.waitingWrite");
    }
    if (task.status === "running") {
      return task.taskType === "delete-report" || task.taskType === "delete-report-batch"
        ? t("workReport:taskQueue.status.deleting")
        : t("workReport:taskQueue.status.writing");
    }
    if (task.status === "success") {
      return task.taskType === "delete-report" || task.taskType === "delete-report-batch"
        ? t("workReport:taskQueue.status.deleted")
        : t("workReport:taskQueue.status.written");
    }
    return t("workReport:taskQueue.status.needsAttention");
  }
  if (task.status === "pending") {
    return t("workReport:taskQueue.status.pending");
  }
  if (task.status === "running") {
    return t("workReport:taskQueue.status.running");
  }
  if (task.status === "success") {
    return t("workReport:taskQueue.status.success");
  }
  return t("workReport:taskQueue.status.failed");
}

function formatTaskActor(task: WorkReportQueueTask): string {
  const parts = [
    task.actorLabel,
    task.actorClientId ? `client ${task.actorClientId.slice(-8)}` : null,
    task.actorTabId ? `tab ${task.actorTabId.slice(-8)}` : null,
    task.actorIp,
  ].filter((value): value is string => Boolean(value));

  if (parts.length === 0) {
    return "--";
  }
  return parts.join(" · ");
}

function isRetryableMutationTaskType(taskType: WorkReportQueueTaskType): boolean {
  return taskType === "create-report" || taskType === "update-report";
}

function isRetryableBatchCreateTaskType(taskType: WorkReportQueueTaskType): boolean {
  return taskType === "create-report-batch";
}

export function WorkReportTaskQueueDrawer({
  open,
  context = "entry",
  formId,
  entryId,
  workOrderNo,
  refreshToken,
  onRetryAccepted,
  onClose,
}: WorkReportTaskQueueDrawerProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const navigate = useNavigate();
  const actorClientId = useMemo(() => getOrCreateClientId(), []);
  const [scope, setScope] = useState<TaskQueueScope>(() =>
    context === "list" ? "mine" : "entry"
  );
  const [onlyFailed, setOnlyFailed] = useState<boolean>(false);
  const query = useMemo(
    () => getTaskScopeQuery(scope, { entryId, actorClientId }),
    [actorClientId, entryId, scope]
  );
  const { tasks, hasLoaded, loading, error: loadError, loadTasks } = useTaskQueueQuery({
    open,
    formId,
    query,
    refreshToken,
  });
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [expandedRowListTaskIds, setExpandedRowListTaskIds] = useState<Set<string>>(
    () => new Set()
  );
  // Poll 由 module-level batchRetryPollManager 處理，不綁 drawer 生命週期
  // 關 drawer / 切頁都不中止，poll 會跑到 task 結束或 2 分鐘 timeout

  const toggleTaskRowListExpanded = useCallback((taskId: string) => {
    setExpandedRowListTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const handleNavigateToRow = useCallback(
    (task: WorkReportQueueTask, rowId: string) => {
      if (!task.formId || !task.entryId) {
        return;
      }
      onClose();
      navigate(`/reports/${task.formId}/${task.entryId}`, {
        state: { highlightRowId: rowId },
      });
    },
    [navigate, onClose]
  );
  const retryMetadataByTaskId = useMemo(() => {
    return Object.fromEntries(
      tasks.map((task) => [
        task.taskId,
        getRetryableMutationRecord(task.taskId) ?? getRetryableBatchCreateRecord(task.taskId),
      ])
    ) as Record<
      string,
      ReturnType<typeof getRetryableMutationRecord> | ReturnType<typeof getRetryableBatchCreateRecord>
    >;
  }, [tasks]);

  useEffect(() => {
    setScope(context === "list" ? "mine" : "entry");
    setOnlyFailed(false);
    setError(null);
    setActionNotice(null);
  }, [context, formId, entryId]);

  const displayedTasks = useMemo(
    () => (onlyFailed ? tasks.filter((task) => task.status === "failed") : tasks),
    [tasks, onlyFailed]
  );
  const taskSummary = useMemo(() => summarizeTaskQueue(displayedTasks), [displayedTasks]);

  useEffect(() => {
    if (!open) {
      return;
    }
    for (const task of tasks) {
      if (
        task.taskType === "create-report-batch" &&
        task.status === "failed" &&
        getBatchCreateRetryBlockReason(task) &&
        getRetryableBatchCreateRecord(task.taskId)
      ) {
        deleteRetryableBatchCreateRecordChain(task.taskId);
      }
    }
  }, [open, tasks]);

  const canRetryTask = useCallback(
    (task: WorkReportQueueTask): boolean => {
      if (context === "list") {
        return false;
      }
      if (task.status !== "failed") {
        return false;
      }
      if (!entryId || task.entryId !== entryId) {
        return false;
      }
      if (!task.actorClientId || task.actorClientId !== actorClientId) {
        return false;
      }
      if (isRetryableMutationTaskType(task.taskType)) {
        const retryRecord = getRetryableMutationRecord(task.taskId);
        if (isEntryLevelUpdateWithoutRetryPayload(task, retryRecord?.rowId)) {
          return false;
        }
        if (isCreateMutationWriteIndeterminate(task)) {
          return false;
        }
        return Boolean(retryRecord && !retryRecord.latestRetryTaskId);
      }
      if (isRetryableBatchCreateTaskType(task.taskType)) {
        if (getBatchCreateRetryBlockReason(task)) {
          return false;
        }
        const retryRecord = getRetryableBatchCreateRecord(task.taskId);
        return Boolean(retryRecord && !retryRecord.latestRetryTaskId);
      }
      return false;
    },
    [actorClientId, context, entryId]
  );

  const getTaskRetryHint = useCallback(
    (task: WorkReportQueueTask): string | null => {
      if (task.status !== "failed") {
        return null;
      }
      if (context === "list") {
        return null;
      }

      if (task.taskType === "sync") {
        return t("workReport:taskQueue.retryHints.syncUnavailable");
      }
      if (task.taskType === "callback-refresh") {
        return t("workReport:taskQueue.retryHints.callbackUnavailable");
      }
      if (task.taskType === "delete-report") {
        return t("workReport:taskQueue.retryHints.deleteUnavailable");
      }
      if (task.taskType === "delete-report-batch") {
        return t("workReport:taskQueue.retryHints.deleteBatchUnavailable");
      }

      if (!entryId || task.entryId !== entryId) {
        return t("workReport:taskQueue.retryHints.otherEntry");
      }
      if (!task.actorClientId || task.actorClientId !== actorClientId) {
        return t("workReport:taskQueue.retryHints.otherDevice");
      }

      if (isRetryableMutationTaskType(task.taskType)) {
        const retryRecord = getRetryableMutationRecord(task.taskId);
        if (isEntryLevelUpdateWithoutRetryPayload(task, retryRecord?.rowId)) {
          return t("workReport:taskQueue.retryHints.entryUpdateUnavailable");
        }
        if (isCreateMutationWriteIndeterminate(task)) {
          return t("workReport:taskQueue.retryHints.createIndeterminateUnavailable");
        }
        if (!retryRecord) {
          return t("workReport:taskQueue.retryHints.missingLocalPayload");
        }
        if (retryRecord.latestRetryTaskId) {
          return t("workReport:taskQueue.retryHints.alreadyRetried");
        }
        return t("workReport:taskQueue.retryHints.retryAvailable");
      }

      if (isRetryableBatchCreateTaskType(task.taskType)) {
        const batchCreateRetryBlockReason = getBatchCreateRetryBlockReason(task);
        if (batchCreateRetryBlockReason === "indeterminate") {
          return t("workReport:taskQueue.retryHints.batchIndeterminateUnavailable");
        }
        if (batchCreateRetryBlockReason === "statusUnknown") {
          return t("workReport:taskQueue.retryHints.batchStatusUnknownUnavailable");
        }
        if (batchCreateRetryBlockReason === "precondition") {
          return t("workReport:taskQueue.retryHints.batchPreconditionUnavailable");
        }
        const retryRecord = getRetryableBatchCreateRecord(task.taskId);
        if (!retryRecord) {
          return t("workReport:taskQueue.retryHints.batchMissingLocalPayload");
        }
        if (retryRecord.latestRetryTaskId) {
          return t("workReport:taskQueue.retryHints.alreadyRetried");
        }
        return t("workReport:taskQueue.retryHints.batchRetryAvailable");
      }

      return t("workReport:taskQueue.retryHints.unsupported");
    },
    [actorClientId, context, entryId, t]
  );

  const showRetryConfirmModal = useCallback(
    (targetFormId: string, targetEntryId: string) => {
      Modal.confirm({
        title: t("workReport:taskQueue.retrySubmittedModal.title"),
        content: t("workReport:taskQueue.retrySubmittedModal.content"),
        okText: t("workReport:taskQueue.retrySubmittedModal.ok"),
        cancelText: t("workReport:taskQueue.retrySubmittedModal.cancel"),
        onOk: () => {
          onClose();
          navigate(`/reports/${targetFormId}/${targetEntryId}`);
        },
      });
    },
    [navigate, onClose, t]
  );

  const handleRetryTask = useCallback(
    async (task: WorkReportQueueTask) => {
      if (!formId) {
        return;
      }
      if (task.taskType === "create-report-batch") {
        const retryRecord = getRetryableBatchCreateRecord(task.taskId);
        if (!retryRecord) {
          setError(t("workReport:taskQueue.retryMissing"));
          return;
        }

        setRetryingTaskId(task.taskId);
        setError(null);
        setActionNotice(null);
        try {
          await retryBatchCreateFromRecord(retryRecord);
          await loadTasks();
          showRetryConfirmModal(retryRecord.formId, retryRecord.entryId);
        } catch (nextError) {
          const errorMessage = nextError instanceof Error ? nextError.message : String(nextError);
          setError(errorMessage);
          void message.error(errorMessage);
        } finally {
          setRetryingTaskId(null);
        }
        return;
      }

      const retryRecord = getRetryableMutationRecord(task.taskId);
      if (!retryRecord) {
        setError(t("workReport:taskQueue.retryMissing"));
        return;
      }

      setRetryingTaskId(task.taskId);
      setError(null);
      setActionNotice(null);
      try {
        if (isCreateMutationWriteIndeterminate(task)) {
          setError(t("workReport:taskQueue.retryHints.createIndeterminateUnavailable"));
          return;
        }
        const clientMutationId = createRetryClientMutationId();
        const accepted =
          retryRecord.kind === "update" && retryRecord.rowId
            ? await updateReportAccepted(
                retryRecord.formId,
                retryRecord.entryId,
                retryRecord.rowId,
                retryRecord.payload,
                {
                  clientMutationId,
                  workOrderNo: retryRecord.workOrderNo ?? workOrderNo ?? null,
                  expectedEntryLastUpdatedAt: retryRecord.expectedEntryLastUpdatedAt,
                  editSessionId: retryRecord.editSessionId,
                  editLockVersion: retryRecord.editLockVersion,
                }
              )
            : await createReportAccepted(
                retryRecord.formId,
                retryRecord.entryId,
                retryRecord.payload,
                {
                  clientMutationId,
                  createIdempotencyKey:
                    retryRecord.createIdempotencyKey ?? retryRecord.clientMutationId,
                  workOrderNo: retryRecord.workOrderNo ?? workOrderNo ?? null,
                  expectedEntryLastUpdatedAt: retryRecord.expectedEntryLastUpdatedAt,
                  editSessionId: retryRecord.editSessionId,
                  editLockVersion: retryRecord.editLockVersion,
                }
              );

        replaceRetryableMutationRecord(task.taskId, {
          ...retryRecord,
          taskId: accepted.taskId,
          retryRootTaskId: retryRecord.retryRootTaskId,
          retriedFromTaskId: task.taskId,
          clientMutationId,
          createIdempotencyKey:
            retryRecord.kind === "create"
              ? retryRecord.createIdempotencyKey ?? retryRecord.clientMutationId
              : undefined,
          createdAt: new Date().toISOString(),
        });
        await onRetryAccepted?.(
          retryRecord.kind === "update" ? "update" : "create",
          accepted,
          retryRecord.rowId
        );
        await loadTasks();
        showRetryConfirmModal(retryRecord.formId, retryRecord.entryId);
      } catch (nextError) {
        const errorMessage = nextError instanceof Error ? nextError.message : String(nextError);
        setError(errorMessage);
        void message.error(errorMessage);
      } finally {
        setRetryingTaskId(null);
      }
    },
    [formId, loadTasks, onRetryAccepted, showRetryConfirmModal, t, workOrderNo]
  );

  return (
    <Drawer
      title={t("workReport:taskQueue.title")}
      placement="right"
      size={460}
      open={open}
      onClose={onClose}
      className="work-report-task-queue-drawer"
      extra={
        <button
          type="button"
          className="detail-task-queue-refresh-btn"
          onClick={() => {
            setError(null);
            void loadTasks();
          }}
          disabled={loading}
          aria-busy={loading}
        >
          {loading && hasLoaded ? t("workReport:taskQueue.refreshing") : t("common:actions.refresh")}
        </button>
      }
    >
      <div className="detail-task-queue-panel">
        <div className="detail-task-queue-guidance" role="status">
          {taskSummary.activeCount > 0
            ? t("workReport:taskQueue.guidance.active")
            : t("workReport:taskQueue.guidance.idle")}
        </div>

        <div className="detail-task-queue-scope-group" role="tablist" aria-label={t("workReport:taskQueue.scopeLabel")}>
          {context === "entry" ? (
            <button
              type="button"
              className={scope === "entry" ? "is-active" : ""}
              onClick={() => setScope("entry")}
            >
              {t("workReport:taskQueue.scope.entry")}
            </button>
          ) : null}
          <button
            type="button"
            className={scope === "mine" ? "is-active" : ""}
            onClick={() => setScope("mine")}
          >
            {t("workReport:taskQueue.scope.mine")}
          </button>
          <button
            type="button"
            className={scope === "all" ? "is-active" : ""}
            onClick={() => setScope("all")}
          >
            {t("workReport:taskQueue.scope.all")}
          </button>
          <button
            type="button"
            className={scope === "failed" ? "is-active" : ""}
            onClick={() => setScope("failed")}
          >
            {t("workReport:taskQueue.scope.failed")}
          </button>
          <button
            type="button"
            className={scope === "created-all" ? "is-active" : ""}
            onClick={() => setScope("created-all")}
          >
            {t("workReport:taskQueue.scope.createdAll")}
          </button>
        </div>

        <label className="detail-task-queue-only-failed">
          <input
            type="checkbox"
            checked={onlyFailed}
            onChange={(event) => setOnlyFailed(event.target.checked)}
          />
          <span>{t("workReport:taskQueue.onlyFailed")}</span>
        </label>

        {displayedTasks.length > 0 ? (
          <div className="detail-task-queue-summary" aria-label={t("workReport:taskQueue.summary.label")}>
            {taskSummary.activeCount > 0 ? (
              <span className="is-active">
                {t("workReport:taskQueue.summary.active", { count: taskSummary.activeCount })}
              </span>
            ) : null}
            {taskSummary.successCount > 0 ? (
              <span className="is-success">
                {t("workReport:taskQueue.summary.success", { count: taskSummary.successCount })}
              </span>
            ) : null}
            {taskSummary.failedCount > 0 ? (
              <span className="is-failed">
                {t("workReport:taskQueue.summary.failed", { count: taskSummary.failedCount })}
              </span>
            ) : null}
          </div>
        ) : null}

        {actionNotice ? (
          <p className="state success">{actionNotice}</p>
        ) : null}

        {error || loadError ? (
          <p className="state error" role="alert">{error || loadError}</p>
        ) : null}

        {loading && !hasLoaded ? (
          <p className="state">{t("common:states.loadingData")}</p>
        ) : !hasLoaded && loadError ? null : displayedTasks.length === 0 ? (
          <p className="state">{t("workReport:taskQueue.empty")}</p>
        ) : (
          <div className="detail-task-queue-list" role="list">
            {displayedTasks.map((task) => {
              const retryMeta = retryMetadataByTaskId[task.taskId] ?? null;
              const retryFromTaskId = retryMeta?.retriedFromTaskId ?? null;
              const latestRetryTaskId = retryMeta?.latestRetryTaskId ?? null;
              const canRetry = canRetryTask(task);
              const retryHint = getTaskRetryHint(task);
              const batchProgress = getBatchTaskProgress(task);
              return (
                <article
                  key={task.taskId}
                  className={`detail-task-queue-item is-${task.status}`}
                  role="listitem"
                >
                  <div className="detail-task-queue-item-head">
                    <div className="detail-task-queue-item-primary">
                      <strong>{getTaskTypeLabel(task, t)}</strong>
                      <span>
                        {t("workReport:filters.workOrderNo")}: {task.workOrderNo ?? workOrderNo ?? "--"}
                      </span>
                    </div>
                    <span className={`detail-task-queue-status-badge is-${task.status}`}>
                      {getTaskStatusLabel(task, t)}
                    </span>
                  </div>

                  <div className="detail-task-queue-item-meta">
                    <span>
                      {t("workReport:taskQueue.fields.taskId")}: <span title={task.taskId}>{task.taskId.slice(0, 8)}</span>
                    </span>
                    {retryFromTaskId ? (
                      <span>
                        {t("workReport:taskQueue.fields.retryFrom")}: {retryFromTaskId}
                      </span>
                    ) : null}
                    {latestRetryTaskId ? (
                      <span>
                        {t("workReport:taskQueue.fields.retrySubmittedAs")}: {latestRetryTaskId}
                      </span>
                    ) : null}
                    <span>{t("workReport:taskQueue.fields.createdAt")}: {formatStatusDateTime(task.createdAt)}</span>
                    <span>{t("workReport:taskQueue.fields.finishedAt")}: {formatStatusDateTime(task.finishedAt)}</span>
                    <span>{t("workReport:taskQueue.fields.actor")}: {formatTaskActor(task)}</span>
                    {task.source ? (
                      <span>{t("workReport:taskQueue.fields.eventSource")}: {task.source}</span>
                    ) : null}
                  </div>

                  <div className="detail-task-queue-item-message">
                    {getWorkReportTaskErrorMessage(task) || task.message || "--"}
                  </div>
                  {task.status === "failed" && task.operationKind === "update-main-machine" && task.mainMachineVerification ? (
                    <div className="detail-task-queue-item-meta">
                      <span>{t("workReport:taskQueue.fields.targetMachine")}: {task.mainMachineVerification.expectedMachineCode}</span>
                      <span>{t("workReport:taskQueue.fields.readBackMachine")}: {task.mainMachineVerification.confirmedMachineCode ?? t("workReport:taskQueue.fields.notReadBack")}</span>
                    </div>
                  ) : null}
                  {batchProgress ? (
                    <div className="detail-task-queue-progress">
                      <div className="detail-task-queue-progress-head">
                        <span>
                          {t("workReport:taskQueue.progress.label", {
                            processed: batchProgress.processedCount,
                            total: batchProgress.requestedCount,
                          })}
                        </span>
                        <span>{batchProgress.percent}%</span>
                      </div>
                      <div
                        className="detail-task-queue-progress-track"
                        role="progressbar"
                        aria-label={t("workReport:taskQueue.progress.ariaLabel")}
                        aria-valuemin={0}
                        aria-valuemax={batchProgress.requestedCount}
                        aria-valuenow={batchProgress.processedCount}
                      >
                        <span style={{ width: `${batchProgress.percent}%` }} />
                      </div>
                      <div className="detail-task-queue-progress-detail">
                        <span>
                          {t("workReport:taskQueue.progress.created", {
                            count: batchProgress.createdCount,
                          })}
                        </span>
                        {batchProgress.failedCount > 0 ? (
                          <span className="is-failed">
                            {t("workReport:taskQueue.progress.failed", {
                              count: batchProgress.failedCount,
                            })}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {isCreatedTaskType(task.taskType) ? (() => {
                    const createdRowIds = collectCreatedRowIds(task);
                    if (createdRowIds.length === 0) {
                      return null;
                    }
                    const isExpanded = expandedRowListTaskIds.has(task.taskId);
                    return (
                      <div className="detail-task-queue-item-rows">
                        <button
                          type="button"
                          className="detail-task-queue-rows-toggle"
                          onClick={() => toggleTaskRowListExpanded(task.taskId)}
                          aria-expanded={isExpanded}
                        >
                          {t("workReport:taskQueue.createdRows.summary", {
                            count: createdRowIds.length,
                          })}
                          <span aria-hidden="true">{isExpanded ? " ▲" : " ▼"}</span>
                        </button>
                        {isExpanded ? (
                          <ul className="detail-task-queue-rows-list">
                            {createdRowIds.map((createdRowId) => (
                              <li key={createdRowId}>
                                <button
                                  type="button"
                                  className="detail-task-queue-row-link"
                                  onClick={() => handleNavigateToRow(task, createdRowId)}
                                >
                                  rowId: {createdRowId}
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })() : null}
                  {retryHint ? (
                    <div
                      className={`detail-task-queue-item-note ${canRetry ? "is-actionable" : "is-muted"}`}
                    >
                      {retryHint}
                    </div>
                  ) : null}
                  {canRetry ? (
                    <div className="detail-task-queue-item-actions">
                      <button
                        type="button"
                        className="detail-task-queue-retry-btn"
                        onClick={() => void handleRetryTask(task)}
                        disabled={retryingTaskId === task.taskId}
                      >
                        {retryingTaskId === task.taskId
                          ? t("common:actions.saving")
                          : t("workReport:taskQueue.retry")}
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </Drawer>
  );
}
