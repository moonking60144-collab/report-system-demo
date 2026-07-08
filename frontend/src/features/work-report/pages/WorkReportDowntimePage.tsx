import { ReloadOutlined } from "@ant-design/icons";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import "../styles/work-report-downtime.css";
import { OperatorGroupFilter } from "../../../components/report-form/OperatorGroupFilter";
import {
  ALL_MACHINE_GROUP_KEY,
  buildMachineGroupOptions,
  filterMachineOptionsByGroup,
  readMachineGroupPreference,
  resolveMachineGroupPreference,
  writeMachineGroupPreference,
} from "../../../components/report-form/machineGroupPreferences";
import {
  ALL_OPERATOR_GROUP_KEY,
  buildOperatorGroupOptions,
  filterOperatorOptionsByGroup,
  readOperatorGroupPreference,
  resolveOperatorGroupPreference,
  writeOperatorGroupPreference,
} from "../../../components/report-form/operatorGroupPreferences";
import {
  ALL_PROCESS_GROUP_KEY,
  buildProcessGroupOptions,
  filterProcessOptionsByGroup,
  readProcessGroupPreference,
  resolveProcessGroupPreference,
  writeProcessGroupPreference,
} from "../../../components/report-form/processGroupPreferences";
import { Modal, message } from "antd";
import {
  createForm16DowntimeRecord,
  deleteForm16DowntimeRecord,
  exportForm16AnalysisXlsx,
  exportForm16DowntimeMonthlyCsv,
  fetchForm16DowntimeOptions,
  fetchForm16DowntimeRecords,
  fetchDowntimeTask,
  fetchDowntimeTasks,
  fetchPlannedIdleSummary,
  updateForm16DowntimeRecord,
  type CreateForm16DowntimePayload,
  type DowntimeQueueTask,
  type Form16DowntimeRecord,
  type PlannedIdleMachineSummary,
} from "../../../api/downtime";
import type {
  DowntimeEditDraft,
  DowntimeEditPickerKey,
} from "../components/WorkReportDowntimeRecordsTable";
import { EfficiencyStatsModal } from "../components/EfficiencyStatsModal";
import { CsvIcon, XlsxIcon } from "../components/ExportFileIcons";
import { RecordAuditHistoryModal } from "../components/RecordAuditHistoryModal";
import { pushFrontendEvent } from "../logging/frontendEventLog";
import type { FormOptionItem } from "../../../api/workReport";
import { DetailInlinePickerTrigger, DetailLinkedPickerModal } from "../components/DetailLinkedPicker";
import { WorkReportDowntimeRecordsTable } from "../components/WorkReportDowntimeRecordsTable";
import { PlannedIdleChart } from "../components/PlannedIdleChart";
import { useDowntimeMutationTask } from "../hooks/useDowntimeMutationTask";
import { inferReportTypeFromProcessCode } from "../../../components/report-form/form-logic/inference";
import {
  buildMachineStatusSuffix,
  isActiveMachineOption,
} from "../../../components/report-form/optionUtils";
import { getOrCreateClientId } from "../../../utils/clientIdentity";
import {
  createDowntimeClientRowKey,
  deleteRetryableDowntimeCreateRecordChain,
  getRetryableDowntimeCreateRecord,
  replaceRetryableDowntimeCreateRecord,
  saveRetryableDowntimeCreateRecord,
} from "../downtimeTaskRetryStore";
import {
  isDowntimeCreateQueueTask,
  isDowntimeTaskRunning,
  isRetryableDowntimeCreateTask,
} from "../downtimeTaskSemantics";
import type { NoticeState, UiLanguage, WorkReportFormId } from "../types";
import { getErrorMessage } from "../utils/errorUtils";
import { lastMonthInfo, triggerBlobDownload } from "../utils/exportDownload";


