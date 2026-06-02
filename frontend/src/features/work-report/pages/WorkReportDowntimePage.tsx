import { ReloadOutlined } from "@ant-design/icons";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import "../../../App.css";
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
  deleteForm16DowntimeRecord,
  fetchForm16DowntimeOptions,
  fetchForm16DowntimeRecords,
  updateForm16DowntimeRecord,
  type Form16DowntimeRecord,
} from "../../../api/downtime";
import type {
  DowntimeEditDraft,
  DowntimeEditPickerKey,
} from "../components/WorkReportDowntimeRecordsTable";
import { RecordAuditHistoryModal } from "../components/RecordAuditHistoryModal";
import { pushFrontendEvent } from "../logging/frontendEventLog";
import type { FormOptionItem } from "../../../api/workReport";
import { DetailInlinePickerTrigger, DetailLinkedPickerModal } from "../components/DetailLinkedPicker";
import { WorkReportDowntimeRecordsTable } from "../components/WorkReportDowntimeRecordsTable";
import { useDowntimeCreateTask } from "../hooks/useDowntimeCreateTask";
import { useDowntimeMutationTask } from "../hooks/useDowntimeMutationTask";
import { inferReportTypeFromProcessCode } from "../../../components/report-form/form-logic/inference";
import {
  buildMachineStatusSuffix,
  isActiveMachineOption,
} from "../../../components/report-form/optionUtils";
import type { NoticeState, UiLanguage, WorkReportFormId } from "../types";
import { getErrorMessage } from "../utils/errorUtils";

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

export function WorkReportDowntimePage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation(["workReport", "common"]);
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
  const hasRequestedInitialRecordsRef = useRef(false);
  const refreshPollTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (refreshPollTimerRef.current !== null) {
        window.clearInterval(refreshPollTimerRef.current);
        refreshPollTimerRef.current = null;
      }
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
        if (mode === "refresh" && result.meta.refreshTriggered && !result.meta.refreshed) {
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

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

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

  const downtimeCreateTask = useDowntimeCreateTask();
  const downtimeUpdateTask = useDowntimeMutationTask();
  const downtimeDeleteTask = useDowntimeMutationTask();

  const handleCreateRecord = useCallback(async () => {
    const validationError = validateDraft(draft, t);
    if (validationError) {
      setNotice({ type: "error", message: validationError });
      return;
    }

    setSubmitting(true);
    try {
      setNotice({
        type: "info",
        message: t("workReport:downtimePage.messages.recordsBackgroundSyncing"),
      });
      const result = await downtimeCreateTask.submit({
        date: draft.date.trim(),
        machineId: draft.machineId.trim(),
        processCode: draft.processCode.trim(),
        operatorId: draft.operatorId.trim() || undefined,
        plannedIdleMinutes: draft.plannedIdleMinutes.trim()
          ? Math.trunc(Number(draft.plannedIdleMinutes))
          : undefined,
        remark: draft.remark.trim() || undefined,
      });

      if (result.ok) {
        setNotice({
          type: "success",
          message: t("workReport:messages.downtimeRecordCreated"),
        });
        void message.success(t("workReport:messages.downtimeRecordCreated"));
        setDraft((previous) => ({
          ...previous,
          plannedIdleMinutes: previous.plannedIdleMinutes.trim() || "480",
          remark: "",
        }));
        if (recordsPage !== 1) {
          setRecordsPage(1);
        } else {
          await loadRecords("silent", {
            page: 1,
            pageSize: recordsPageSize,
          });
        }
      } else {
        const errorMsg = t("workReport:messages.failedCreateDowntimeRecord", {
          error: result.errorMessage ?? "建立失敗",
        });
        setNotice({ type: "error", message: errorMsg });
        void message.error(errorMsg);
      }
    } catch (error) {
      setNotice({
        type: "error",
        message: t("workReport:messages.failedCreateDowntimeRecord", {
          error: getErrorMessage(error),
        }),
      });
    } finally {
      setSubmitting(false);
    }
  }, [downtimeCreateTask, draft, loadRecords, recordsPage, recordsPageSize, t]);

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
      setEditingDraft(null);
      await loadRecords("silent", { refresh: true });
    } finally {
      setEditBusyRecordId(null);
    }
  }, [downtimeUpdateTask, editingDraft, editingRecordId, loadRecords, t]);

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
              deleteForm16DowntimeRecord(record.id)
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
                    onClick={() => navigate("/?topView=local-settings")}
                  >
                    {t("workReport:page.views.localSettings")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={false}
                    className="page-view-chip"
                    onClick={() => navigate("/?topView=technical-info")}
                  >
                    {t("workReport:page.views.technicalInfo")}
                  </button>
                </div>
              </div>

              <div className="toolbar-title-side">
                <div className="toolbar-title-actions">
                  <button
                    type="button"
                    className={`toolbar-icon-btn ${headerRefreshing ? "is-busy" : ""}`}
                    onClick={() => {
                      void loadRecords("refresh", {
                        page: recordsPage,
                        pageSize: recordsPageSize,
                        refresh: true,
                      });
                      // 背景 refresh 完成後 SQLite 才會更新，自動 polling reload
                      // 用 ref 存 timer id，切頁時 useEffect cleanup 會清掉
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
                      }, 5000);
                    }}
                    disabled={optionsLoading || submitting || headerRefreshing}
                    aria-label={t("common:actions.refresh")}
                    title={t("common:actions.refresh")}
                  >
                    <ReloadOutlined />
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
          </div>
        </header>

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
    </main>
  );
}
