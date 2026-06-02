import { useCallback, useEffect, useMemo, useState } from "react";
import { Drawer, Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  createReportAccepted,
  fetchWorkReportQueueTasks,
  updateReportAccepted,
  type CreateReportTaskAcceptedResult,
  type WorkReportQueueTask,
  type WorkReportQueueTaskStatus,
  type WorkReportQueueTaskType,
} from "../../../api/workReport";
import { getOrCreateClientId } from "../debug/clientIdentity";
import { formatStatusDateTime } from "../utils";
import {
  createRetryClientMutationId,
  getRetryableMutationRecord,
  replaceRetryableMutationRecord,
} from "../taskRetryStore";
import { getRetryableBatchCreateRecord } from "../taskBatchRetryStore";
import { retryBatchCreateFromRecord } from "../retryBatchCreate";

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
  formId: string | null;
  entryId: string | null;
  workOrderNo?: string | null;
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
  taskType: WorkReportQueueTaskType,
  t: (key: string) => string
): string {
  if (taskType === "create-report") {
    return t("workReport:taskQueue.taskTypes.create");
  }
  if (taskType === "update-report") {
    return t("workReport:taskQueue.taskTypes.update");
  }
  if (taskType === "create-report-batch") {
    return t("workReport:taskQueue.taskTypes.createBatch");
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
  status: WorkReportQueueTaskStatus,
  t: (key: string) => string
): string {
  if (status === "pending") {
    return t("workReport:taskQueue.status.pending");
  }
  if (status === "running") {
    return t("workReport:taskQueue.status.running");
  }
  if (status === "success") {
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
  formId,
  entryId,
  workOrderNo,
  onRetryAccepted,
  onClose,
}: WorkReportTaskQueueDrawerProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const navigate = useNavigate();
  const actorClientId = useMemo(() => getOrCreateClientId(), []);
  const [scope, setScope] = useState<TaskQueueScope>("entry");
  const [onlyFailed, setOnlyFailed] = useState<boolean>(false);
  const [tasks, setTasks] = useState<WorkReportQueueTask[]>([]);
  const [loading, setLoading] = useState(false);
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
    if (!open) {
      return;
    }
    setScope("entry");
    setOnlyFailed(false);
  }, [open, entryId]);

  const displayedTasks = useMemo(
    () => (onlyFailed ? tasks.filter((task) => task.status === "failed") : tasks),
    [tasks, onlyFailed]
  );

  const loadTasks = useCallback(async () => {
    if (!open || !formId) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const nextTasks = await fetchWorkReportQueueTasks(
        formId,
        getTaskScopeQuery(scope, {
          entryId,
          actorClientId,
        })
      );
      setTasks(nextTasks);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [actorClientId, entryId, formId, open, scope]);

  const canRetryTask = useCallback(
    (task: WorkReportQueueTask): boolean => {
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
        return Boolean(retryRecord && !retryRecord.latestRetryTaskId);
      }
      if (isRetryableBatchCreateTaskType(task.taskType)) {
        const retryRecord = getRetryableBatchCreateRecord(task.taskId);
        return Boolean(retryRecord && !retryRecord.latestRetryTaskId);
      }
      return false;
    },
    [actorClientId, entryId]
  );

  const getTaskRetryHint = useCallback(
    (task: WorkReportQueueTask): string | null => {
      if (task.status !== "failed") {
        return null;
      }

      if (task.taskType === "sync") {
        return t("workReport:taskQueue.retryHints.syncUnavailable");
      }
      if (task.taskType === "callback-refresh") {
        return t("workReport:taskQueue.retryHints.callbackUnavailable");
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
        if (!retryRecord) {
          return t("workReport:taskQueue.retryHints.missingLocalPayload");
        }
        if (retryRecord.latestRetryTaskId) {
          return t("workReport:taskQueue.retryHints.alreadyRetried");
        }
        return t("workReport:taskQueue.retryHints.retryAvailable");
      }

      if (isRetryableBatchCreateTaskType(task.taskType)) {
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
    [actorClientId, entryId, t]
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

  useEffect(() => {
    if (!open || !formId) {
      return;
    }

    void loadTasks();

    const timer = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      void loadTasks();
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, [formId, loadTasks, open]);

  return (
    <Drawer
      title={t("workReport:taskQueue.title")}
      placement="right"
      width={460}
      open={open}
      onClose={onClose}
      className="work-report-task-queue-drawer"
      extra={
        <button
          type="button"
          className="detail-task-queue-refresh-btn"
          onClick={() => void loadTasks()}
          disabled={loading}
        >
          {t("common:actions.refresh")}
        </button>
      }
    >
      <div className="detail-task-queue-panel">
        <div className="detail-task-queue-scope-group" role="tablist" aria-label={t("workReport:taskQueue.scopeLabel")}>
          <button
            type="button"
            className={scope === "entry" ? "is-active" : ""}
            onClick={() => setScope("entry")}
          >
            {t("workReport:taskQueue.scope.entry")}
          </button>
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

        {actionNotice ? (
          <p className="state success">{actionNotice}</p>
        ) : null}

        {loading && tasks.length === 0 ? (
          <p className="state">{t("common:states.loadingData")}</p>
        ) : error ? (
          <p className="state error">{error}</p>
        ) : displayedTasks.length === 0 ? (
          <p className="state">{t("workReport:taskQueue.empty")}</p>
        ) : (
          <div className="detail-task-queue-list" role="list">
            {displayedTasks.map((task) => {
              const retryMeta = retryMetadataByTaskId[task.taskId] ?? null;
              const retryFromTaskId = retryMeta?.retriedFromTaskId ?? null;
              const latestRetryTaskId = retryMeta?.latestRetryTaskId ?? null;
              const canRetry = canRetryTask(task);
              const retryHint = getTaskRetryHint(task);
              return (
                <article
                  key={task.taskId}
                  className={`detail-task-queue-item is-${task.status}`}
                  role="listitem"
                >
                  <div className="detail-task-queue-item-head">
                    <div className="detail-task-queue-item-primary">
                      <strong>{task.taskId}</strong>
                      <span>{getTaskTypeLabel(task.taskType, t)}</span>
                    </div>
                    <span className={`detail-task-queue-status-badge is-${task.status}`}>
                      {getTaskStatusLabel(task.status, t)}
                    </span>
                  </div>

                  <div className="detail-task-queue-item-meta">
                    <span>
                      {t("workReport:filters.workOrderNo")}: {task.workOrderNo ?? workOrderNo ?? "--"}
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
                    {task.errorMessage || task.message || "--"}
                  </div>
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