function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function buildRecentMonths(count: number): string[] {
  const now = new Date();
  const months: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
    months.push(`${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

interface DowntimeDraft {
  date: string;
  machineId: string;
  processCode: string;
  operatorId: string;
  plannedIdleMinutes: string;
  remark: string;
}

type DowntimePickerKey = "machineId" | "processCode" | "operatorId";
type DowntimePickerMode = "create" | "edit";

interface DowntimePickerState {
  key: DowntimePickerKey;
  mode: DowntimePickerMode;
  search: string;
}

interface DowntimePickerOption {
  value: string;
  display: string;
  group?: string;
  metaLines?: string[];
}

const DOWNTIME_PREFERENCE_FORM_ID: WorkReportFormId = "104";
const OPTIONAL_OPERATOR_CLEAR_TOKEN = "__downtime-operator-clear__";
const DOWNTIME_RECORDS_PAGE_SIZE = 20;
const DOWNTIME_TASK_POLL_INTERVAL_MS = 3000;
const DOWNTIME_TASK_POLL_TIMEOUT_MS = 180000;

function getTodayInputValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function createEmptyDraft(): DowntimeDraft {
  return {
    date: getTodayInputValue(),
    machineId: "",
    processCode: "",
    operatorId: "",
    plannedIdleMinutes: "480",
    remark: "",
  };
}

function buildMachineMetaLines(option: FormOptionItem): string[] {
  return [
    [option.machineDefault?.processCategoryCode, option.machineDefault?.processCategoryName]
      .filter(Boolean)
      .join(" "),
    option.machineDefault?.mainOperatorName
      ? `主要操作者: ${option.machineDefault.mainOperatorName}`
      : "",
    option.machineDefault?.processCode ? `子製程: ${option.machineDefault.processCode}` : "",
    option.machineDefault?.machineSpec ? `規格: ${option.machineDefault.machineSpec}` : "",
    option.machineDefault?.machineSpeed ? `分速: ${option.machineDefault.machineSpeed}` : "",
  ].filter(Boolean);
}

function matchesPickerSearch(option: DowntimePickerOption, keyword: string): boolean {
  if (!keyword) {
    return true;
  }
  const normalized = keyword.toLowerCase();
  return (
    option.value.toLowerCase().includes(normalized) ||
    option.display.toLowerCase().includes(normalized) ||
    option.metaLines?.some((line) => line.toLowerCase().includes(normalized)) === true
  );
}

function buildOptionMap(options: FormOptionItem[]): Map<string, FormOptionItem> {
  return new Map(options.map((item) => [item.value, item] as const));
}

function resolveDisplay(item: FormOptionItem | null | undefined): string {
  return String(item?.display ?? item?.label ?? item?.value ?? "").trim();
}

// create 跟 edit 共用同一個 draft shape
function validateDraft(
  draft: {
    date: string;
    machineId: string;
    processCode: string;
    plannedIdleMinutes: string;
  },
  t: (key: string, options?: Record<string, unknown>) => string
): string | null {
  if (!draft.date.trim()) {
    return t("workReport:reportForm.validation.requiredField", {
      field: t("workReport:reportForm.fields.dateRequired"),
    });
  }
  if (!draft.machineId.trim()) {
    return t("workReport:reportForm.validation.requiredField", {
      field: t("workReport:reportForm.fields.machineRequired"),
    });
  }
  if (!draft.processCode.trim()) {
    return t("workReport:reportForm.validation.requiredField", {
      field: t("workReport:reportForm.fields.subProcess"),
    });
  }
  if (draft.plannedIdleMinutes.trim()) {
    const parsed = Number(draft.plannedIdleMinutes);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return t("workReport:reportForm.validation.invalidReasonMinute", {
        field: t("workReport:downtimePage.fields.plannedIdleMinutes"),
      });
    }
  }
  return null;
}

function formatDowntimeTaskTime(value: string | null | undefined): string {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function buildAcceptedDowntimeTask(
  accepted: { taskId: string; status: DowntimeQueueTask["status"]; createdAt?: string },
  actorClientId: string,
  messageText: string
): DowntimeQueueTask {
  const createdAt = accepted.createdAt ?? new Date().toISOString();
  return {
    taskId: accepted.taskId,
    taskType: "create-downtime",
    status: accepted.status,
    formId: "16",
    workOrderNo: null,
    entryId: null,
    rowId: null,
    queueKey: "16:downtime:create",
    createdAt,
    startedAt: null,
    finishedAt: null,
    updatedAt: createdAt,
    message: messageText,
    errorCode: null,
    errorMessage: null,
    actorClientId,
    actorTabId: null,
    actorIp: null,
    actorLabel: null,
    source: null,
  };
}

function getDowntimeTaskDisplayMessage(task: DowntimeQueueTask): string {
  return String(task.errorMessage ?? task.message ?? "").trim();
}

export function WorkReportDowntimePage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation(["workReport", "common"]);
  const actorClientId = useMemo(() => getOrCreateClientId(), []);
  const [draft, setDraft] = useState<DowntimeDraft>(() => createEmptyDraft());
  const [autofilledFieldKeys, setAutofilledFieldKeys] = useState<string[]>([]);
  const [records, setRecords] = useState<Form16DowntimeRecord[]>([]);
  const [recordsTotalCount, setRecordsTotalCount] = useState(0);
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsPageSize, setRecordsPageSize] = useState(DOWNTIME_RECORDS_PAGE_SIZE);
  const [machineOptions, setMachineOptions] = useState<FormOptionItem[]>([]);
  const [processOptions, setProcessOptions] = useState<FormOptionItem[]>([]);
  const [operatorOptions, setOperatorOptions] = useState<FormOptionItem[]>([]);
  const [pickerState, setPickerState] = useState<DowntimePickerState | null>(null);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [editingRecordSnapshotHash, setEditingRecordSnapshotHash] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<DowntimeEditDraft | null>(null);
  const [editBusyRecordId, setEditBusyRecordId] = useState<string | null>(null);
  const [deletingRecordId, setDeletingRecordId] = useState<string | null>(null);
  const [auditHistoryOpen, setAuditHistoryOpen] = useState(false);
  const [machineGroupOverride, setMachineGroupOverride] = useState<string | null>(null);
  const [processGroupOverride, setProcessGroupOverride] = useState<string | null>(null);
  const [operatorGroupOverride, setOperatorGroupOverride] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [refreshingRecords, setRefreshingRecords] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingAnalysis, setExportingAnalysis] = useState(false);
  const [analysisDaysOpen, setAnalysisDaysOpen] = useState(false);
  const [analysisDays, setAnalysisDays] = useState<string>("");
  const [efficiencyStatsOpen, setEfficiencyStatsOpen] = useState(false);
  const [chartMonth, setChartMonth] = useState(() => currentYearMonth());
  const [chartMachines, setChartMachines] = useState<PlannedIdleMachineSummary[]>([]);
  const [chartResolvedMonth, setChartResolvedMonth] = useState("");
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartCollapsed, setChartCollapsed] = useState(false);
  const [downtimeTasks, setDowntimeTasks] = useState<DowntimeQueueTask[]>([]);
  const [downtimeTasksLoading, setDowntimeTasksLoading] = useState(false);
  const [downtimeTasksError, setDowntimeTasksError] = useState<string | null>(null);
  const [retryingDowntimeTaskId, setRetryingDowntimeTaskId] = useState<string | null>(null);
  const [downtimeTaskSidebarCollapsed, setDowntimeTaskSidebarCollapsed] = useState(false);
  const hasRequestedInitialRecordsRef = useRef(false);
  const refreshPollTimerRef = useRef<number | null>(null);
  const trackingDowntimeTaskIdsRef = useRef<Set<string>>(new Set());
  const downtimeTaskPollingCancelledRef = useRef(false);
  useEffect(() => {
    return () => {
      if (refreshPollTimerRef.current !== null) {
        window.clearInterval(refreshPollTimerRef.current);
        refreshPollTimerRef.current = null;
      }
    };
  }, []);
  useEffect(() => {
    const trackedTaskIds = trackingDowntimeTaskIdsRef.current;
    downtimeTaskPollingCancelledRef.current = false;
    return () => {
      downtimeTaskPollingCancelledRef.current = true;
      trackedTaskIds.clear();
    };
  }, []);
  const deferredPickerSearch = useDeferredValue(pickerState?.search ?? "");
  const uiLanguage: UiLanguage =
    (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith("en") ? "en" : "zh";

  const setUiLanguage = useCallback(
    (nextLanguage: UiLanguage) => {
      void i18n.changeLanguage(nextLanguage === "en" ? "en" : "zh-TW");
    },
    [i18n]
  );

  const handleExportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const blob = await exportForm16DowntimeMonthlyCsv();
      // 後端 proxy 可能回 .csv 或 .xlsx，依實際內容型別決定副檔名
      const isXlsx = blob.type.includes("sheet") || blob.type.includes("excel");
      triggerBlobDownload(blob, `c1-6-${lastMonthInfo().label}.${isXlsx ? "xlsx" : "csv"}`);
      void message.success(t("workReport:downtimePage.messages.csvExported"));
    } catch (error) {
      void message.error(
        t("workReport:downtimePage.messages.csvExportFailed", {
          error: getErrorMessage(error),
        })
      );
    } finally {
      setExporting(false);
    }
  }, [t]);

  const openAnalysisDaysModal = useCallback(() => {
    setAnalysisDays(String(lastMonthInfo().weekdays));
    setAnalysisDaysOpen(true);
  }, []);

  const handleExportAnalysis = useCallback(async (attendanceDays?: number) => {
    setExportingAnalysis(true);
    try {
      const blob = await exportForm16AnalysisXlsx(attendanceDays);
      // 檔名用「上個月」標記，資料窗跟 CSV 匯出同一條發佈 view
      triggerBlobDownload(blob, `c1-6-分析表-${lastMonthInfo().label}.xlsx`);
      void message.success(t("workReport:downtimePage.messages.analysisExported"));
    } catch (error) {
      void message.error(
        t("workReport:downtimePage.messages.analysisExportFailed", {
          error: getErrorMessage(error),
        })
      );
    } finally {
      setExportingAnalysis(false);
    }
  }, [t]);

  const monthOptions = useMemo(() => buildRecentMonths(6), []);

  const loadChart = useCallback(
    async (month: string, refresh = false) => {
      setChartLoading(true);
      setChartError(null);
      try {
        const summary = await fetchPlannedIdleSummary(month, refresh);
        setChartMachines(summary.machines);
        setChartResolvedMonth(summary.month);
      } catch (error) {
        // 用 i18n.t（穩定 reference）而非 t：避免切語言時 loadChart 換身分、effect 重跑、重打一次全表掃的彙總請求
        setChartError(
          i18n.t("workReport:downtimePage.chart.loadFailed", { error: getErrorMessage(error) })
        );
        setChartMachines([]);
      } finally {
        setChartLoading(false);
      }
    },
    [i18n]
  );

  useEffect(() => {
    void loadChart(chartMonth);
  }, [chartMonth, loadChart]);

  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    try {
      const options = await fetchForm16DowntimeOptions();
      setMachineOptions(options.machineId ?? []);
      setProcessOptions(options.processCode ?? []);
      setOperatorOptions(options.operatorId ?? []);
    } catch (error) {
      setNotice({
        type: "error",
        message: t("workReport:messages.failedLoadFormOptions", {
          error: getErrorMessage(error),
        }),
      });
    } finally {
      setOptionsLoading(false);
    }
  }, [t]);

  const loadRecords = useCallback(
    async (
      mode: "initial" | "refresh" | "silent" = "silent",
      options?: {
        page?: number;
        pageSize?: number;
        refresh?: boolean;
      }
    ) => {
      const targetPage = options?.page ?? recordsPage;
      const targetPageSize = options?.pageSize ?? recordsPageSize;
      const offset = (targetPage - 1) * targetPageSize;

      if (mode === "refresh") {
        setRefreshingRecords(true);
      } else {
        setRecordsLoading(true);
      }

      try {
        const result = await fetchForm16DowntimeRecords({
          limit: targetPageSize,
          offset,
          refresh: options?.refresh ?? false,
        });
        startTransition(() => {
          setRecords(result.records);
          setRecordsTotalCount(result.meta.totalCount);
        });
        setRecordsLoaded(true);
        if (mode === "refresh" && result.meta.refreshed) {
          setNotice({
            type: "success",
            message: t("workReport:downtimePage.messages.recordsRefreshed"),
          });
          void message.success(t("workReport:downtimePage.messages.recordsRefreshed"));
        }
        if (result.meta.refreshTriggered && !result.meta.refreshed) {
          setNotice({
            type: "info",
            message: t("workReport:downtimePage.messages.recordsBackgroundSyncing"),
          });
        }
      } catch (error) {
        const errorMsg = t("workReport:messages.failedLoadDowntimeRecords", {
          error: getErrorMessage(error),
        });
        setNotice({ type: "error", message: errorMsg });
        if (mode === "refresh") {
          void message.error(errorMsg);
        }
      } finally {
        setRecordsLoading(false);
        setRefreshingRecords(false);
      }
    },
    [recordsPage, recordsPageSize, t]
  );

  const upsertDowntimeTaskState = useCallback((task: DowntimeQueueTask) => {
    setDowntimeTasks((previous) => {
      const next = [task, ...previous.filter((item) => item.taskId !== task.taskId)];
      return next
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, 20);
    });
  }, []);

  const reloadRecordsAfterDowntimeCreate = useCallback(async () => {
    if (recordsPage !== 1) {
      setRecordsPage(1);
      return;
    }
    await loadRecords("silent", {
      page: 1,
      pageSize: recordsPageSize,
    });
  }, [loadRecords, recordsPage, recordsPageSize]);

  const trackDowntimeTask = useCallback(
    (taskId: string) => {
      if (!taskId || trackingDowntimeTaskIdsRef.current.has(taskId)) {
        return;
      }
      trackingDowntimeTaskIdsRef.current.add(taskId);

      void (async () => {
        const startedAt = Date.now();
        let lastErrorMessage = "";

        try {
          while (
            !downtimeTaskPollingCancelledRef.current &&
            Date.now() - startedAt < DOWNTIME_TASK_POLL_TIMEOUT_MS
          ) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, DOWNTIME_TASK_POLL_INTERVAL_MS)
            );
            if (downtimeTaskPollingCancelledRef.current) {
              return;
            }

            try {
              const task = await fetchDowntimeTask(taskId);
              upsertDowntimeTaskState(task);
              if (isDowntimeTaskRunning(task.status)) {
                continue;
              }

              if (task.status === "success") {
                deleteRetryableDowntimeCreateRecordChain(task.taskId);
                const successMessage = t("workReport:downtimePage.tasks.success", {
                  entryId: task.entryId ?? "--",
                });
                setNotice({ type: "success", message: successMessage });
                void message.success(successMessage);
                await reloadRecordsAfterDowntimeCreate();
                return;
              }

              const errorMessage =
                getDowntimeTaskDisplayMessage(task) ||
                t("workReport:downtimePage.tasks.failedFallback");
              const failedMessage = t("workReport:downtimePage.tasks.failed", {
                error: errorMessage,
              });
              setNotice({ type: "error", message: failedMessage });
              void message.error(failedMessage);
              return;
            } catch (error) {
              lastErrorMessage = getErrorMessage(error);
            }
          }

          if (!downtimeTaskPollingCancelledRef.current) {
            const timeoutMessage = t("workReport:downtimePage.tasks.pollTimeout", {
              error: lastErrorMessage,
            });
            setNotice({ type: "error", message: timeoutMessage });
            void message.error(timeoutMessage);
          }
        } finally {
          trackingDowntimeTaskIdsRef.current.delete(taskId);
        }
      })();
    },
    [reloadRecordsAfterDowntimeCreate, t, upsertDowntimeTaskState]
  );

  const loadDowntimeTasks = useCallback(async () => {
    setDowntimeTasksLoading(true);
    setDowntimeTasksError(null);
    try {
      const tasks = await fetchDowntimeTasks({
        taskType: "create-downtime",
        actorClientId,
        limit: 20,
      });
      setDowntimeTasks(tasks);
      for (const task of tasks) {
        if (isDowntimeTaskRunning(task.status)) {
          trackDowntimeTask(task.taskId);
        }
        if (task.status === "success" && getRetryableDowntimeCreateRecord(task.taskId)) {
          deleteRetryableDowntimeCreateRecordChain(task.taskId);
        }
      }
    } catch (error) {
      setDowntimeTasksError(getErrorMessage(error));
    } finally {
      setDowntimeTasksLoading(false);
    }
  }, [actorClientId, trackDowntimeTask]);

  const refreshDowntimePageData = useCallback(() => {
    void loadOptions();
    void loadDowntimeTasks();
    void loadChart(chartMonth, true);
    void loadRecords("refresh", {
      page: recordsPage,
      pageSize: recordsPageSize,
      refresh: true,
    });

    // 背景 refresh 完成後 SQLite 才會更新，自動 polling reload。
    if (refreshPollTimerRef.current !== null) {
      window.clearInterval(refreshPollTimerRef.current);
    }
    let attempts = 0;
    refreshPollTimerRef.current = window.setInterval(() => {
      attempts += 1;
      if (attempts >= 6) {
        if (refreshPollTimerRef.current !== null) {
          window.clearInterval(refreshPollTimerRef.current);
          refreshPollTimerRef.current = null;
        }
        return;
      }
      void loadRecords("silent", {
        page: recordsPage,
        pageSize: recordsPageSize,
      });
      void loadDowntimeTasks();
    }, 5000);
  }, [
    chartMonth,
    loadChart,
    loadDowntimeTasks,
    loadOptions,
    loadRecords,
    recordsPage,
    recordsPageSize,
  ]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    void loadDowntimeTasks();
  }, [loadDowntimeTasks]);

  useEffect(() => {
    if (!notice) return;
    const ms = notice.type === "error" ? 10000 : 5000;
    const timer = window.setTimeout(() => setNotice(null), ms);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const mode = hasRequestedInitialRecordsRef.current ? "silent" : "initial";
    hasRequestedInitialRecordsRef.current = true;
    void loadRecords(mode, {
      page: recordsPage,
      pageSize: recordsPageSize,
    });
  }, [loadRecords, recordsPage, recordsPageSize]);

  useEffect(() => {
    if (autofilledFieldKeys.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setAutofilledFieldKeys([]);
    }, 1500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [autofilledFieldKeys]);

  // Group 清單只 build「使用中」機台的分類；否則會出現某 group 在下拉選項裡、但 picker 點進去空白的情況。
  const machineGroupOptions = useMemo(
    () => buildMachineGroupOptions(machineOptions.filter(isActiveMachineOption)),
    [machineOptions]
  );
  const processGroupOptions = useMemo(() => buildProcessGroupOptions(processOptions), [processOptions]);
  const operatorGroupOptions = useMemo(() => buildOperatorGroupOptions(operatorOptions), [operatorOptions]);
  const machineOptionMap = useMemo(() => buildOptionMap(machineOptions), [machineOptions]);
  const processOptionMap = useMemo(() => buildOptionMap(processOptions), [processOptions]);
  const operatorOptionMap = useMemo(() => buildOptionMap(operatorOptions), [operatorOptions]);

  const selectedMachineOption = useMemo(
    () => machineOptionMap.get(draft.machineId) ?? null,
    [draft.machineId, machineOptionMap]
  );
  const selectedProcessOption = useMemo(
    () => processOptionMap.get(draft.processCode) ?? null,
    [draft.processCode, processOptionMap]
  );
  const selectedOperatorOption = useMemo(
    () => operatorOptionMap.get(draft.operatorId) ?? null,
    [draft.operatorId, operatorOptionMap]
  );

  const resolvedMachineGroupKey = useMemo(
    () =>
      resolveMachineGroupPreference(
        machineGroupOptions,
        machineGroupOverride ?? readMachineGroupPreference(DOWNTIME_PREFERENCE_FORM_ID),
        selectedMachineOption?.machineDefault?.processCategoryCode
      ),
    [machineGroupOptions, machineGroupOverride, selectedMachineOption?.machineDefault?.processCategoryCode]
  );
  const resolvedProcessGroupKey = useMemo(
    () =>
      resolveProcessGroupPreference(
        processGroupOptions,
        processGroupOverride ?? readProcessGroupPreference(DOWNTIME_PREFERENCE_FORM_ID)
      ),
    [processGroupOptions, processGroupOverride]
  );
  const resolvedOperatorGroupKey = useMemo(
    () =>
      resolveOperatorGroupPreference(
        DOWNTIME_PREFERENCE_FORM_ID,
        operatorGroupOptions,
        operatorGroupOverride ?? readOperatorGroupPreference(DOWNTIME_PREFERENCE_FORM_ID)
      ),
    [operatorGroupOptions, operatorGroupOverride]
  );

  const selectedMachineGroupLabel = useMemo(
    () => machineGroupOptions.find((option) => option.key === resolvedMachineGroupKey)?.label ?? "",
    [machineGroupOptions, resolvedMachineGroupKey]
  );
  const selectedProcessGroupLabel = useMemo(
    () => processGroupOptions.find((option) => option.key === resolvedProcessGroupKey)?.label ?? "",
    [processGroupOptions, resolvedProcessGroupKey]
  );
  const selectedOperatorGroupLabel = useMemo(
    () => operatorGroupOptions.find((option) => option.key === resolvedOperatorGroupKey)?.label ?? "",
    [operatorGroupOptions, resolvedOperatorGroupKey]
  );

  const handleMachineGroupChange = useCallback((groupKey: string) => {
    setMachineGroupOverride(groupKey);
    writeMachineGroupPreference(DOWNTIME_PREFERENCE_FORM_ID, groupKey);
  }, []);

  const handleProcessGroupChange = useCallback((groupKey: string) => {
    setProcessGroupOverride(groupKey);
    writeProcessGroupPreference(DOWNTIME_PREFERENCE_FORM_ID, groupKey);
  }, []);

  const handleOperatorGroupChange = useCallback((groupKey: string) => {
    setOperatorGroupOverride(groupKey);
    writeOperatorGroupPreference(DOWNTIME_PREFERENCE_FORM_ID, groupKey);
  }, []);

  const currentPickerOption = useMemo<DowntimePickerOption | null>(() => {
    if (!pickerState) {
      return null;
    }

    const source = pickerState.mode === "edit" && editingDraft ? editingDraft : draft;
    const activeMachineOption = machineOptionMap.get(source.machineId) ?? null;
    const activeProcessOption = processOptionMap.get(source.processCode) ?? null;
    const activeOperatorOption = operatorOptionMap.get(source.operatorId) ?? null;

    if (pickerState.key === "machineId" && activeMachineOption) {
      // 當前值可能是報廢/售出機台，display 加狀態 suffix（跟 optionUtils 共用同一套規則）。
      // 這邊 resolveDisplay 走 display 欄（非 label），所以用 buildMachineStatusSuffix 對 display 追加。
      const statusSuffix = buildMachineStatusSuffix(activeMachineOption);
      return {
        value: activeMachineOption.value,
        display: `${resolveDisplay(activeMachineOption)}${statusSuffix}`,
        metaLines: buildMachineMetaLines(activeMachineOption),
      };
    }
    if (pickerState.key === "processCode" && activeProcessOption) {
      return {
        value: activeProcessOption.value,
        display: resolveDisplay(activeProcessOption),
        group:
          String(activeProcessOption.processGroupLabel ?? activeProcessOption.processGroupKey ?? "").trim() ||
          "其他",
      };
    }
    if (pickerState.key === "operatorId" && activeOperatorOption) {
      return {
        value: activeOperatorOption.value,
        display: resolveDisplay(activeOperatorOption),
      };
    }

    return null;
  }, [draft, editingDraft, machineOptionMap, operatorOptionMap, pickerState, processOptionMap]);

  // edit mode 強制 all 群組：使用者可能想挑原本群組以外的機台/製程/操作者，
  // 不該被建立區塊目前選的群組偏好限制
  const isEditPicker = pickerState?.mode === "edit";
  const effectiveMachineGroupKey = isEditPicker ? ALL_MACHINE_GROUP_KEY : resolvedMachineGroupKey;
  const effectiveProcessGroupKey = isEditPicker ? ALL_PROCESS_GROUP_KEY : resolvedProcessGroupKey;
  const effectiveOperatorGroupKey = isEditPicker ? ALL_OPERATOR_GROUP_KEY : resolvedOperatorGroupKey;

  const machinePickerBaseOptions = useMemo<DowntimePickerOption[]>(
    () =>
      filterMachineOptionsByGroup(machineOptions, effectiveMachineGroupKey)
        // 僅顯示「使用中」機台；停機紀錄用於效率計算，不該讓使用者新派到報廢/售出機台
        .filter(isActiveMachineOption)
        .map((item) => ({
          value: item.value,
          display: resolveDisplay(item),
          group:
            effectiveMachineGroupKey !== ALL_MACHINE_GROUP_KEY
              ? selectedMachineGroupLabel || undefined
              : undefined,
          metaLines: buildMachineMetaLines(item),
        })),
    [machineOptions, effectiveMachineGroupKey, selectedMachineGroupLabel]
  );
  const processPickerBaseOptions = useMemo<DowntimePickerOption[]>(
    () =>
      filterProcessOptionsByGroup(processOptions, effectiveProcessGroupKey).map((item) => ({
        value: item.value,
        display: resolveDisplay(item),
        group:
          effectiveProcessGroupKey !== ALL_PROCESS_GROUP_KEY
            ? selectedProcessGroupLabel || undefined
            : String(item.processGroupLabel ?? item.processGroupKey ?? "").trim() || "其他",
      })),
    [processOptions, effectiveProcessGroupKey, selectedProcessGroupLabel]
  );
  const operatorPickerBaseOptions = useMemo<DowntimePickerOption[]>(
    () => [
      {
        value: OPTIONAL_OPERATOR_CLEAR_TOKEN,
        display: t("workReport:downtimePage.actions.clearOperator"),
        group:
          effectiveOperatorGroupKey !== ALL_OPERATOR_GROUP_KEY
            ? selectedOperatorGroupLabel || undefined
            : undefined,
      },
      ...filterOperatorOptionsByGroup(operatorOptions, effectiveOperatorGroupKey).map((item) => ({
        value: item.value,
        display: resolveDisplay(item),
        group:
          effectiveOperatorGroupKey !== ALL_OPERATOR_GROUP_KEY
            ? selectedOperatorGroupLabel || undefined
            : undefined,
      })),
    ],
    [operatorOptions, effectiveOperatorGroupKey, selectedOperatorGroupLabel, t]
  );

  const pickerOptions = useMemo<DowntimePickerOption[]>(() => {
    if (!pickerState) {
      return [];
    }

    if (pickerState.key === "machineId") {
      return machinePickerBaseOptions.filter((option) =>
        matchesPickerSearch(option, deferredPickerSearch)
      );
    }

    if (pickerState.key === "processCode") {
      return processPickerBaseOptions.filter((option) =>
        matchesPickerSearch(option, deferredPickerSearch)
      );
    }

    return operatorPickerBaseOptions.filter((option) =>
      matchesPickerSearch(option, deferredPickerSearch)
    );
  }, [
    deferredPickerSearch,
    machinePickerBaseOptions,
    operatorPickerBaseOptions,
    pickerState,
    processPickerBaseOptions,
  ]);

  const pickerTopContent = useMemo(() => {
    if (!pickerState) {
      return null;
    }
    // edit mode 不顯示 group filter，避免使用者誤以為它會生效（實際選項已 force all）
    if (pickerState.mode === "edit") {
      return null;
    }

    if (pickerState.key === "machineId") {
      return (
        <OperatorGroupFilter
          className="detail-picker-group-filter"
          label={t("workReport:detailPage.machinePickerGroupLabel")}
          allLabel={t("common:options.all")}
          selectedGroupKey={resolvedMachineGroupKey}
          options={machineGroupOptions}
          onChange={handleMachineGroupChange}
        />
      );
    }
    if (pickerState.key === "processCode") {
      return (
        <OperatorGroupFilter
          className="detail-picker-group-filter"
          label={t("workReport:detailPage.processPickerGroupLabel")}
          allLabel={t("common:options.all")}
          selectedGroupKey={resolvedProcessGroupKey}
          options={processGroupOptions}
          onChange={handleProcessGroupChange}
        />
      );
    }
    return (
      <OperatorGroupFilter
        className="detail-picker-group-filter"
        label={t("workReport:detailPage.operatorPickerGroupLabel")}
        allLabel={t("common:options.all")}
        selectedGroupKey={resolvedOperatorGroupKey}
        options={operatorGroupOptions}
        onChange={handleOperatorGroupChange}
      />
    );
  }, [
    handleMachineGroupChange,
    handleOperatorGroupChange,
    handleProcessGroupChange,
    machineGroupOptions,
    operatorGroupOptions,
    pickerState,
    processGroupOptions,
    resolvedMachineGroupKey,
    resolvedOperatorGroupKey,
    resolvedProcessGroupKey,
    t,
  ]);

  const selectedPickerValue = useMemo(() => {
    if (!pickerState) {
      return "";
    }
    const source = pickerState.mode === "edit" && editingDraft ? editingDraft : draft;
    if (pickerState.key === "machineId") {
      return source.machineId;
    }
    if (pickerState.key === "processCode") {
      return source.processCode;
    }
    return source.operatorId;
  }, [draft, editingDraft, pickerState]);

  const downtimeUpdateTask = useDowntimeMutationTask();
  const downtimeDeleteTask = useDowntimeMutationTask();

  const getDowntimeTaskRetryHint = useCallback(
    (task: DowntimeQueueTask): string | null => {
      if (!isDowntimeCreateQueueTask(task)) {
        return t("workReport:downtimePage.tasks.retryHints.unsupported");
      }
      if (task.status !== "failed") {
        return null;
      }
      if (task.actorClientId && task.actorClientId !== actorClientId) {
        return t("workReport:downtimePage.tasks.retryHints.otherDevice");
      }
      const retryRecord = getRetryableDowntimeCreateRecord(task.taskId);
      if (!retryRecord || retryRecord.actorClientId !== actorClientId) {
        return t("workReport:downtimePage.tasks.retryHints.missingLocalPayload");
      }
      if (retryRecord.latestRetryTaskId) {
        return t("workReport:downtimePage.tasks.retryHints.alreadyRetried");
      }
      return t("workReport:downtimePage.tasks.retryHints.available");
    },
    [actorClientId, t]
  );

  const canRetryDowntimeTask = useCallback(
    (task: DowntimeQueueTask): boolean => {
      if (!isRetryableDowntimeCreateTask(task)) {
        return false;
      }
      if (task.actorClientId && task.actorClientId !== actorClientId) {
        return false;
      }
      const retryRecord = getRetryableDowntimeCreateRecord(task.taskId);
      return Boolean(
        retryRecord &&
          retryRecord.actorClientId === actorClientId &&
          !retryRecord.latestRetryTaskId
      );
    },
    [actorClientId]
  );

  const handleRetryDowntimeTask = useCallback(
    async (task: DowntimeQueueTask) => {
      if (!canRetryDowntimeTask(task)) {
        const hint =
          getDowntimeTaskRetryHint(task) ||
          t("workReport:downtimePage.tasks.retryHints.unsupported");
        void message.error(hint);
        return;
      }

      const retryRecord = getRetryableDowntimeCreateRecord(task.taskId);
      if (!retryRecord) {
        void message.error(t("workReport:downtimePage.tasks.retryHints.missingLocalPayload"));
        return;
      }

      setRetryingDowntimeTaskId(task.taskId);
      try {
        const accepted = await createForm16DowntimeRecord(retryRecord.payload);
        replaceRetryableDowntimeCreateRecord(task.taskId, {
          taskId: accepted.taskId,
          retryRootTaskId: retryRecord.retryRootTaskId,
          retriedFromTaskId: task.taskId,
          payload: retryRecord.payload,
          createdAt: accepted.createdAt ?? new Date().toISOString(),
        });
        upsertDowntimeTaskState(
          buildAcceptedDowntimeTask(
            accepted,
            actorClientId,
            t("workReport:downtimePage.tasks.retrySubmitted")
          )
        );
        setNotice({
          type: "info",
          message: t("workReport:downtimePage.tasks.retrySubmitted"),
        });
        void message.success(t("workReport:downtimePage.tasks.retrySubmitted"));
        trackDowntimeTask(accepted.taskId);
        void loadDowntimeTasks();
      } catch (error) {
        const errorMsg = t("workReport:messages.failedCreateDowntimeRecord", {
          error: getErrorMessage(error),
        });
        setNotice({ type: "error", message: errorMsg });
        void message.error(errorMsg);
      } finally {
        setRetryingDowntimeTaskId(null);
      }
    },
    [
      actorClientId,
      canRetryDowntimeTask,
      getDowntimeTaskRetryHint,
      loadDowntimeTasks,
      t,
      trackDowntimeTask,
      upsertDowntimeTaskState,
    ]
  );

  const handleCreateRecord = useCallback(async () => {
    const validationError = validateDraft(draft, t);
    if (validationError) {
      setNotice({ type: "error", message: validationError });
      return;
    }

    setSubmitting(true);
    try {
      const payload: CreateForm16DowntimePayload & { clientRowKey: string } = {
        date: draft.date.trim(),
        machineId: draft.machineId.trim(),
        processCode: draft.processCode.trim(),
        operatorId: draft.operatorId.trim() || undefined,
        plannedIdleMinutes: draft.plannedIdleMinutes.trim()
          ? Math.trunc(Number(draft.plannedIdleMinutes))
          : undefined,
        remark: draft.remark.trim() || undefined,
        clientRowKey: createDowntimeClientRowKey(),
      };
      const accepted = await createForm16DowntimeRecord(payload);
      const createdAt = accepted.createdAt ?? new Date().toISOString();
      saveRetryableDowntimeCreateRecord({
        taskId: accepted.taskId,
        retryRootTaskId: accepted.taskId,
        payload,
        createdAt,
      });
      upsertDowntimeTaskState(
        buildAcceptedDowntimeTask(
          { ...accepted, createdAt },
          actorClientId,
          t("workReport:downtimePage.tasks.accepted")
        )
      );
      const acceptedMessage = t("workReport:downtimePage.tasks.queued");
      setNotice({ type: "info", message: acceptedMessage });
      void message.info(acceptedMessage);
      setDraft((previous) => ({
        ...previous,
        plannedIdleMinutes: previous.plannedIdleMinutes.trim() || "480",
        remark: "",
      }));
      trackDowntimeTask(accepted.taskId);
      void loadDowntimeTasks();
    } catch (error) {
      const errorMsg = t("workReport:messages.failedCreateDowntimeRecord", {
        error: getErrorMessage(error),
      });
      setNotice({ type: "error", message: errorMsg });
      void message.error(errorMsg);
    } finally {
      setSubmitting(false);
    }
  }, [actorClientId, draft, loadDowntimeTasks, t, trackDowntimeTask, upsertDowntimeTaskState]);

  const handleOpenPicker = useCallback((key: DowntimePickerKey) => {
    setPickerState({ key, mode: "create", search: "" });
  }, []);

  const handleOpenEditPicker = useCallback((key: DowntimeEditPickerKey) => {
    setPickerState({ key, mode: "edit", search: "" });
  }, []);

  const handleSelectPickerValue = useCallback((value: string) => {
    if (!pickerState) {
      return;
    }

    if (pickerState.mode === "edit") {
      setEditingDraft((previous) => {
        if (!previous) return previous;
        if (pickerState.key === "machineId") {
          const selectedMachine = machineOptionMap.get(value);
          const autoProcessCode = String(
            selectedMachine?.machineDefault?.processCode ?? ""
          ).trim();
          return {
            ...previous,
            machineId: value,
            processCode: autoProcessCode || previous.processCode,
          };
        }
        if (pickerState.key === "processCode") {
          return { ...previous, processCode: value };
        }
        return {
          ...previous,
          operatorId: value === OPTIONAL_OPERATOR_CLEAR_TOKEN ? "" : value,
        };
      });
      setPickerState(null);
      return;
    }

    const shouldAutofillProcess =
      pickerState.key === "machineId"
        ? (() => {
            const selectedMachine = machineOptionMap.get(value);
            const autoProcessCode = String(selectedMachine?.machineDefault?.processCode ?? "").trim();
            return Boolean(autoProcessCode);
          })()
        : false;

    setDraft((previous) => {
      if (pickerState.key === "machineId") {
        const selectedMachine = machineOptionMap.get(value);
        const autoProcessCode = String(selectedMachine?.machineDefault?.processCode ?? "").trim();
        return {
          ...previous,
          machineId: value,
          processCode: autoProcessCode || previous.processCode,
        };
      }
      if (pickerState.key === "processCode") {
        return { ...previous, processCode: value };
      }
      return {
        ...previous,
        operatorId: value === OPTIONAL_OPERATOR_CLEAR_TOKEN ? "" : value,
      };
    });
    if (shouldAutofillProcess) {
      setAutofilledFieldKeys(["processCode"]);
    }
    setPickerState(null);
  }, [machineOptionMap, pickerState]);

  const handleRecordsPageChange = useCallback((page: number, pageSize: number) => {
    setRecordsPage(page);
    setRecordsPageSize(pageSize);
  }, []);

  const handleEditStart = useCallback((record: Form16DowntimeRecord) => {
    setEditingRecordId(record.id);
    setEditingRecordSnapshotHash(record.snapshotHash ?? null);
    // Ragic 回傳 YYYY/MM/DD，<input type="date"> 要 YYYY-MM-DD
    const isoDate = (record.date ?? "").trim().replace(/\//g, "-");
    setEditingDraft({
      date: /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? isoDate : "",
      machineId: record.machineId ?? "",
      processCode: record.processCode ?? "",
      operatorId: record.operatorId ?? "",
      plannedIdleMinutes:
        record.plannedIdleMinutes != null ? String(record.plannedIdleMinutes) : "",
      remark: record.remark ?? "",
    });
  }, []);

  const handleEditCancel = useCallback(() => {
    setEditingRecordId(null);
    setEditingRecordSnapshotHash(null);
    setEditingDraft(null);
    setPickerState((previous) => (previous?.mode === "edit" ? null : previous));
  }, []);

  const handleEditFieldChange = useCallback(
    (field: keyof DowntimeEditDraft, value: string) => {
      setEditingDraft((previous) => (previous ? { ...previous, [field]: value } : previous));
    },
    []
  );

  const handleEditSave = useCallback(async () => {
    if (!editingRecordId || !editingDraft) return;

    const validationError = validateDraft(editingDraft, t);
    if (validationError) {
      setNotice({ type: "error", message: validationError });
      return;
    }

    const minutesRaw = editingDraft.plannedIdleMinutes.trim();
    const plannedIdleMinutes = minutesRaw ? Math.trunc(Number(minutesRaw)) : undefined;

    setEditBusyRecordId(editingRecordId);
    pushFrontendEvent({
      level: "info",
      category: "api",
      action: "downtime-mutation-submitted",
      summary: `送出停機紀錄更新 entryId=${editingRecordId}`,
      formId: "16",
      entryId: editingRecordId,
      meta: { kind: "update" },
    });
    try {
      const result = await downtimeUpdateTask.run(() =>
        updateForm16DowntimeRecord(editingRecordId, {
          date: editingDraft.date.trim(),
          machineId: editingDraft.machineId.trim(),
          processCode: editingDraft.processCode.trim(),
          operatorId: editingDraft.operatorId.trim(),
          ...(plannedIdleMinutes !== undefined ? { plannedIdleMinutes } : {}),
          remark: editingDraft.remark,
          expectedSnapshotHash: editingRecordSnapshotHash,
        })
      );
      if (!result.ok) {
        const errorMessage =
          result.errorMessage || t("workReport:downtimePage.messages.recordUpdateFailed");
        pushFrontendEvent({
          level: "error",
          category: "api",
          action: "downtime-mutation-failed",
          summary: `停機紀錄更新失敗：${errorMessage}`,
          formId: "16",
          entryId: editingRecordId,
          meta: { kind: "update", error: errorMessage },
        });
        void message.error(errorMessage);
        return;
      }
      void message.success(t("workReport:downtimePage.messages.recordUpdated"));
      setEditingRecordId(null);
      setEditingRecordSnapshotHash(null);
      setEditingDraft(null);
      await loadRecords("silent", { refresh: true });
    } finally {
      setEditBusyRecordId(null);
    }
  }, [
    downtimeUpdateTask,
    editingDraft,
    editingRecordId,
    editingRecordSnapshotHash,
    loadRecords,
    t,
  ]);

  const handleDeleteRecord = useCallback(
    (record: Form16DowntimeRecord) => {
      Modal.confirm({
        title: t("workReport:downtimePage.actions.deleteConfirmTitle"),
        content: t("workReport:downtimePage.actions.deleteConfirmContent"),
        okText: t("workReport:downtimePage.actions.deleteConfirmOk"),
        cancelText: t("workReport:downtimePage.actions.deleteConfirmCancel"),
        okButtonProps: { danger: true },
        onOk: async () => {
          // 樂觀更新：先從本地列表拿掉，失敗再塞回去
          const snapshot = { records, totalCount: recordsTotalCount };
          setRecords((previous) => previous.filter((item) => item.id !== record.id));
          setRecordsTotalCount((previous) => Math.max(0, previous - 1));
          setDeletingRecordId(record.id);
          pushFrontendEvent({
            level: "info",
            category: "api",
            action: "downtime-mutation-submitted",
            summary: `送出停機紀錄刪除 entryId=${record.id}`,
            formId: "16",
            entryId: record.id,
            meta: { kind: "delete" },
          });
          try {
            const result = await downtimeDeleteTask.run(() =>
              deleteForm16DowntimeRecord(record.id, {
                expectedSnapshotHash: record.snapshotHash,
              })
            );
            if (!result.ok) {
              // rollback
              setRecords(snapshot.records);
              setRecordsTotalCount(snapshot.totalCount);
              const errorMessage =
                result.errorMessage || t("workReport:downtimePage.messages.recordDeleteFailed");
              pushFrontendEvent({
                level: "error",
                category: "api",
                action: "downtime-mutation-failed",
                summary: `停機紀錄刪除失敗：${errorMessage}`,
                formId: "16",
                entryId: record.id,
                meta: { kind: "delete", error: errorMessage },
              });
              void message.error(errorMessage);
              return;
            }
            void message.success(t("workReport:downtimePage.messages.recordDeleted"));
            await loadRecords("silent", { refresh: true });
          } finally {
            setDeletingRecordId(null);
          }
        },
      });
    },
    [downtimeDeleteTask, loadRecords, records, recordsTotalCount, t]
  );

  const resolveOperatorDisplay = useCallback(
    (operatorId: string): string => {
      const option = operatorOptionMap.get(operatorId);
      return option ? resolveDisplay(option) : operatorId;
    },
    [operatorOptionMap]
  );

  const handleShowHistory = useCallback(() => {
    setAuditHistoryOpen(true);
    pushFrontendEvent({
      level: "info",
      category: "ui",
      action: "audit-history-opened",
      summary: "開啟停機紀錄歷史（全部）",
      formId: "16",
      meta: { scope: "downtime" },
    });
  }, []);

  const initialPageLoading = recordsLoading && !recordsLoaded;
  const headerRefreshing = refreshingRecords;
  const downtimePageRefreshBusy =
    headerRefreshing || optionsLoading || chartLoading || downtimeTasksLoading;
  const downtimeTaskSummary = useMemo(
    () => ({
      total: downtimeTasks.length,
      running: downtimeTasks.filter((task) => isDowntimeTaskRunning(task.status)).length,
      failed: downtimeTasks.filter((task) => task.status === "failed").length,
    }),
    [downtimeTasks]
  );

  const recordsTableLabels = useMemo(
    () => ({
      date: t("workReport:downtimePage.table.date"),
      machineId: t("workReport:downtimePage.table.machineId"),
      processCode: t("workReport:downtimePage.table.processCode"),
      operator: t("workReport:downtimePage.table.operator"),
      reportType: t("workReport:downtimePage.table.reportType"),
      plannedIdleMinutes: t("workReport:downtimePage.table.plannedIdleMinutes"),
      timeRange: t("workReport:downtimePage.table.timeRange"),
      remark: t("workReport:downtimePage.table.remark"),
      entryId: t("workReport:downtimePage.table.entryId"),
      actions: t("workReport:downtimePage.table.actions"),
      edit: t("workReport:downtimePage.actions.edit"),
      save: t("workReport:downtimePage.actions.save"),
      cancel: t("workReport:downtimePage.actions.cancel"),
      delete: t("workReport:downtimePage.actions.delete"),
      saving: t("workReport:downtimePage.actions.saving"),
      deleting: t("workReport:downtimePage.actions.deleting"),
      deleteConfirmTitle: t("workReport:downtimePage.actions.deleteConfirmTitle"),
      deleteConfirmContent: t("workReport:downtimePage.actions.deleteConfirmContent"),
      deleteConfirmOk: t("workReport:downtimePage.actions.deleteConfirmOk"),
      deleteConfirmCancel: t("workReport:downtimePage.actions.deleteConfirmCancel"),
      pickerPlaceholder: t("workReport:downtimePage.actions.pickerPlaceholder"),
    }),
    [t]
  );

  const pickerCopy = useMemo(() => {
    if (!pickerState) {
      return null;
    }
    if (pickerState.key === "machineId") {
      return {
        title: t("workReport:detailPage.machinePickerTitle"),
        hint: t("workReport:detailPage.machinePickerHint"),
        searchLabel: t("workReport:detailPage.machinePickerSearchLabel"),
        searchPlaceholder: t("workReport:detailPage.machinePickerSearchPlaceholder"),
        emptyText: t("workReport:detailPage.machinePickerEmpty"),
      };
    }
    if (pickerState.key === "processCode") {
      return {
        title: t("workReport:detailPage.processPickerTitle"),
        hint: t("workReport:detailPage.processPickerHint"),
        searchLabel: t("workReport:detailPage.processPickerSearchLabel"),
        searchPlaceholder: t("workReport:detailPage.processPickerSearchPlaceholder"),
        emptyText: t("workReport:detailPage.processPickerEmpty"),
      };
    }
    return {
      title: t("workReport:detailPage.operatorPickerTitle"),
      hint: t("workReport:detailPage.operatorPickerHint"),
      searchLabel: t("workReport:detailPage.operatorPickerSearchLabel"),
      searchPlaceholder: t("workReport:detailPage.operatorPickerSearchPlaceholder"),
      emptyText: t("workReport:detailPage.operatorPickerEmpty"),
    };
  }, [pickerState, t]);

  return (
    <main className="page downtime-page">
      <section className="ragic-list-main">
        <header className="page-header">
          <div className="toolbar-layer toolbar-layer--title">
            <div className="toolbar-layer-main-row">
              <div className="page-title-block">
                <h1>{t("workReport:page.title")}</h1>
                <div className="page-group-pill">{t("workReport:page.groupDowntime")}</div>
              </div>

              <div className="toolbar-title-side">
                <div className="toolbar-title-actions">
                  <button
                    type="button"
                    className={`toolbar-icon-btn ${downtimePageRefreshBusy ? "is-busy" : ""}`}
                    onClick={refreshDowntimePageData}
                    disabled={submitting || downtimePageRefreshBusy}
                    aria-label={t("common:actions.refresh")}
                    title={t("common:actions.refresh")}
                  >
                    <ReloadOutlined />
                  </button>

                  <button
                    type="button"
                    className={`toolbar-icon-btn ${exporting ? "is-busy" : ""}`}
                    onClick={() => void handleExportCsv()}
                    disabled={optionsLoading || submitting || headerRefreshing || exporting}
                    aria-label={t("workReport:downtimePage.actions.exportCsv")}
                    title={t("workReport:downtimePage.actions.exportCsv")}
                  >
                    <CsvIcon />
                  </button>

                  <button
                    type="button"
                    className={`toolbar-icon-btn ${exportingAnalysis ? "is-busy" : ""}`}
                    onClick={openAnalysisDaysModal}
                    disabled={optionsLoading || submitting || headerRefreshing || exportingAnalysis}
                    aria-label={t("workReport:downtimePage.actions.exportAnalysis")}
                    title={t("workReport:downtimePage.actions.exportAnalysis")}
                  >
                    <XlsxIcon />
                  </button>

                  <div className="header-language-toggle" role="group" aria-label={t("common:language.toggleAria")}>
                    <span className="header-language-toggle-label">{t("common:language.label")}</span>
                    <button type="button" className={uiLanguage === "zh" ? "is-active" : ""} onClick={() => setUiLanguage("zh")}>
                      {t("common:language.zh")}
                    </button>
                    <button type="button" className={uiLanguage === "en" ? "is-active" : ""} onClick={() => setUiLanguage("en")}>
                      {t("common:language.en")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="page-view-switch" role="tablist" aria-label={t("workReport:page.viewSwitchAria")}>
              <button
                type="button"
                role="tab"
                aria-selected={false}
                className="page-view-chip"
                onClick={() => navigate("/?landingPage=thread-rolling-104&topView=report")}
              >
                {t("workReport:page.views.threadRolling104")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={false}
                className="page-view-chip"
                onClick={() => navigate("/?landingPage=heading-105&topView=report")}
              >
                {t("workReport:page.views.heading105")}
              </button>
              <button type="button" role="tab" aria-selected className="page-view-chip is-active">
                {t("workReport:page.views.downtime16")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={false}
                className="page-view-chip"
                onClick={() => setEfficiencyStatsOpen(true)}
              >
                <CsvIcon size="1.05em" />
                {t("workReport:efficiencyStats.entry")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={false}
                className="page-view-chip"
                onClick={() => navigate("/?topView=local-settings")}
              >
                {t("workReport:page.views.localSettings")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={false}
                className="page-view-chip page-view-chip--push-right"
                onClick={() => navigate("/dev")}
              >
                {t("workReport:page.views.technicalInfo")}
              </button>
            </div>
          </div>
        </header>

        <div
          className={`downtime-workspace ${
            downtimeTaskSidebarCollapsed ? "is-task-sidebar-collapsed" : ""
          }`}
        >
          <section className="local-settings-panel" aria-labelledby="downtime-page-title">
          <div className="local-settings-panel-header">
            <div>
              <h2 id="downtime-page-title">{t("workReport:downtimePage.title")}</h2>
              <p>{t("workReport:downtimePage.subtitle")}</p>
            </div>
          </div>

          {notice ? (
            <div className={`downtime-page-notice is-${notice.type}`}>
              {notice.type === "info" && (
                <span className="toolbar-btn-spinner" style={{ borderColor: "rgba(30,64,175,0.25)", borderTopColor: "currentColor" }} aria-hidden="true" />
              )}
              {notice.message}
            </div>
          ) : null}

          <div className="local-settings-card">
            <div className="local-settings-note">
              <strong>{t("workReport:downtimePage.autoFill.title")}</strong>
              <p>{t("workReport:downtimePage.autoFill.body")}</p>
            </div>

            <div className="downtime-auto-fill-grid">
              <div className="downtime-auto-fill-item">
                <span>{t("workReport:downtimePage.autoFill.inputOptionsLabel")}</span>
                <strong>{t("workReport:downtimePage.autoFill.inputOptionsValue")}</strong>
              </div>
              <div className="downtime-auto-fill-item">
                <span>{t("workReport:downtimePage.autoFill.shiftTypeLabel")}</span>
                <strong>{t("workReport:downtimePage.autoFill.shiftTypeValue")}</strong>
              </div>
              <div className="downtime-auto-fill-item">
                <span>{t("workReport:downtimePage.autoFill.timeRangeLabel")}</span>
                <strong>{t("workReport:downtimePage.autoFill.timeRangeValue")}</strong>
              </div>
              <div className="downtime-auto-fill-item">
                <span>{t("workReport:downtimePage.autoFill.plannedIdleLabel")}</span>
                <strong>{t("common:yesNo.yes")}</strong>
              </div>
            </div>

            <div className="downtime-form-grid">
              <label className="local-settings-field">
                <span>{t("workReport:downtimePage.fields.date")}</span>
                <input
                  type="date"
                  value={draft.date}
                  onChange={(event) => setDraft((previous) => ({ ...previous, date: event.target.value }))}
                />
              </label>

              <label className="local-settings-field">
                <span>{t("workReport:downtimePage.fields.machineId")}</span>
                <DetailInlinePickerTrigger
                  value={draft.machineId}
                  hint={selectedMachineOption ? resolveDisplay(selectedMachineOption) : null}
                  blankLabel={t("common:options.select")}
                  editorKey="downtime-machineId"
                  onOpen={() => handleOpenPicker("machineId")}
                />
              </label>

              <label
                className={`local-settings-field ${autofilledFieldKeys.includes("processCode") ? "downtime-field-autofilled" : ""}`}
              >
                <span>{t("workReport:downtimePage.fields.processCode")}</span>
                <DetailInlinePickerTrigger
                  value={draft.processCode}
                  hint={selectedProcessOption ? resolveDisplay(selectedProcessOption) : null}
                  blankLabel={t("common:options.select")}
                  editorKey="downtime-processCode"
                  onOpen={() => handleOpenPicker("processCode")}
                />
              </label>

              <label className="local-settings-field">
                <span>{t("workReport:downtimePage.fields.operatorId")}</span>
                <DetailInlinePickerTrigger
                  value={draft.operatorId}
                  hint={selectedOperatorOption ? resolveDisplay(selectedOperatorOption) : null}
                  blankLabel={t("workReport:downtimePage.values.unassigned")}
                  editorKey="downtime-operatorId"
                  onOpen={() => handleOpenPicker("operatorId")}
                />
                <small>{t("workReport:downtimePage.hints.operatorId")}</small>
              </label>

              <label className="local-settings-field">
                <span>{t("workReport:downtimePage.fields.plannedIdleMinutes")}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={draft.plannedIdleMinutes}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      plannedIdleMinutes: event.target.value,
                    }))
                  }
                />
                <small>{t("workReport:downtimePage.hints.plannedIdleMinutes")}</small>
              </label>

              <label className="local-settings-field downtime-form-field--full">
                <span>{t("workReport:downtimePage.fields.remark")}</span>
                <textarea
                  rows={3}
                  value={draft.remark}
                  onChange={(event) => setDraft((previous) => ({ ...previous, remark: event.target.value }))}
                  placeholder={t("workReport:downtimePage.placeholders.remark")}
                />
                <small>{t("workReport:downtimePage.hints.remark")}</small>
              </label>
            </div>

            <div className="local-settings-actions">
              <button
                type="button"
                className="toolbar-btn toolbar-btn--secondary"
                onClick={() => setDraft(createEmptyDraft())}
                disabled={submitting}
              >
                {t("common:actions.cancel")}
              </button>
              <button
                type="button"
                className="toolbar-btn toolbar-btn--primary"
                onClick={() => void handleCreateRecord()}
                disabled={optionsLoading || submitting}
              >
                {submitting && (
                  <span className="toolbar-btn-spinner" aria-hidden="true" />
                )}
                {submitting
                  ? t("workReport:downtimePage.actions.creating")
                  : t("workReport:downtimePage.actions.create")}
              </button>
            </div>
          </div>

          <div className="local-settings-card planned-idle-card">
            <button
              type="button"
              className="planned-idle-card-header"
              onClick={() => setChartCollapsed((value) => !value)}
              aria-expanded={!chartCollapsed}
            >
              <span className="planned-idle-card-title">
                {t("workReport:downtimePage.chart.title")}
              </span>
              <span className="planned-idle-card-toggle" aria-hidden="true">
                {chartCollapsed ? "▸" : "▾"}
              </span>
            </button>
            {chartCollapsed ? null : (
              <div className="planned-idle-card-body">
                <div className="planned-idle-card-toolbar">
                  <label className="downtime-chart-month-picker">
                    <span>{t("workReport:downtimePage.chart.monthLabel")}</span>
                    <select
                      value={chartMonth}
                      onChange={(event) => setChartMonth(event.target.value)}
                      disabled={chartLoading}
                    >
                      {monthOptions.map((ym) => (
                        <option key={ym} value={ym}>
                          {ym}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="downtime-chart-refresh-btn"
                    onClick={() => void loadChart(chartMonth, true)}
                    disabled={chartLoading}
                  >
                    {t("workReport:downtimePage.chart.refresh")}
                  </button>
                </div>
                {chartError ? (
                  <div className="downtime-page-notice is-error">{chartError}</div>
                ) : chartLoading ? (
                  <div className="planned-idle-chart-empty">
                    {t("workReport:downtimePage.chart.loading")}
                  </div>
                ) : (
                  <PlannedIdleChart
                    month={chartResolvedMonth || chartMonth}
                    machines={chartMachines}
                  />
                )}
              </div>
            )}
          </div>

          <div className="local-settings-card">
            <div className="local-settings-panel-header">
              <div>
                <h2>{t("workReport:downtimePage.recordsTitle")}</h2>
                <p>{t("workReport:downtimePage.recordsSubtitle")}</p>
              </div>
              <button
                type="button"
                className="downtime-page-history-btn"
                onClick={handleShowHistory}
              >
                {t("workReport:auditHistory.openHistory")}
              </button>
            </div>

            <WorkReportDowntimeRecordsTable
              loading={initialPageLoading || refreshingRecords}
              records={records}
              totalCount={recordsTotalCount}
              page={recordsPage}
              pageSize={recordsPageSize}
              onPageChange={handleRecordsPageChange}
              loadingText={t("common:states.loadingData")}
              emptyText={t("workReport:downtimePage.empty")}
              labels={recordsTableLabels}
              editingRecordId={editingRecordId}
              editingDraft={editingDraft}
              editBusyRecordId={editBusyRecordId}
              deletingRecordId={deletingRecordId}
              rowActionsDisabled={optionsLoading}
              resolveOperatorDisplay={resolveOperatorDisplay}
              editingDerivedReportType={
                editingDraft ? inferReportTypeFromProcessCode(editingDraft.processCode) : ""
              }
              onEditStart={handleEditStart}
              onEditCancel={handleEditCancel}
              onEditSave={handleEditSave}
              onEditFieldChange={handleEditFieldChange}
              onEditOpenPicker={handleOpenEditPicker}
              onDelete={handleDeleteRecord}
            />
          </div>
          </section>

          <aside
            id="downtime-task-sidebar"
            className={`downtime-task-sidebar ${
              downtimeTaskSidebarCollapsed ? "is-collapsed" : ""
            }`}
            aria-label={t("workReport:downtimePage.tasks.title")}
          >
            {downtimeTaskSidebarCollapsed ? (
              <div className="downtime-task-sidebar-rail">
                <div className="downtime-task-sidebar-rail-actions">
                  <button
                    type="button"
                    className="downtime-task-sidebar-icon-btn downtime-task-sidebar-expand"
                    onClick={() => setDowntimeTaskSidebarCollapsed(false)}
                    aria-expanded={false}
                    aria-label={t("common:actions.expand")}
                    title={t("common:actions.expand")}
                  >
                    ◂
                  </button>
                  <button
                    type="button"
                    className="downtime-task-sidebar-icon-btn downtime-task-sidebar-refresh"
                    onClick={refreshDowntimePageData}
                    disabled={submitting || downtimePageRefreshBusy}
                    aria-label={t("common:actions.refresh")}
                    title={t("common:actions.refresh")}
                  >
                    {downtimePageRefreshBusy ? (
                      <span
                        className="toolbar-btn-spinner downtime-task-sidebar-spinner"
                        aria-hidden="true"
                      />
                    ) : (
                      <ReloadOutlined aria-hidden="true" />
                    )}
                  </button>
                </div>
                <button
                  type="button"
                  className="downtime-task-sidebar-rail-main"
                  onClick={() => setDowntimeTaskSidebarCollapsed(false)}
                  aria-expanded={false}
                  aria-label={t("common:actions.expand")}
                >
                  <span className="downtime-task-sidebar-rail-title">
                    {t("workReport:downtimePage.tasks.compactTitle")}
                  </span>
                  <span className="downtime-task-sidebar-rail-count">
                    <strong>{downtimeTaskSummary.total}</strong>
                    <span>{t("workReport:downtimePage.tasks.totalShort")}</span>
                  </span>
                  <span className="downtime-task-sidebar-rail-meta">
                    <span>
                      {downtimeTaskSummary.running}
                      {t("workReport:downtimePage.tasks.status.running")}
                    </span>
                    <span className="is-failed">
                      {downtimeTaskSummary.failed}
                      {t("workReport:downtimePage.tasks.status.failed")}
                    </span>
                  </span>
                </button>
              </div>
            ) : (
              <div className="downtime-task-sidebar-panel">
                <div className="downtime-task-sidebar-header">
                  <div>
                    <h2>{t("workReport:downtimePage.tasks.title")}</h2>
                    <p>{t("workReport:downtimePage.tasks.subtitle")}</p>
                  </div>
                  <div className="downtime-task-sidebar-actions">
                    <button
                      type="button"
                      className="downtime-task-sidebar-icon-btn downtime-task-sidebar-refresh"
                      onClick={refreshDowntimePageData}
                      disabled={submitting || downtimePageRefreshBusy}
                      aria-label={t("common:actions.refresh")}
                      title={t("common:actions.refresh")}
                    >
                      {downtimePageRefreshBusy ? (
                        <span
                          className="toolbar-btn-spinner downtime-task-sidebar-spinner"
                          aria-hidden="true"
                        />
                      ) : (
                        <ReloadOutlined aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="downtime-task-sidebar-icon-btn downtime-task-sidebar-collapse"
                      onClick={() => setDowntimeTaskSidebarCollapsed(true)}
                      aria-expanded
                      aria-label={t("common:actions.collapse")}
                      title={t("common:actions.collapse")}
                    >
                      ▸
                    </button>
                  </div>
                </div>

                <div className="downtime-task-sidebar-summary" aria-live="polite">
                  <span>
                    <strong>{downtimeTaskSummary.total}</strong>
                    {t("workReport:downtimePage.tasks.totalShort")}
                  </span>
                  <span>
                    <strong>{downtimeTaskSummary.running}</strong>
                    {t("workReport:downtimePage.tasks.status.running")}
                  </span>
                  <span className={downtimeTaskSummary.failed > 0 ? "is-failed" : ""}>
                    <strong>{downtimeTaskSummary.failed}</strong>
                    {t("workReport:downtimePage.tasks.status.failed")}
                  </span>
                </div>

                {downtimeTasksError ? (
                  <div className="downtime-page-notice is-error">
                    {t("workReport:downtimePage.tasks.loadFailed", {
                      error: downtimeTasksError,
                    })}
                  </div>
                ) : null}

                {downtimeTasksLoading && downtimeTasks.length === 0 ? (
                  <div className="downtime-task-empty">
                    <span className="toolbar-btn-spinner" aria-hidden="true" />
                    {t("workReport:downtimePage.tasks.loading")}
                  </div>
                ) : null}

                {!downtimeTasksLoading && downtimeTasks.length === 0 ? (
                  <div className="downtime-task-empty">
                    {t("workReport:downtimePage.tasks.empty")}
                  </div>
                ) : null}

                {downtimeTasks.length > 0 ? (
                  <div className="downtime-task-list" aria-live="polite">
                    {downtimeTasks.map((task) => {
                      const retryRecord = getRetryableDowntimeCreateRecord(task.taskId);
                      const retryHint = getDowntimeTaskRetryHint(task);
                      const displayMessage = getDowntimeTaskDisplayMessage(task);
                      const retryEnabled = canRetryDowntimeTask(task);

                      return (
                        <article
                          key={task.taskId}
                          className={`downtime-task-item is-${task.status}`}
                        >
                          <div className="downtime-task-item-head">
                            <div className="downtime-task-primary">
                              <h3>{t("workReport:downtimePage.tasks.createTitle")}</h3>
                              <code>{task.taskId}</code>
                            </div>
                            <span className={`downtime-task-status is-${task.status}`}>
                              {t(`workReport:downtimePage.tasks.status.${task.status}`)}
                            </span>
                          </div>

                          <div className="downtime-task-meta">
                            <span>
                              {t("workReport:downtimePage.tasks.fields.createdAt")}
                              <strong>{formatDowntimeTaskTime(task.createdAt)}</strong>
                            </span>
                            <span>
                              {t("workReport:downtimePage.tasks.fields.finishedAt")}
                              <strong>{formatDowntimeTaskTime(task.finishedAt)}</strong>
                            </span>
                            {task.entryId ? (
                              <span>
                                {t("workReport:downtimePage.tasks.fields.entryId")}
                                <strong>{task.entryId}</strong>
                              </span>
                            ) : null}
                            {retryRecord?.retriedFromTaskId ? (
                              <span>
                                {t("workReport:downtimePage.tasks.fields.retryFrom")}
                                <strong>{retryRecord.retriedFromTaskId}</strong>
                              </span>
                            ) : null}
                            {retryRecord?.latestRetryTaskId ? (
                              <span>
                                {t("workReport:downtimePage.tasks.fields.retrySubmittedAs")}
                                <strong>{retryRecord.latestRetryTaskId}</strong>
                              </span>
                            ) : null}
                          </div>

                          {displayMessage ? (
                            <p
                              className={`downtime-task-message ${
                                task.status === "failed" ? "is-error" : ""
                              }`}
                            >
                              {displayMessage}
                            </p>
                          ) : null}

                          {retryHint ? (
                            <p className="downtime-task-note">{retryHint}</p>
                          ) : null}

                          {retryEnabled ? (
                            <div className="downtime-task-actions">
                              <button
                                type="button"
                                className="toolbar-btn toolbar-btn--secondary downtime-task-retry-btn"
                                onClick={() => void handleRetryDowntimeTask(task)}
                                disabled={retryingDowntimeTaskId === task.taskId}
                              >
                                {retryingDowntimeTaskId === task.taskId && (
                                  <span className="toolbar-btn-spinner" aria-hidden="true" />
                                )}
                                {retryingDowntimeTaskId === task.taskId
                                  ? t("workReport:downtimePage.tasks.retrying")
                                  : t("workReport:downtimePage.tasks.retry")}
                              </button>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            )}
          </aside>
        </div>
      </section>
      {pickerState && pickerCopy ? (
        <DetailLinkedPickerModal
          title={pickerCopy.title}
          hint={pickerCopy.hint}
          closeLabel={t("common:actions.cancel")}
          currentSelectionLabel={t("workReport:detailPage.pickerCurrentSelectionLabel")}
          currentSelectionOption={currentPickerOption}
          topContent={pickerTopContent}
          searchLabel={pickerCopy.searchLabel}
          searchPlaceholder={pickerCopy.searchPlaceholder}
          emptyText={pickerCopy.emptyText}
          searchValue={pickerState.search}
          options={pickerOptions}
          selectedValue={selectedPickerValue}
          onSearchChange={(value) =>
            setPickerState((previous) => (previous ? { ...previous, search: value } : previous))
          }
          onSelect={handleSelectPickerValue}
          onClose={() => setPickerState(null)}
        />
      ) : null}
      <RecordAuditHistoryModal
        open={auditHistoryOpen}
        onClose={() => setAuditHistoryOpen(false)}
        scope="downtime"
        formId="16"
        recordLabel={t("workReport:auditHistory.recordLabelDowntimeAll")}
      />
      <EfficiencyStatsModal
        open={efficiencyStatsOpen}
        onClose={() => setEfficiencyStatsOpen(false)}
      />
      <Modal
        title={t("workReport:downtimePage.analysisModal.title")}
        open={analysisDaysOpen}
        okText={t("workReport:downtimePage.analysisModal.ok")}
        cancelText={t("workReport:downtimePage.analysisModal.cancel")}
        onOk={() => {
          setAnalysisDaysOpen(false);
          const parsed = Number(analysisDays.trim());
          void handleExportAnalysis(
            Number.isFinite(parsed) && parsed > 0 && parsed <= 31 ? parsed : undefined
          );
        }}
        onCancel={() => setAnalysisDaysOpen(false)}
      >
        <label htmlFor="analysis-days-input" style={{ display: "block", marginBottom: 8 }}>
          {t("workReport:downtimePage.analysisModal.daysLabel")}
        </label>
        <input
          id="analysis-days-input"
          type="number"
          min={1}
          max={31}
          step={0.5}
          value={analysisDays}
          onChange={(event) => setAnalysisDays(event.target.value)}
          style={{ width: 120, padding: "4px 8px" }}
        />
      </Modal>
    </main>
  );
}
