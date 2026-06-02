import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  WorkReportFrontendEventAction,
  WorkReportFrontendEventCategory,
} from "../debug/workReportDeveloperContract";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Modal, message } from "antd";
import { AxiosError } from "axios";
import {
  createReportsBatchAccepted,
  deleteReportsBatchAccepted,
  deleteReport,
  fetchFormOptions,
  fetchWorkReportQueueTask,
  fetchWorkReportEntry,
  fetchEditingPresence,
  type EditingPresenceSnapshot,
  type FormOptionMap,
  type ReportMutationPayload,
  type WorkReportRecord,
  type WorkReportQueueTask,
  closeWorkOrder,
  reopenWorkOrder,
  updateEditingPresence,
} from "../../../api/workReport";
import {
  EMPTY_FORM,
} from "../../../components/report-form/constants";
import { buildInitialFormState } from "../../../components/report-form/formMemory";
import { buildReportMutationPayload } from "../../../components/report-form/formLogic";
import {
  CREATE_TASK_POLL_INTERVAL_MS,
  CREATE_TASK_POLL_TIMEOUT_MS,
  WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY,
} from "../constants";
import type { FormState } from "../../../components/report-form/types";
import { ReportFormModal } from "../../../components/ReportFormModal";
import { formatTimeDisplay } from "../../../components/report-form/timeUtils";
import { WorkOrderContextCard } from "../../../components/WorkOrderContextCard";
import { WorkReportTaskQueueDrawer } from "../components/WorkReportTaskQueueDrawer";
import { RecordAuditHistoryModal } from "../components/RecordAuditHistoryModal";
import {
  DetailInlinePickerTrigger,
  DetailLinkedPickerModal,
} from "../components/DetailLinkedPicker";
import { WorkReportDetailTableSection } from "../components/WorkReportDetailTableSection";
import { useWorkReportTaskMonitorContext } from "../context/useWorkReportTaskMonitorContext";
import { useWorkReportDetailInlineController } from "../hooks/detail/useWorkReportDetailInlineController";
import { useWorkReportDetailModalController } from "../hooks/detail/useWorkReportDetailModalController";
import { useWorkReportDetailPickerController } from "../hooks/detail/useWorkReportDetailPickerController";
import { useWorkReportDetailRefreshController } from "../hooks/detail/useWorkReportDetailRefreshController";
import { useWorkReportMainMachineController } from "../hooks/detail/useWorkReportMainMachineController";
import { useWorkReportDetailStatusController } from "../hooks/detail/useWorkReportDetailStatusController";
import { useWorkReportDetailTaskController } from "../hooks/detail/useWorkReportDetailTaskController";
import { useWorkReportClientPresence } from "../hooks/useWorkReportClientPresence";
import { useWorkReportSessionExpiryGuard } from "../hooks/useWorkReportSessionExpiryGuard";
import {
  deleteRetryableBatchCreateRecordChain,
  saveRetryableBatchCreateRecord,
} from "../taskBatchRetryStore";
import type {
  DetailTableRow,
  InlineEditableDetailKey,
  LoadEntryOptions,
} from "../hooks/detail/types";
import type {
  UiLanguage,
  WorkReportFormId,
  WorkReportListLocationState,
  WorkReportMutationTaskKind,
} from "../types";
import { getErrorMessage, normalizeRecord } from "../utils";
import { showClosedLockWarning } from "../utils/closedLockWarning";
import { computePredictedCumulative } from "../utils/predictedCumulative";
import {
  calculateDurationMs,
  createFrontendOperationId,
  pushFrontendEvent,
  summarizeChangedPayloadFields,
} from "../logging/frontendEventLog";

interface OrderedDetailColumn {
  key: string;
  label: string;
  className?: string;
}

interface DetailColumnDefinition {
  key: string;
  label: string;
  className?: string;
  renderCell: (item: DetailTableRow) => ReactNode;
  isToggleable?: boolean;
}

interface DetailInlineEditorDefinition {
  key: InlineEditableDetailKey;
  renderEditor: (rowId: string, draft: FormState) => ReactNode;
}

function isPlannedIdleYesValue(value: unknown): boolean {
  return String(value ?? "").trim() === "Yes";
}

interface PendingMutationReplay {
  kind: WorkReportMutationTaskKind;
  formId: WorkReportFormId;
  entryId: string;
  rowId?: string;
  payload: ReportMutationPayload;
  clientMutationId: string;
  expectedEntryLastUpdatedAt?: string;
  editSessionId?: string;
  editLockVersion?: number;
  attempts: number;
  createdAt: string;
}

const EDITING_PRESENCE_SESSION_STORAGE_KEY = "work-report:editing-presence-session:v1";
const ROW_LOCK_DEBUG = import.meta.env.DEV;

function normalizeDateInputValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }

  const digitsOnly = trimmed.replace(/\D/g, "");
  if (/^\d{8}$/.test(digitsOnly)) {
    return `${digitsOnly.slice(0, 4)}-${digitsOnly.slice(4, 6)}-${digitsOnly.slice(6, 8)}`;
  }

  const normalizedSeparator = trimmed.replace(/[/.]/g, "-");
  const match = normalizedSeparator.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return trimmed;
  }

  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function readOrCreateEditingPresenceSessionId(): string {
  if (typeof window === "undefined") {
    return "server";
  }

  try {
    const existing = String(
      window.sessionStorage.getItem(EDITING_PRESENCE_SESSION_STORAGE_KEY) ?? ""
    ).trim();
    if (existing) {
      return existing;
    }
    const nextId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(EDITING_PRESENCE_SESSION_STORAGE_KEY, nextId);
    return nextId;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

const BASE_DETAIL_KEYS = [
  "rowId",
  "date",
  "reportType",
  "plannedIdle",
  "processCode",
  "machineId",
  "operatorId",
  "operatorName",
  "inputOptions",
  "shiftType",
  "startTime",
  "endTime",
  "breakTime",
  "totalWorkTime",
  "productionQty",
  "cumulativeQty",
  "remark",
] as const;

const SETUP_COLUMNS_ORDER_104: ReadonlyArray<OrderedDetailColumn> = [
  { key: "setupAdjustType", label: "workReport:reportForm.setupSection.fields.setupAdjustType", className: "col-setup-adjust-type" },
  { key: "setupAdjustMinutes", label: "workReport:reportForm.setupSection.fields.setupAdjustMinutes", className: "col-compact col-number" },
  { key: "countSetupTimeFlag", label: "workReport:reportForm.setupSection.fields.countSetupTimeFlag", className: "col-compact col-flag" },
  { key: "setupTimeStandardHours", label: "workReport:reportForm.setupSection.fields.setupTimeStandardHours" },
  { key: "setupLossQtyPerPcs", label: "workReport:reportForm.setupSection.fields.setupLossQtyPerPcs" },
  { key: "processLossQtyPerPcs", label: "workReport:reportForm.setupSection.fields.processLossQtyPerPcs" },
  { key: "totalContainerQty", label: "workReport:reportForm.setupSection.fields.totalContainerQty" },
  { key: "containerUnit", label: "workReport:reportForm.setupSection.fields.containerUnit" },
];

const REASON_COLUMNS_ORDER_104: ReadonlyArray<OrderedDetailColumn> = [
  { key: "plannedIdleMinutes", label: "workReport:reportForm.reasonSection.fields.plannedIdleMinutes", className: "col-compact col-number" },
  { key: "unplannedIdleMinutes", label: "workReport:reportForm.reasonSection.fields.unplannedIdleMinutes", className: "col-compact col-number" },
  { key: "absentOrTrainingMinutes", label: "workReport:reportForm.reasonSection.fields.absentOrTrainingMinutes", className: "col-compact col-number" },
  { key: "noMaterialMinutes", label: "workReport:reportForm.reasonSection.fields.noMaterialMinutes", className: "col-compact col-number" },
  { key: "waitingQcApprovalMinutes", label: "workReport:reportForm.reasonSection.fields.waitingQcApprovalMinutes", className: "col-compact col-number" },
  { key: "meetingMinutes", label: "workReport:reportForm.reasonSection.fields.meetingMinutes", className: "col-compact col-number" },
  { key: "cleaningMinutes", label: "workReport:reportForm.reasonSection.fields.cleaningMinutes", className: "col-compact col-number" },
  { key: "rdSamplingMinutes", label: "workReport:reportForm.reasonSection.fields.rdSamplingMinutes", className: "col-compact col-number" },
  { key: "supportOtherMachinesMinutes", label: "workReport:reportForm.reasonSection.fields.supportOtherMachinesMinutes", className: "col-compact col-number" },
  { key: "machineBreakdownMinutes", label: "workReport:reportForm.reasonSection.fields.machineBreakdownMinutes", className: "col-compact col-number" },
  { key: "machineAdjustmentMinutes", label: "workReport:reportForm.reasonSection.fields.machineAdjustmentMinutes", className: "col-compact col-number" },
  { key: "othersMinutes", label: "workReport:reportForm.reasonSection.fields.othersMinutes", className: "col-compact col-number" },
  { key: "waitingForDiesMinutes", label: "workReport:reportForm.reasonSection.fields.waitingForDiesMinutes", className: "col-compact col-number" },
  { key: "testingDiesMinutes", label: "workReport:reportForm.reasonSection.fields.testingDiesMinutes", className: "col-compact col-number" },
];

const EMPTY_OPTIONS: FormOptionMap = {};
const SUPPORTED_FORM_IDS = new Set<WorkReportFormId>(["104", "105"]);
const DETAIL_HIDDEN_COLUMNS_STORAGE_KEY = "work-report:detail-hidden-columns:v4";
const INLINE_CREATE_PLACEHOLDER_COUNT = 3;
const INLINE_CREATE_TRAILING_PLACEHOLDER_COUNT = 3;
const INLINE_CREATE_PLACEHOLDER_ROW_PREFIX = "__inline-create__";
const BATCH_CREATE_FILLABLE_KEYS = new Set<InlineEditableDetailKey>([
  "date",
  "plannedIdle",
  "processCode",
  "machineId",
  "operatorId",
  "inputOptions",
  "shiftType",
  "startTime",
  "endTime",
  "breakTime",
  "productionQty",
  "remark",
  "setupAdjustType",
  "setupAdjustMinutes",
]);
const BATCH_CREATE_FILL_ORDER: ReadonlyArray<InlineEditableDetailKey> = [
  "date",
  "plannedIdle",
  "processCode",
  "machineId",
  "operatorId",
  "inputOptions",
  "shiftType",
  "startTime",
  "endTime",
  "breakTime",
  "productionQty",
  "remark",
  "setupAdjustType",
  "setupAdjustMinutes",
];

type BatchCreateFieldErrorMap = Partial<Record<InlineEditableDetailKey, string>>;
type BatchCreateFillDragState = {
  sourceRowId: string;
  sourceKey: InlineEditableDetailKey;
  endKey: InlineEditableDetailKey;
  startIndex: number;
  endIndex: number;
};

function resolveBatchCreateFillKeys(
  sourceKey: InlineEditableDetailKey,
  endKey: InlineEditableDetailKey
): InlineEditableDetailKey[] {
  const sourceIndex = BATCH_CREATE_FILL_ORDER.indexOf(sourceKey);
  const endIndex = BATCH_CREATE_FILL_ORDER.indexOf(endKey);
  if (sourceIndex === -1 || endIndex === -1) {
    return [sourceKey];
  }
  const start = Math.min(sourceIndex, endIndex);
  const end = Math.max(sourceIndex, endIndex);
  return BATCH_CREATE_FILL_ORDER.slice(start, end + 1);
}

function parseInlineCreatePlaceholderIndex(rowId: string): number | null {
  const matched = rowId.match(/^__inline-create__:(\d+)$/);
  if (!matched) {
    return null;
  }
  const parsed = Number(matched[1]);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isMeaningfulBatchCreateDraft(state: FormState): boolean {
  return Object.values(state).some((value) => String(value ?? "").trim().length > 0);
}

function buildBatchCreateFieldErrors(
  state: FormState,
  t: (key: string, options?: Record<string, unknown>) => string
): BatchCreateFieldErrorMap {
  const errors: BatchCreateFieldErrorMap = {};
  const isPlannedIdleYes = state.plannedIdle.trim() === "Yes";
  const requiredFields: InlineEditableDetailKey[] = [
    "date",
    "machineId",
    "operatorId",
    "startTime",
    "endTime",
  ];
  if (!isPlannedIdleYes) {
    requiredFields.push("productionQty");
  }

  for (const field of requiredFields) {
    if (!String(state[field] ?? "").trim()) {
      errors[field] = t("workReport:reportForm.validation.requiredField", { field });
    }
  }

  if (state.startTime.trim() && !/^\d{2}:\d{2}$/.test(state.startTime.trim())) {
    errors.startTime = t("workReport:reportForm.validation.invalidTime", { field: "startTime" });
  }
  if (state.endTime.trim() && !/^\d{2}:\d{2}$/.test(state.endTime.trim())) {
    errors.endTime = t("workReport:reportForm.validation.invalidTime", { field: "endTime" });
  }
  if (state.productionQty.trim()) {
    const productionQty = Number(state.productionQty);
    if (!Number.isFinite(productionQty) || productionQty < 0) {
      errors.productionQty = t("workReport:reportForm.validation.invalidProductionQty");
    }
  }
  if (state.breakTime.trim()) {
    const breakTime = Number(state.breakTime);
    if (!Number.isFinite(breakTime) || breakTime < 0) {
      errors.breakTime = t("workReport:reportForm.validation.invalidBreakTime");
    }
  }
  return errors;
}
const ALWAYS_AVAILABLE_DETAIL_DYNAMIC_KEYS: ReadonlyArray<string> = [
  "開單者帳號",
  "NO.單號",
  "(1012831)[實際]生產時間(分) (總時數-架調車-非擔當)",
  "Time Used %工時耗用率%1",
  "Prod.Type製程大分類代碼",
  "Proc. Name製程別名稱",
  "Type報工類別",
  "Created建立日期時間",
  "Dep.報工單位別",
  "[Default]Efficiency Standard[預設]製程標準預設使用中檢查碼",
  "[Default]Efficiency Code[預設]製程標準識別碼",
  "[Assigned]Efficiency Standard[指定]製程標準識別碼",
  "[分類生產產量]HF01",
  "[分類生產產量]HF02",
  "組成測試[可刪]",
  "[HF01]依序累計量(pcs)",
  "[HF02]依序累計量(pcs)",
  "ERP Part No.完工ERP料號",
  "機台主要操作者工號",
];
const DEFAULT_HIDDEN_DETAIL_COLUMNS = new Set<string>([
  "reportType",
  "rowId",
  "Prod.Type製程大分類代碼",
  "Proc. Name製程別名稱",
  "Type報工類別",
  "Created建立日期時間",
  "Dep.報工單位別",
  "[Default]Efficiency Standard[預設]製程標準預設使用中檢查碼",
  "[Default]Efficiency Code[預設]製程標準識別碼",
  "[Assigned]Efficiency Standard[指定]製程標準識別碼",
  "[分類生產產量]HF01",
  "[分類生產產量]HF02",
  "組成測試[可刪]",
  "[HF01]依序累計量(pcs)",
  "[HF02]依序累計量(pcs)",
  "ERP Part No.完工ERP料號",
  "機台主要操作者工號",
]);
const INLINE_EDITABLE_DETAIL_KEYS_BY_FORM: Record<WorkReportFormId, readonly InlineEditableDetailKey[]> = {
  "104": [
    "date",
    "plannedIdle",
    "machineId",
    "operatorId",
    "processCode",
    "inputOptions",
    "shiftType",
    "startTime",
    "endTime",
    "breakTime",
    "productionQty",
    "remark",
    "setupAdjustType",
    "setupAdjustMinutes",
    "countSetupTimeFlag",
    "setupTimeStandardHours",
    "setupLossQtyPerPcs",
    "processLossQtyPerPcs",
    "totalContainerQty",
    "containerUnit",
    "plannedIdleMinutes",
    "unplannedIdleMinutes",
    "absentOrTrainingMinutes",
    "noMaterialMinutes",
    "waitingQcApprovalMinutes",
    "meetingMinutes",
    "cleaningMinutes",
    "rdSamplingMinutes",
    "supportOtherMachinesMinutes",
    "machineBreakdownMinutes",
    "machineAdjustmentMinutes",
    "othersMinutes",
    "waitingForDiesMinutes",
    "testingDiesMinutes",
  ],
  "105": [
    "date",
    "plannedIdle",
    "machineId",
    "operatorId",
    "processCode",
    "inputOptions",
    "shiftType",
    "startTime",
    "endTime",
    "breakTime",
    "productionQty",
    "remark",
    "setupAdjustType",
    "setupAdjustMinutes",
    "countSetupTimeFlag",
    "setupTimeStandardHours",
    "setupLossQtyPerPcs",
    "processLossQtyPerPcs",
    "totalContainerQty",
    "containerUnit",
    "plannedIdleMinutes",
    "unplannedIdleMinutes",
    "absentOrTrainingMinutes",
    "noMaterialMinutes",
    "waitingQcApprovalMinutes",
    "meetingMinutes",
    "cleaningMinutes",
    "rdSamplingMinutes",
    "supportOtherMachinesMinutes",
    "machineBreakdownMinutes",
    "machineAdjustmentMinutes",
    "othersMinutes",
    "waitingForDiesMinutes",
    "testingDiesMinutes",
  ],
};

function isSupportedFormId(value: string | undefined): value is WorkReportFormId {
  return value !== undefined && SUPPORTED_FORM_IDS.has(value as WorkReportFormId);
}

function isCreatePlaceholderRow(row: DetailTableRow): boolean {
  return row.__placeholder === true;
}

function buildCreatePlaceholderRow(index: number): DetailTableRow {
  return {
    __placeholder: true,
    rowId: `${INLINE_CREATE_PLACEHOLDER_ROW_PREFIX}:${index}`,
    date: null,
    reportType: null,
    plannedIdle: null,
    processCode: null,
    processCodeDisplay: null,
    machineId: null,
    machineIdDisplay: null,
    operatorId: null,
    operatorIdDisplay: null,
    operatorName: null,
    inputOptions: null,
    shiftType: null,
    startTime: null,
    endTime: null,
    breakTime: null,
    totalWorkTime: null,
    productionQty: null,
    cumulativeQty: null,
    remark: null,
    setupAdjustType: null,
    setupAdjustMinutes: null,
    countSetupTimeFlag: null,
    setupTimeStandardHours: null,
    setupLossQtyPerPcs: null,
    processLossQtyPerPcs: null,
    totalContainerQty: null,
    containerUnit: null,
    plannedIdleMinutes: null,
    unplannedIdleMinutes: null,
    absentOrTrainingMinutes: null,
    noMaterialMinutes: null,
    waitingQcApprovalMinutes: null,
    meetingMinutes: null,
    cleaningMinutes: null,
    rdSamplingMinutes: null,
    supportOtherMachinesMinutes: null,
    machineBreakdownMinutes: null,
    machineAdjustmentMinutes: null,
    othersMinutes: null,
    waitingForDiesMinutes: null,
    testingDiesMinutes: null,
  };
}

function normalizeSearch(search: string | undefined | null): string {
  const raw = String(search ?? "").trim();
  if (!raw) {
    return "";
  }
  return raw.startsWith("?") ? raw : `?${raw}`;
}

function createClientMutationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRetryableMutationError(error: unknown): boolean {
  if (!(error instanceof AxiosError)) {
    return false;
  }
  if (!error.response) {
    return true;
  }
  return error.response.status >= 500;
}

function writePendingMutationReplay(pending: PendingMutationReplay): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(
    WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY,
    JSON.stringify(pending)
  );
}

function clearPendingMutationReplay(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.removeItem(WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY);
}

function readDetailHiddenColumnsByForm(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(DETAIL_HIDDEN_COLUMNS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const normalized: Record<string, string[]> = {};
    for (const [formKey, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const keys = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      normalized[formKey] = Array.from(new Set(keys));
    }
    return normalized;
  } catch {
    return {};
  }
}

function writeDetailHiddenColumnsByForm(nextState: Record<string, string[]>): void {
  try {
    window.localStorage.setItem(DETAIL_HIDDEN_COLUMNS_STORAGE_KEY, JSON.stringify(nextState));
  } catch {
    // NOTE: localStorage 寫入失敗時不阻塞主要流程
  }
}

function isInteractiveClickTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest("button,a,input,select,textarea,label,[role='button'],[data-prevent-row-click='true']")
  );
}

export function WorkReportDetailPage() {
  const { formId: rawFormId, entryId } = useParams<{ formId: string; entryId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { i18n, t } = useTranslation(["workReport", "common"]);
  const { createTaskMonitors, upsertCreateTaskMonitor } = useWorkReportTaskMonitorContext();

  const uiLanguage: UiLanguage =
    (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith("en") ? "en" : "zh";
  const isValidRoute = isSupportedFormId(rawFormId) && Boolean(entryId?.trim());
  const formId = isValidRoute ? rawFormId : null;
  const safeEntryId = (entryId ?? "").trim();
  const logDetailEvent = useCallback(
    (
      category: WorkReportFrontendEventCategory,
      action: WorkReportFrontendEventAction,
      summary: string,
      options: {
        level?: "info" | "warn" | "error";
        rowId?: string;
        taskId?: string;
        clientMutationId?: string;
        operationId?: string;
        operationType?: string;
        phase?: string;
        durationMs?: number;
        startedAt?: string;
        endedAt?: string;
        meta?: Record<string, string | number | boolean | null | undefined | string[]>;
      } = {}
    ) => {
      pushFrontendEvent({
        level: options.level ?? (category === "realtime" ? "warn" : "info"),
        category,
        action,
        summary,
        operationId: options.operationId,
        operationType: options.operationType,
        phase: options.phase,
        durationMs: options.durationMs,
        startedAt: options.startedAt,
        endedAt: options.endedAt,
        formId: formId ?? undefined,
        entryId: safeEntryId || undefined,
        rowId: options.rowId,
        taskId: options.taskId,
        clientMutationId: options.clientMutationId,
        meta: options.meta,
      });
    },
    [formId, safeEntryId]
  );
  const listReturnState = useMemo((): WorkReportListLocationState | undefined => {
    const state = (location.state as WorkReportListLocationState | null) ?? null;
    const listSearch =
      normalizeSearch(state?.listSearch) ||
      normalizeSearch(location.search);
    const listAnchor = state?.listAnchor;
    const listViewState = state?.listViewState;
    if (!listSearch && !listAnchor && !listViewState) {
      return undefined;
    }
    return {
      listSearch: listSearch || undefined,
      listAnchor,
      listViewState,
    };
  }, [location.state, location.search]);
  const backToListUrl = useMemo(() => {
    const listSearch = normalizeSearch(listReturnState?.listSearch);
    return listSearch ? `/${listSearch}` : "/";
  }, [listReturnState?.listSearch]);

  const [record, setRecord] = useState<WorkReportRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);
  const [taskQueueDrawerOpen, setTaskQueueDrawerOpen] = useState(false);
  const [batchCreateMode, setBatchCreateMode] = useState(false);
  const [batchCreateDraftsByRowId, setBatchCreateDraftsByRowId] = useState<Record<string, FormState>>(
    {}
  );
  // 每個 placeholder rowId 對應一個穩定的 clientRowKey（UUID），送出時帶給後端做 idempotency
  // retry 時重用同一 key → backend 查 SQLite 命中就不重複建立
  const [batchCreateClientKeysByRowId, setBatchCreateClientKeysByRowId] = useState<Record<string, string>>(
    {}
  );
  const [batchCreateFieldErrorsByRowId, setBatchCreateFieldErrorsByRowId] = useState<
    Record<string, BatchCreateFieldErrorMap>
  >({});
  const [batchCreateFillDrag, setBatchCreateFillDrag] = useState<BatchCreateFillDragState | null>(null);
  const [batchDeleteMode, setBatchDeleteMode] = useState(false);
  const [selectedBatchDeleteRowIds, setSelectedBatchDeleteRowIds] = useState<Set<string>>(
    () => new Set()
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlightedDetailRowId, setHighlightedDetailRowId] = useState<string | null>(null);
  const [formOptionsByForm, setFormOptionsByForm] = useState<
    Partial<Record<WorkReportFormId, FormOptionMap>>
  >({});
  const [optionsLoadingByForm, setOptionsLoadingByForm] = useState<
    Partial<Record<WorkReportFormId, boolean>>
  >({});
  const optionsLoadPromiseRef = useRef<
    Partial<Record<WorkReportFormId, Promise<FormOptionMap>>>
  >({});
  const trackingBatchCreateTaskIdsRef = useRef(new Set<string>());
  const pendingBatchCreateHighlightRef = useRef<{
    rowId: string | null;
    message: string;
  } | null>(null);
  const [workOrderClosing, setWorkOrderClosing] = useState(false);
  const [workOrderConfirmAction, setWorkOrderConfirmAction] = useState<"close" | "reopen" | null>(null);
  const [entryEditingSummary, setEntryEditingSummary] = useState<EditingPresenceSnapshot | null>(null);
  const [editLockRowId, setEditLockRowId] = useState<string | null>(null);
  const [editLockVersion, setEditLockVersion] = useState<number | null>(null);
  const [hiddenColumnsByForm, setHiddenColumnsByForm] = useState<Record<string, string[]>>(
    () => readDetailHiddenColumnsByForm()
  );
  const ragicEntryUrl = useMemo(() => {
    if (!formId || !safeEntryId || !record?.workOrderNo) {
      return null;
    }
    const ragicBaseUrl = String(import.meta.env.VITE_RAGIC_BASE_URL ?? "https://demo.local")
      .trim()
      .replace(/\/+$/, "");
    if (!ragicBaseUrl) {
      return null;
    }
    const ragicFormPathByFormId: Record<WorkReportFormId, string> = {
      "104": "/default/forms8/104",
      "105": "/default/forms8/105",
    };
    const ragicFormPath = ragicFormPathByFormId[formId];
    if (!ragicFormPath) {
      return null;
    }
    return `${ragicBaseUrl}${ragicFormPath}/${encodeURIComponent(safeEntryId)}`;
  }, [formId, record?.workOrderNo, safeEntryId]);
  const hiddenColumnKeys = useMemo(() => {
    if (!formId) {
      return new Set<string>(DEFAULT_HIDDEN_DETAIL_COLUMNS);
    }
    if (Object.prototype.hasOwnProperty.call(hiddenColumnsByForm, formId)) {
      return new Set<string>(hiddenColumnsByForm[formId] ?? []);
    }
    return new Set<string>(DEFAULT_HIDDEN_DETAIL_COLUMNS);
  }, [formId, hiddenColumnsByForm]);
  const inlineEditableColumnKeySet = useMemo<Set<InlineEditableDetailKey>>(() => {
    if (!formId) {
      return new Set<InlineEditableDetailKey>();
    }
    const supportedKeys = INLINE_EDITABLE_DETAIL_KEYS_BY_FORM[formId] ?? [];
    return new Set<InlineEditableDetailKey>(supportedKeys.filter((key) => !hiddenColumnKeys.has(key)));
  }, [formId, hiddenColumnKeys]);
  const editingPresenceSessionIdRef = useRef(readOrCreateEditingPresenceSessionId());

  const loadEntry = useCallback(async (options: LoadEntryOptions = {}) => {
    const { silent = false, forceRefresh = false } = options;
    if (!formId || !safeEntryId) {
      return;
    }
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setLoadError(null);
    try {
      const nextRecord = normalizeRecord(
        await fetchWorkReportEntry(formId, safeEntryId, forceRefresh),
        true
      );
      setRecord(nextRecord);
    } catch (error) {
      const message = getErrorMessage(error);
      setLoadError(message);
      setNotice({ type: "error", message });
    } finally {
      if (silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [formId, safeEntryId]);


  const currentEditSessionId = editingPresenceSessionIdRef.current;
  const clearActiveRowEditLock = useCallback(() => {
    setEditLockRowId(null);
    setEditLockVersion(null);
  }, []);

  const formOptions = useMemo<FormOptionMap>(() => {
    if (!formId) {
      return EMPTY_OPTIONS;
    }
    return formOptionsByForm[formId] ?? EMPTY_OPTIONS;
  }, [formId, formOptionsByForm]);

  const optionsLoading = formId ? Boolean(optionsLoadingByForm[formId]) : false;

  const ensureOptionsLoaded = useCallback(
    async (options: { silent?: boolean } = {}): Promise<FormOptionMap> => {
      if (!formId) {
        return EMPTY_OPTIONS;
      }

      const requestedFormId = formId;
      const cachedOptions = formOptionsByForm[requestedFormId];
      if (cachedOptions) {
        return cachedOptions;
      }

      const inflightPromise = optionsLoadPromiseRef.current[requestedFormId];
      if (inflightPromise) {
        return inflightPromise;
      }

      setOptionsLoadingByForm((prev) => ({
        ...prev,
        [requestedFormId]: true,
      }));
      const loadPromise = (async () => {
        try {
          const data = await fetchFormOptions(requestedFormId, [
            "machineId",
            "operatorId",
            "processCode",
          ]);
          setFormOptionsByForm((prev) => ({
            ...prev,
            [requestedFormId]: data,
          }));
          return data;
        } catch (error) {
          if (!options.silent) {
            setNotice({
              type: "error",
              message: t("workReport:messages.failedLoadFormOptions", {
                error: getErrorMessage(error),
              }),
            });
          }
          return EMPTY_OPTIONS;
        } finally {
          setOptionsLoadingByForm((prev) => ({
            ...prev,
            [requestedFormId]: false,
          }));
          delete optionsLoadPromiseRef.current[requestedFormId];
        }
      })();

      optionsLoadPromiseRef.current[requestedFormId] = loadPromise;
      return loadPromise;
    },
    [formId, formOptionsByForm, t]
  );

  useEffect(() => {
    if (!isValidRoute || !formId) {
      return;
    }
    void ensureOptionsLoaded({ silent: true });
  }, [ensureOptionsLoaded, formId, isValidRoute]);

  const acquireRowEditLock = useCallback(async (rowId: string): Promise<number | null> => {
    if (!formId || !safeEntryId) {
      return null;
    }
    const normalizedRowId = String(rowId ?? "").trim();
    if (!normalizedRowId) {
      return null;
    }
    try {
      const snapshot = await updateEditingPresence(formId, safeEntryId, {
        sessionId: currentEditSessionId,
        rowId: normalizedRowId,
        active: true,
        state: "editing",
      });
      if (ROW_LOCK_DEBUG) {
        console.info("[row-lock-debug][frontend][acquire]", {
          formId,
          entryId: safeEntryId,
          rowId: normalizedRowId,
          sessionId: currentEditSessionId,
          snapshot,
        });
      }
      setEntryEditingSummary((prev) =>
        prev
          ? {
              ...prev,
              hasOtherEditors: false,
              otherEditorCount: 0,
              observedAt: snapshot.observedAt,
            }
          : prev
      );
      if (snapshot.canEdit) {
        setEditLockRowId(normalizedRowId);
        setEditLockVersion(snapshot.lockVersion ?? null);
        return snapshot.lockVersion ?? null;
      }
      setNotice({
        type: "error",
        message: t("workReport:detailPage.rowLockedByOtherEditor"),
      });
      return null;
    } catch (error) {
      setNotice({
        type: "error",
        message: getErrorMessage(error),
      });
      return null;
    }
  }, [currentEditSessionId, formId, safeEntryId, t]);

  const releaseRowEditLock = useCallback(async (rowId?: string | null): Promise<void> => {
    if (!formId || !safeEntryId) {
      return;
    }
    const normalizedRowId = String(rowId ?? editLockRowId ?? "").trim();
    if (!normalizedRowId) {
      clearActiveRowEditLock();
      return;
    }
    try {
      await updateEditingPresence(formId, safeEntryId, {
        sessionId: currentEditSessionId,
        rowId: normalizedRowId,
        active: false,
      });
      if (ROW_LOCK_DEBUG) {
        console.info("[row-lock-debug][frontend][release]", {
          formId,
          entryId: safeEntryId,
          rowId: normalizedRowId,
          sessionId: currentEditSessionId,
        });
      }
      setEntryEditingSummary((prev) =>
        prev
          ? {
              ...prev,
              hasOtherEditors: false,
              otherEditorCount: 0,
              observedAt: new Date().toISOString(),
            }
          : prev
      );
    } catch (error) {
      // NOTE: row lock 釋放失敗不阻塞 UI 收尾
      console.warn("[row-edit-lock-release-failed]", {
        formId,
        entryId: safeEntryId,
        rowId: normalizedRowId,
        error: getErrorMessage(error),
      });
    } finally {
      if (!rowId || normalizedRowId === editLockRowId) {
        clearActiveRowEditLock();
      }
    }
  }, [
    clearActiveRowEditLock,
    currentEditSessionId,
    editLockRowId,
    formId,
    safeEntryId,
  ]);

  useEffect(() => {
    if (!isValidRoute) {
      setLoading(false);
      setLoadError(t("workReport:detailPage.invalidRoute"));
      return;
    }
    void loadEntry();
  }, [isValidRoute, loadEntry, t]);

  useEffect(() => {
    const state =
      (location.state as { highlightRowId?: string; openTaskQueueDrawer?: boolean } | null) ?? null;
    if (state?.highlightRowId) {
      setHighlightedDetailRowId(state.highlightRowId);
    }
    if (state?.openTaskQueueDrawer) {
      setTaskQueueDrawerOpen(true);
    }
  }, [location.state]);

  useEffect(() => {
    if (!isValidRoute || !formId || !safeEntryId) {
      return;
    }

    const loadEditingSummary = async () => {
      try {
        const snapshot = await fetchEditingPresence(formId, safeEntryId, currentEditSessionId);
        setEntryEditingSummary(snapshot);
      } catch {
        // NOTE: entry editing summary 失敗不阻塞主流程
      }
    };

    void loadEditingSummary();
    const timer = window.setInterval(() => {
      void loadEditingSummary();
    }, 15_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [currentEditSessionId, formId, isValidRoute, safeEntryId]);

  useEffect(() => {
    if (!formId || !safeEntryId || !editLockRowId) {
      return;
    }

    const syncPresence = async (active: boolean) => {
      try {
        const snapshot = await updateEditingPresence(formId, safeEntryId, {
          sessionId: editingPresenceSessionIdRef.current,
          rowId: editLockRowId,
          active,
          state: "editing",
        });
        setEntryEditingSummary((prev) =>
          prev
            ? {
                ...prev,
                hasOtherEditors: false,
                otherEditorCount: 0,
                observedAt: snapshot.observedAt,
              }
            : prev
        );
        setEditLockVersion(
          snapshot.isCurrentSessionOwner ? (snapshot.lockVersion ?? null) : null
        );
        if (!snapshot.canEdit) {
          setNotice({
            type: "error",
            message: t("workReport:detailPage.rowLockedByOtherEditor"),
          });
          clearActiveRowEditLock();
        }
      } catch {
        // NOTE: presence heartbeat 失敗時不阻塞編輯
      }
    };

    void syncPresence(true);
    const timer = window.setInterval(() => {
      void syncPresence(true);
    }, 15_000);

    return () => {
      window.clearInterval(timer);
      void syncPresence(false);
    };
  }, [clearActiveRowEditLock, editLockRowId, formId, safeEntryId, t]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => {
      setNotice(null);
    }, 10_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);

  useEffect(() => {
    return () => {
      void releaseRowEditLock();
    };
  }, [releaseRowEditLock]);

  const {
    currentEntryTaskMonitors,
    activeMutationTask,
    activeMutationTaskCount,
    hasActiveMutationTask,
    hasBlockingMutationTask,
    registerAcceptedMutationTask,
  } = useWorkReportDetailTaskController({
    formId,
    safeEntryId,
    workOrderNo: record?.workOrderNo,
    createTaskMonitors,
    upsertCreateTaskMonitor,
    logDetailEvent,
    t,
  });
  const {
    modalState,
    createFormResetToken,
    openCreateModal,
    openEditModal,
    closeModal,
    handleSubmit,
  } = useWorkReportDetailModalController({
    formId,
    safeEntryId,
    workOrderNo: record?.workOrderNo ?? null,
    hasActiveMutationTask,
    hasBlockingMutationTask,
    ensureOptionsLoaded,
    acquireRowEditLock,
    releaseRowEditLock,
    clearActiveRowEditLock,
    currentEditSessionId,
    editLockVersion,
    setSubmitting,
    submitting,
    registerAcceptedMutationTask,
    createClientMutationId,
    writePendingMutationReplay,
    clearPendingMutationReplay,
    isRetryableMutationError,
    summarizeChangedPayloadFields,
    logDetailEvent,
    setNotice,
    t,
  });
  const {
    editingRowId,
    editingRowDraft,
    savingRowId,
    linkedPickerState,
    autoHighlightedInlineKeys,
    inlineTimeWarningField,
    detailTableScrollRef,
    inlineMachineOptions,
    inlineOperatorOptions,
    inlineProcessOptions,
    inputOptionPickerOptions,
    shiftTypePickerOptions,
    selectedInlineMachineOption,
    selectedInlineOperatorOption,
    selectedInlineProcessOption,
    selectedInlineInputOption,
    selectedInlineShiftTypeOption,
    setEditingRowDraft,
    activateInlineCreateRow,
    startInlineRowEdit,
    handleDetailTableKeyDown,
    updateEditingRowField,
    updateEditingTimeField,
    handleInlinePlannedIdleChange,
    cancelInlineRowEdit,
    openLinkedPicker,
    closeLinkedPicker,
    updateLinkedPickerSearch,
    handleLinkedOptionSelect,
    saveInlineRowEdit,
  } = useWorkReportDetailInlineController({
    formId,
    safeEntryId,
    record,
    workOrderNo: record?.workOrderNo ?? null,
    modalOpen: modalState.open,
    submitting,
    currentEditSessionId,
    editLockVersion,
    inlineEditableColumnKeySet,
    ensureOptionsLoaded,
    formOptions,
    acquireRowEditLock,
    releaseRowEditLock,
    clearActiveRowEditLock,
    setNotice,
    logDetailEvent,
    registerAcceptedMutationTask,
    createClientMutationId,
    writePendingMutationReplay,
    clearPendingMutationReplay,
    isRetryableMutationError,
    summarizeChangedPayloadFields,
    isCreatePlaceholderRow,
    t,
  });
  const {
    mainMachineModalOpen,
    mainMachineDraft,
    mainMachinePickerOpen,
    mainMachinePickerSearch,
    mainMachineSaving,
    mainMachineSaveProgress,
    setMainMachineDraft,
    setMainMachinePickerOpen,
    setMainMachinePickerSearch,
    openMainMachineModal,
    closeMainMachineModal,
    submitMainMachineUpdate,
  } = useWorkReportMainMachineController({
    formId,
    safeEntryId,
    record,
    editingRowId,
    hasActiveMutationTask,
    modalOpen: modalState.open,
    loading,
    refreshing,
    submitting,
    ensureOptionsLoaded,
    loadEntry,
    setNotice,
    logDetailEvent,
    t,
  });
  const { realtimeConnected, realtimeDisconnectedSince } =
    useWorkReportDetailRefreshController({
      enabled: isValidRoute,
      formId,
      safeEntryId,
      modalOpen: modalState.open,
      editingRowId,
      hasActiveMutationTask,
      submitting,
      loading,
      refreshing,
      loadEntry,
      setNotice,
      logDetailEvent,
      t,
    });
  const { systemStatus } = useWorkReportDetailStatusController({
    formId,
    safeEntryId,
    workOrderNo: record?.workOrderNo ?? null,
    loading,
    refreshing,
    submitting,
    editingRowId,
    modalOpen: modalState.open,
    hasActiveMutationTask,
    currentEntryTaskMonitors,
    activeMutationTask,
    activeMutationTaskCount,
    registerAcceptedMutationTask,
    pendingMutationReplayStorageKey: WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY,
    setNotice,
    setHighlightedDetailRowId,
    loadEntry,
    releaseRowEditLock,
    notice,
    loadError,
    isValidRoute,
    realtimeConnected,
    realtimeDisconnectedSince,
    entryEditingSummary,
    t,
  });
  const { expireSession } = useWorkReportSessionExpiryGuard({
    enabled: isValidRoute,
    currentPath: location.pathname + location.search,
  });
  const { maintenanceMessage, blocked, blockedReason } = useWorkReportClientPresence({
    currentPath: location.pathname + location.search,
    currentFormId: formId,
    currentEntryId: safeEntryId,
    currentTopView: "detail",
    realtimeConnected,
    onForceSessionExpired: expireSession,
  });
  const canApplyBatchCreateHighlightImmediately = useCallback(() => (
    !modalState.open &&
    editingRowId === null &&
    !submitting &&
    !loading &&
    !refreshing &&
    !workOrderClosing &&
    !hasActiveMutationTask
  ), [
    editingRowId,
    hasActiveMutationTask,
    loading,
    modalState.open,
    refreshing,
    submitting,
    workOrderClosing,
  ]);
  const applyBatchCreateHighlight = useCallback(
    async (payload: { rowId: string | null; message: string }) => {
      await loadEntry({ silent: true, forceRefresh: false });
      if (payload.rowId) {
        setHighlightedDetailRowId(payload.rowId);
      }
      setNotice({
        type: "success",
        message: payload.message,
      });
    },
    [loadEntry]
  );
  const trackBatchCreateTask = useCallback(
    (taskId: string) => {
      if (!formId || !safeEntryId) {
        return;
      }
      if (trackingBatchCreateTaskIdsRef.current.has(taskId)) {
        return;
      }

      trackingBatchCreateTaskIdsRef.current.add(taskId);
      const currentFormId = formId;
      const currentEntryId = safeEntryId;

      const run = async () => {
        const startedAt = Date.now();
        try {
          while (Date.now() - startedAt <= CREATE_TASK_POLL_TIMEOUT_MS) {
            const task: WorkReportQueueTask = await fetchWorkReportQueueTask(
              currentFormId,
              taskId
            );
            if (task.formId !== currentFormId || task.entryId !== currentEntryId) {
              return;
            }

            if (task.status === "pending" || task.status === "running") {
              await new Promise<void>((resolve) => {
                window.setTimeout(resolve, CREATE_TASK_POLL_INTERVAL_MS);
              });
              continue;
            }

            if (task.status === "success") {
              // 成功即從 retry store 移除整條 retry 鏈（原始 + 所有 retry 版本）
              // 避免 badge 還顯示舊的失敗 record
              deleteRetryableBatchCreateRecordChain(taskId);
              const payload = {
                rowId: task.rowId ?? null,
                message: task.message ?? t("workReport:messages.realtimeRefreshApplied"),
              };
              if (canApplyBatchCreateHighlightImmediately()) {
                await applyBatchCreateHighlight(payload);
              } else {
                pendingBatchCreateHighlightRef.current = payload;
              }
              return;
            }

            setNotice({
              type: "error",
              message:
                task.errorMessage ??
                task.message ??
                t("workReport:messages.backgroundProcessingFailedDefault"),
            });
            return;
          }
        } catch (error) {
          setNotice({
            type: "error",
            message: getErrorMessage(error),
          });
        } finally {
          trackingBatchCreateTaskIdsRef.current.delete(taskId);
        }
      };

      void run();
    },
    [
      applyBatchCreateHighlight,
      canApplyBatchCreateHighlightImmediately,
      formId,
      safeEntryId,
      t,
    ]
  );

  useEffect(() => {
    setBatchCreateMode(false);
    setBatchCreateDraftsByRowId({});
    setBatchCreateFieldErrorsByRowId({});
    setBatchCreateFillDrag(null);
  }, [formId, safeEntryId]);

  // 有追蹤中的 batch create task 時，攔截關頁／重新整理，避免使用者沒看到結果就離開
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (trackingBatchCreateTaskIdsRef.current.size === 0) return;
      event.preventDefault();
      // 現代瀏覽器忽略自訂訊息，但仍會顯示原生「確定要離開嗎？」對話框
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    setBatchDeleteMode(false);
    setSelectedBatchDeleteRowIds(new Set());
  }, [formId, safeEntryId]);
  useEffect(() => {
    if (!batchCreateMode) {
      setBatchCreateFillDrag(null);
    }
  }, [batchCreateMode]);

  const detailRows = useMemo(() => record?.reports ?? [], [record]);
  useEffect(() => {
    if (!batchCreateMode || !editingRowId || !editingRowDraft) {
      return;
    }
    const placeholderIndex = parseInlineCreatePlaceholderIndex(editingRowId);
    if (placeholderIndex === null) {
      return;
    }
    setBatchCreateDraftsByRowId((previous) => ({
      ...previous,
      [editingRowId]: editingRowDraft,
    }));
  }, [batchCreateMode, editingRowDraft, editingRowId]);
  useEffect(() => {
    if (!batchCreateMode || !editingRowId || !editingRowDraft) {
      return;
    }
    if (!batchCreateFieldErrorsByRowId[editingRowId]) {
      return;
    }
    const nextRowErrors = buildBatchCreateFieldErrors(editingRowDraft, t);
    setBatchCreateFieldErrorsByRowId((previous) => {
      const existingErrors = previous[editingRowId];
      if (!existingErrors) {
        return previous;
      }
      const existingKeys = Object.keys(existingErrors);
      const nextKeys = Object.keys(nextRowErrors);
      const isSame =
        existingKeys.length === nextKeys.length &&
        existingKeys.every((key) => existingErrors[key as InlineEditableDetailKey] === nextRowErrors[key as InlineEditableDetailKey]);
      if (isSame) {
        return previous;
      }
      const next = { ...previous };
      if (Object.keys(nextRowErrors).length === 0) {
        delete next[editingRowId];
      } else {
        next[editingRowId] = nextRowErrors;
      }
      return next;
    });
  }, [batchCreateFieldErrorsByRowId, batchCreateMode, editingRowDraft, editingRowId, t]);
  const batchCreateDraftRowIds = useMemo(
    () =>
      Object.entries(batchCreateDraftsByRowId)
        .filter(([, draft]) => isMeaningfulBatchCreateDraft(draft))
        .map(([rowId]) => rowId)
        .sort((a, b) => (parseInlineCreatePlaceholderIndex(a) ?? 0) - (parseInlineCreatePlaceholderIndex(b) ?? 0)),
    [batchCreateDraftsByRowId]
  );
  const highestBatchCreateDraftIndex = useMemo(
    () => {
      const activePlaceholderIndex =
        batchCreateMode && editingRowId ? parseInlineCreatePlaceholderIndex(editingRowId) ?? -1 : -1;
      const previewPlaceholderIndex = batchCreateFillDrag?.endIndex ?? -1;
      return batchCreateDraftRowIds.reduce((maxValue, rowId) => {
        const index = parseInlineCreatePlaceholderIndex(rowId);
        return index === null ? maxValue : Math.max(maxValue, index);
      }, Math.max(activePlaceholderIndex, previewPlaceholderIndex));
    },
    [batchCreateDraftRowIds, batchCreateFillDrag?.endIndex, batchCreateMode, editingRowId]
  );
  const activeBatchCreatePlaceholderIndex = useMemo(
    () => (batchCreateMode && editingRowId ? parseInlineCreatePlaceholderIndex(editingRowId) : null),
    [batchCreateMode, editingRowId]
  );
  const createPlaceholderCount = batchCreateMode
    ? Math.max(
        INLINE_CREATE_PLACEHOLDER_COUNT,
        highestBatchCreateDraftIndex + INLINE_CREATE_TRAILING_PLACEHOLDER_COUNT + 1
      )
    : INLINE_CREATE_PLACEHOLDER_COUNT;
  const batchDeleteSelectableRowIds = useMemo(
    () => detailRows.map((item) => item.rowId).filter((rowId) => /^\d+$/.test(String(rowId ?? "").trim())),
    [detailRows]
  );
  const allBatchDeleteRowsSelected =
    batchDeleteSelectableRowIds.length > 0 &&
    batchDeleteSelectableRowIds.every((rowId) => selectedBatchDeleteRowIds.has(rowId));
  const displayDetailRows = useMemo<DetailTableRow[]>(
    () => [
      ...detailRows,
      ...Array.from({ length: createPlaceholderCount }, (_, index) =>
        buildCreatePlaceholderRow(index)
      ),
    ],
    [createPlaceholderCount, detailRows]
  );
  const getBatchCreateDraftForRow = useCallback(
    (rowId: string): FormState | null => {
      if (batchCreateMode && editingRowId === rowId && editingRowDraft) {
        return editingRowDraft;
      }
      return batchCreateDraftsByRowId[rowId] ?? null;
    },
    [batchCreateDraftsByRowId, batchCreateMode, editingRowDraft, editingRowId]
  );
  const isBatchCreateFillPreviewCell = useCallback(
    (rowId: string, key: InlineEditableDetailKey): boolean => {
      if (!batchCreateFillDrag) {
        return false;
      }
      if (!resolveBatchCreateFillKeys(batchCreateFillDrag.sourceKey, batchCreateFillDrag.endKey).includes(key)) {
        return false;
      }
      const rowIndex = parseInlineCreatePlaceholderIndex(rowId);
      if (rowIndex === null) {
        return false;
      }
      return rowIndex > batchCreateFillDrag.startIndex && rowIndex <= batchCreateFillDrag.endIndex;
    },
    [batchCreateFillDrag]
  );
  const getBatchCreateFillPreviewRowMeta = useCallback(
    (rowId: string) => {
      if (!batchCreateFillDrag) {
        return {
          isPreviewRow: false,
          isPreviewEndRow: false,
          previewLabel: null as string | null,
        };
      }
      const rowIndex = parseInlineCreatePlaceholderIndex(rowId);
      if (rowIndex === null) {
        return {
          isPreviewRow: false,
          isPreviewEndRow: false,
          previewLabel: null as string | null,
        };
      }
      const isPreviewRow =
        rowIndex > batchCreateFillDrag.startIndex && rowIndex <= batchCreateFillDrag.endIndex;
      const isPreviewEndRow = isPreviewRow && rowIndex === batchCreateFillDrag.endIndex;
      return {
        isPreviewRow,
        isPreviewEndRow,
        previewLabel: isPreviewEndRow
          ? t("workReport:detailPage.fillPreviewEndRow", { row: rowIndex + 1 })
          : null,
      };
    },
    [batchCreateFillDrag, t]
  );
  const activateBatchCreateRow = useCallback(
    async (rowId: string) => {
      if (record?.status === "已結案") {
        showClosedLockWarning(t("workReport:detailPage.closedLockedMessage"));
        return;
      }
      const existingDraft = batchCreateDraftsByRowId[rowId] ?? null;
      setBatchCreateMode(true);
      setBatchDeleteMode(false);
      // 第一次啟用這個 placeholder → 產生 UUID 當 idempotency key
      setBatchCreateClientKeysByRowId((previous) => {
        if (previous[rowId]) return previous;
        return { ...previous, [rowId]: crypto.randomUUID() };
      });
      await activateInlineCreateRow(rowId, existingDraft);
    },
    [activateInlineCreateRow, batchCreateDraftsByRowId, record?.status, t]
  );
  const cancelBatchCreate = useCallback(() => {
    setBatchCreateMode(false);
    setBatchCreateDraftsByRowId({});
    setBatchCreateClientKeysByRowId({});
    setBatchCreateFieldErrorsByRowId({});
    cancelInlineRowEdit();
  }, [cancelInlineRowEdit]);
  const cancelSingleBatchCreateRow = useCallback(
    (rowId: string) => {
      setBatchCreateDraftsByRowId((previous) => {
        if (!previous[rowId]) {
          return previous;
        }
        const next = { ...previous };
        delete next[rowId];
        return next;
      });
      setBatchCreateClientKeysByRowId((previous) => {
        if (!previous[rowId]) return previous;
        const next = { ...previous };
        delete next[rowId];
        return next;
      });
      setBatchCreateFieldErrorsByRowId((previous) => {
        if (!previous[rowId]) {
          return previous;
        }
        const next = { ...previous };
        delete next[rowId];
        return next;
      });
      if (editingRowId === rowId) {
        cancelInlineRowEdit();
      }
    },
    [cancelInlineRowEdit, editingRowId]
  );
  const clearBatchCreate = useCallback(async () => {
    setBatchCreateDraftsByRowId({});
    setBatchCreateClientKeysByRowId({});
    setBatchCreateFieldErrorsByRowId({});
    await activateBatchCreateRow(`${INLINE_CREATE_PLACEHOLDER_ROW_PREFIX}:0`);
  }, [activateBatchCreateRow]);
  const saveBatchCreate = useCallback(async () => {
    if (!formId || !safeEntryId || submitting) {
      return;
    }
    const draftEntries = Object.entries({
      ...batchCreateDraftsByRowId,
      ...(batchCreateMode && editingRowId && editingRowDraft ? { [editingRowId]: editingRowDraft } : {}),
    })
      .filter(([, draft]) => isMeaningfulBatchCreateDraft(draft))
      .sort(
        ([leftRowId], [rightRowId]) =>
          (parseInlineCreatePlaceholderIndex(leftRowId) ?? 0) -
          (parseInlineCreatePlaceholderIndex(rightRowId) ?? 0)
      );

    if (draftEntries.length === 0) {
      setNotice({ type: "info", message: t("workReport:detailPage.batchCreateNothingToSubmit") });
      return;
    }

    const nextErrors: Record<string, BatchCreateFieldErrorMap> = {};
    for (const [rowId, draft] of draftEntries) {
      const rowErrors = buildBatchCreateFieldErrors(draft, t);
      if (Object.keys(rowErrors).length > 0) {
        nextErrors[rowId] = rowErrors;
      }
    }
    setBatchCreateFieldErrorsByRowId(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setNotice({ type: "error", message: t("workReport:detailPage.batchCreateValidationHint") });
      const firstInvalidRowId = Object.keys(nextErrors).sort(
        (leftRowId, rightRowId) =>
          (parseInlineCreatePlaceholderIndex(leftRowId) ?? 0) -
          (parseInlineCreatePlaceholderIndex(rightRowId) ?? 0)
      )[0];
      await activateBatchCreateRow(firstInvalidRowId);
      return;
    }

    setSubmitting(true);
    try {
      // 組 rows：每筆帶上 placeholder rowId 對應的 clientRowKey（UUID）
      // 已經在 activateBatchCreateRow 產過 key；萬一缺（理論上不會）當場補一個
      const rows = draftEntries.map(([placeholderRowId, draft]) => {
        const clientRowKey =
          batchCreateClientKeysByRowId[placeholderRowId] ?? crypto.randomUUID();
        return {
          payload: buildReportMutationPayload(draft),
          clientRowKey,
        };
      });
      const accepted = await createReportsBatchAccepted(formId, safeEntryId, rows, {
        editSessionId: currentEditSessionId,
        workOrderNo: record?.workOrderNo ?? null,
      });
      saveRetryableBatchCreateRecord({
        taskId: accepted.taskId,
        retryRootTaskId: accepted.taskId,
        formId,
        entryId: safeEntryId,
        workOrderNo: record?.workOrderNo ?? null,
        rows,
        editSessionId: currentEditSessionId ?? undefined,
        createdAt: new Date().toISOString(),
      });
      setNotice({
        type: "success",
        message: t("workReport:detailPage.batchCreateAcceptedTask", { count: draftEntries.length }),
      });
      setBatchCreateFieldErrorsByRowId({});
      setBatchCreateDraftsByRowId({});
      setBatchCreateClientKeysByRowId({});
      setBatchCreateMode(false);
      cancelInlineRowEdit();
      setTaskQueueDrawerOpen(true);
      trackBatchCreateTask(accepted.taskId);
    } finally {
      setSubmitting(false);
    }
  }, [
    activateBatchCreateRow,
    batchCreateClientKeysByRowId,
    batchCreateDraftsByRowId,
    batchCreateMode,
    cancelInlineRowEdit,
    currentEditSessionId,
    editingRowDraft,
    editingRowId,
    formId,
    record?.workOrderNo,
    safeEntryId,
    submitting,
    trackBatchCreateTask,
    t,
  ]);
  const handleFillPreviewHover = useCallback(
    (rowId: string, key: InlineEditableDetailKey) => {
      setBatchCreateFillDrag((previous) => {
        if (!previous) {
          return previous;
        }
        if (!BATCH_CREATE_FILLABLE_KEYS.has(key)) {
          return previous;
        }
        const hoverIndex = parseInlineCreatePlaceholderIndex(rowId);
        if (hoverIndex === null || hoverIndex < previous.startIndex) {
          return previous;
        }
        if (hoverIndex === previous.endIndex && previous.endKey === key) {
          return previous;
        }
        return {
          ...previous,
          endKey: key,
          endIndex: hoverIndex,
        };
      });
    },
    []
  );
  const finalizeBatchCreateFill = useCallback(async () => {
    const fillState = batchCreateFillDrag;
    setBatchCreateFillDrag(null);
    if (!fillState || !formId) {
      return;
    }
    if (!editingRowDraft || editingRowId !== fillState.sourceRowId) {
      return;
    }
    if (fillState.endIndex <= fillState.startIndex) {
      return;
    }

    const fillKeys = resolveBatchCreateFillKeys(fillState.sourceKey, fillState.endKey);
    const nextDrafts: Record<string, FormState> = {};
    const nextErrors = { ...batchCreateFieldErrorsByRowId };

    for (let index = fillState.startIndex + 1; index <= fillState.endIndex; index += 1) {
      const targetRowId = `${INLINE_CREATE_PLACEHOLDER_ROW_PREFIX}:${index}`;
      const baseDraft =
        batchCreateDraftsByRowId[targetRowId] ??
        buildInitialFormState(
          formId,
          "create",
          null,
          record,
          formOptions.machineId ?? [],
          formOptions.operatorId ?? []
        );
      const nextDraft: FormState = {
        ...baseDraft,
      };
      for (const fillKey of fillKeys) {
        nextDraft[fillKey] = String(editingRowDraft[fillKey] ?? "");
      }
      nextDrafts[targetRowId] = nextDraft;
      const rowErrors = buildBatchCreateFieldErrors(nextDraft, t);
      if (Object.keys(rowErrors).length > 0) {
        nextErrors[targetRowId] = rowErrors;
      } else {
        delete nextErrors[targetRowId];
      }
    }

    if (Object.keys(nextDrafts).length > 0) {
      setBatchCreateDraftsByRowId((previous) => ({
        ...previous,
        ...nextDrafts,
      }));
      setBatchCreateFieldErrorsByRowId(nextErrors);
    }
  }, [
    batchCreateDraftsByRowId,
    batchCreateFieldErrorsByRowId,
    batchCreateFillDrag,
    editingRowDraft,
    editingRowId,
    formId,
    formOptions.machineId,
    formOptions.operatorId,
    record,
    t,
  ]);
  useEffect(() => {
    if (!batchCreateFillDrag) {
      return;
    }
    const handleMouseUp = () => {
      void finalizeBatchCreateFill();
    };
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [batchCreateFillDrag, finalizeBatchCreateFill]);
  useEffect(() => {
    if (!highlightedDetailRowId) {
      return;
    }

    const timer = window.setTimeout(() => {
      setHighlightedDetailRowId(null);
    }, 1500);

    window.requestAnimationFrame(() => {
      const row = detailTableScrollRef.current?.querySelector<HTMLElement>(
        `tr[data-row-id="${highlightedDetailRowId}"]`
      );
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    return () => {
      window.clearTimeout(timer);
    };
  }, [detailRows, detailTableScrollRef, highlightedDetailRowId]);
  useEffect(() => {
    const pendingPayload = pendingBatchCreateHighlightRef.current;
    if (!pendingPayload) {
      return;
    }
    if (!canApplyBatchCreateHighlightImmediately()) {
      return;
    }

    pendingBatchCreateHighlightRef.current = null;
    void applyBatchCreateHighlight(pendingPayload);
  }, [applyBatchCreateHighlight, canApplyBatchCreateHighlightImmediately]);
  useEffect(() => {
    if (!batchCreateMode || activeBatchCreatePlaceholderIndex === null) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const scrollRoot = detailTableScrollRef.current;
      if (!scrollRoot) {
        return;
      }

      const trailingTargetIndex = Math.min(
        createPlaceholderCount - 1,
        activeBatchCreatePlaceholderIndex + INLINE_CREATE_TRAILING_PLACEHOLDER_COUNT
      );
      const trailingTargetRow = scrollRoot.querySelector<HTMLElement>(
        `tr[data-row-id="${INLINE_CREATE_PLACEHOLDER_ROW_PREFIX}:${trailingTargetIndex}"]`
      );
      if (trailingTargetRow) {
        trailingTargetRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }

      const activeRow = editingRowId
        ? scrollRoot.querySelector<HTMLElement>(`tr[data-row-id="${editingRowId}"]`)
        : null;
      activeRow?.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    activeBatchCreatePlaceholderIndex,
    batchCreateMode,
    createPlaceholderCount,
    detailTableScrollRef,
    editingRowId,
  ]);
  const fixedExtraColumns = useMemo<ReadonlyArray<OrderedDetailColumn>>(() => {
    if (formId !== "104" && formId !== "105") {
      return [];
    }
    return [...SETUP_COLUMNS_ORDER_104, ...REASON_COLUMNS_ORDER_104].map((col) => ({
      ...col,
      label: t(col.label),
    }));
  }, [formId, t]);
  const extraDetailKeys = useMemo(() => {
    const knownKeys = new Set<string>(BASE_DETAIL_KEYS);
    for (const column of fixedExtraColumns) {
      knownKeys.add(column.key);
    }
    const dynamicKeys: string[] = [];
    const seen = new Set<string>();
    for (const key of ALWAYS_AVAILABLE_DETAIL_DYNAMIC_KEYS) {
      if (knownKeys.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      dynamicKeys.push(key);
    }
    for (const row of detailRows) {
      const rowRecord = row as Record<string, unknown>;
      for (const key of Object.keys(rowRecord)) {
        if (knownKeys.has(key)) {
          continue;
        }
        if (key.endsWith("Display")) {
          continue;
        }
        const value = rowRecord[key];
        if (value === null || value === undefined) {
          continue;
        }
        if (typeof value === "string" && value.trim() === "") {
          continue;
        }
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        dynamicKeys.push(key);
      }
    }
    return dynamicKeys;
  }, [detailRows, fixedExtraColumns]);
  const formatDetailValue = useCallback((value: unknown): string => {
    if (value === null || value === undefined) {
      return "-";
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : "-";
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return "-";
  }, []);
  const displayDetailRowMetaByRowId = useMemo(() => {
    const metaByRowId = new Map<
      string,
      {
        previousDate: string;
        currentDate: string;
        groupIndex: number;
      }
    >();
    let previousDate = "";
    let groupIndex = 0;

    displayDetailRows.forEach((row, index) => {
      const currentDate = formatDetailValue(row.date);
      if (index > 0 && previousDate !== currentDate) {
        groupIndex += 1;
      }
      metaByRowId.set(row.rowId, {
        previousDate: index > 0 ? previousDate : "",
        currentDate,
        groupIndex,
      });
      previousDate = currentDate;
    });

    return metaByRowId;
  }, [displayDetailRows, formatDetailValue]);
  const renderDetailCell = useCallback(
    (value: unknown) => {
      const text = formatDetailValue(value);
      return (
        <span className={text === "-" ? "detail-cell-empty" : "detail-cell-value"}>
          {text}
        </span>
      );
    },
    [formatDetailValue]
  );
  const renderStaticDetailCell = useCallback(
    (
      item: DetailTableRow,
      value: unknown,
      key?: InlineEditableDetailKey | string
    ) => {
      const normalized = String(value ?? "").trim();
      if (key === "plannedIdle" && isPlannedIdleYesValue(value)) {
        return <span className="detail-boolean-check" aria-label="Planned idle">✓</span>;
      }
      if (key === "plannedIdle" && normalized === "No") {
        return <span className="detail-cell-placeholder-empty" aria-hidden="true" />;
      }
      if (key === "countSetupTimeFlag" && normalized === "v") {
        return <span className="detail-boolean-check" aria-label="Count setup time">✓</span>;
      }
      if (key === "countSetupTimeFlag" && normalized.length === 0) {
        return <span className="detail-cell-placeholder-empty" aria-hidden="true" />;
      }
      const text = formatDetailValue(value);
      if (isCreatePlaceholderRow(item) && text === "-") {
        return <span className="detail-cell-placeholder-empty" aria-hidden="true" />;
      }
      return renderDetailCell(value);
    },
    [formatDetailValue, renderDetailCell]
  );
  const toggleColumnVisibility = useCallback(
    (columnKey: string) => {
      if (!formId) {
        return;
      }
      setHiddenColumnsByForm((previous) => {
        const baseHidden =
          Object.prototype.hasOwnProperty.call(previous, formId)
            ? previous[formId] ?? []
            : Array.from(DEFAULT_HIDDEN_DETAIL_COLUMNS);
        const nextHiddenSet = new Set(baseHidden);
        if (nextHiddenSet.has(columnKey)) {
          nextHiddenSet.delete(columnKey);
        } else {
          nextHiddenSet.add(columnKey);
        }
        const nextState = {
          ...previous,
          [formId]: Array.from(nextHiddenSet),
        };
        writeDetailHiddenColumnsByForm(nextState);
        return nextState;
      });
    },
    [formId]
  );
  const showAllColumns = useCallback(() => {
    if (!formId) {
      return;
    }
    setHiddenColumnsByForm((previous) => {
      const nextState = {
        ...previous,
        [formId]: [],
      };
      writeDetailHiddenColumnsByForm(nextState);
      return nextState;
    });
  }, [formId]);
  const resetDefaultColumns = useCallback(() => {
    if (!formId) {
      return;
    }
    setHiddenColumnsByForm((previous) => {
      const nextState = {
        ...previous,
        [formId]: Array.from(DEFAULT_HIDDEN_DETAIL_COLUMNS),
      };
      writeDetailHiddenColumnsByForm(nextState);
      return nextState;
    });
  }, [formId]);
  const isInlineEditableCell = useCallback(
    (rowId: string, key: InlineEditableDetailKey): boolean =>
      editingRowId === rowId && Boolean(editingRowDraft) && inlineEditableColumnKeySet.has(key),
    [editingRowDraft, editingRowId, inlineEditableColumnKeySet]
  );

  useEffect(() => {
    if (!editingRowId || !editingRowDraft) {
      return;
    }
    if (inlineEditableColumnKeySet.size > 0) {
      return;
    }
    setNotice({
      type: "info",
      message: t("workReport:detailPage.inlineEditorNoVisibleFields"),
    });
    cancelInlineRowEdit();
  }, [cancelInlineRowEdit, editingRowDraft, editingRowId, inlineEditableColumnKeySet, t]);
  const {
    blankTokenLabel,
    operatorGroupOptions,
    selectedOperatorGroupKey,
    handleOperatorGroupPreferenceChange,
    linkedPickerCopy,
    linkedPickerSelectedValue,
    currentLinkedPickerOption,
    linkedPickerTopContent,
    filteredLinkedPickerOptions,
    mainMachinePickerCopy,
    filteredMainMachinePickerOptions,
    currentMainMachineOption,
    mainMachinePickerTopContent,
  } = useWorkReportDetailPickerController({
    formId,
    t,
    formOptions,
    recordMachineCode: String(record?.machineCode ?? "").trim(),
    linkedPickerState,
    editingRowDraft,
    mainMachineDraft,
    mainMachinePickerSearch,
    selectedInlineMachineOption,
    inlineMachineOptions,
    inlineOperatorOptions,
    inlineProcessOptions,
    inputOptionPickerOptions,
    shiftTypePickerOptions,
  });

  const inlineEditorDefinitions = useMemo<Record<InlineEditableDetailKey, DetailInlineEditorDefinition>>(
    () => ({
      machineId: {
        key: "machineId",
        renderEditor: (rowId, draft) => (
          <DetailInlinePickerTrigger
            value={selectedInlineMachineOption?.value || draft.machineId}
            hint={
              selectedInlineMachineOption?.display &&
              selectedInlineMachineOption.display !== selectedInlineMachineOption.value
                ? selectedInlineMachineOption.display
                : null
            }
            blankLabel={blankTokenLabel}
            editorKey="machineId"
            disabled={savingRowId === rowId}
            onOpen={() => openLinkedPicker("machineId", rowId)}
          />
        ),
      },
      operatorId: {
        key: "operatorId",
        renderEditor: (rowId, draft) => (
          <DetailInlinePickerTrigger
            value={selectedInlineOperatorOption?.value || draft.operatorId}
            hint={
              selectedInlineOperatorOption?.display &&
              selectedInlineOperatorOption.display !== selectedInlineOperatorOption.value
                ? selectedInlineOperatorOption.display
                : null
            }
            blankLabel={blankTokenLabel}
            editorKey="operatorId"
            disabled={savingRowId === rowId}
            onOpen={() => openLinkedPicker("operatorId", rowId)}
          />
        ),
      },
      processCode: {
        key: "processCode",
        renderEditor: (rowId, draft) => (
          <DetailInlinePickerTrigger
            value={selectedInlineProcessOption?.value || draft.processCode}
            hint={
              selectedInlineProcessOption?.display &&
              selectedInlineProcessOption.display !== selectedInlineProcessOption.value
                ? selectedInlineProcessOption.display
                : null
            }
            blankLabel={blankTokenLabel}
            editorKey="processCode"
            disabled={savingRowId === rowId}
            onOpen={() => openLinkedPicker("processCode", rowId)}
          />
        ),
      },
      inputOptions: {
        key: "inputOptions",
        renderEditor: (rowId, draft) => (
          <DetailInlinePickerTrigger
            value={selectedInlineInputOption?.value || draft.inputOptions}
            hint={
              selectedInlineInputOption?.display &&
              selectedInlineInputOption.display !== selectedInlineInputOption.value
                ? selectedInlineInputOption.display
                : null
            }
            blankLabel={blankTokenLabel}
            editorKey="inputOptions"
            disabled={savingRowId === rowId}
            onOpen={() => openLinkedPicker("inputOptions", rowId)}
          />
        ),
      },
      shiftType: {
        key: "shiftType",
        renderEditor: (rowId, draft) => (
          <DetailInlinePickerTrigger
            value={selectedInlineShiftTypeOption?.value || draft.shiftType}
            hint={
              selectedInlineShiftTypeOption?.display &&
              selectedInlineShiftTypeOption.display !== selectedInlineShiftTypeOption.value
                ? selectedInlineShiftTypeOption.display
                : null
            }
            blankLabel={blankTokenLabel}
            editorKey="shiftType"
            disabled={savingRowId === rowId}
            onOpen={() => openLinkedPicker("shiftType", rowId)}
          />
        ),
      },
      startTime: {
        key: "startTime",
        renderEditor: (rowId, draft) => (
          <div className="detail-inline-time-editor">
            <input
              type="text"
              value={draft.startTime}
              inputMode="numeric"
              placeholder={t("workReport:reportForm.placeholders.timeInput")}
              onChange={(event) => updateEditingTimeField("startTime", event.target.value)}
              disabled={savingRowId === rowId}
              data-inline-editor-key="startTime"
              data-prevent-row-click="true"
            />
            {inlineTimeWarningField === "startTime" ? (
              <span className="detail-inline-time-error">
                {t("workReport:reportForm.validation.invalidTimeHint")}
              </span>
            ) : null}
          </div>
        ),
      },
      endTime: {
        key: "endTime",
        renderEditor: (rowId, draft) => (
          <div className="detail-inline-time-editor">
            <input
              type="text"
              value={draft.endTime}
              inputMode="numeric"
              placeholder={t("workReport:reportForm.placeholders.timeInput")}
              onChange={(event) => updateEditingTimeField("endTime", event.target.value)}
              disabled={savingRowId === rowId}
              data-inline-editor-key="endTime"
              data-prevent-row-click="true"
            />
            {inlineTimeWarningField === "endTime" ? (
              <span className="detail-inline-time-error">
                {t("workReport:reportForm.validation.invalidTimeHint")}
              </span>
            ) : null}
          </div>
        ),
      },
      breakTime: {
        key: "breakTime",
        renderEditor: (rowId, draft) => (
          <input
            type="text"
            value={draft.breakTime}
            onChange={(event) => updateEditingRowField("breakTime", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="breakTime"
            data-prevent-row-click="true"
          />
        ),
      },
      productionQty: {
        key: "productionQty",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.productionQty}
            onChange={(event) => updateEditingRowField("productionQty", event.target.value)}
            disabled={savingRowId === rowId || draft.plannedIdle?.trim() === "Yes"}
            data-inline-editor-key="productionQty"
            data-prevent-row-click="true"
          />
        ),
      },
      remark: {
        key: "remark",
        renderEditor: (rowId, draft) => (
          <textarea
            value={draft.remark}
            onChange={(event) => updateEditingRowField("remark", event.target.value)}
            rows={3}
            disabled={savingRowId === rowId}
            data-inline-editor-key="remark"
            data-prevent-row-click="true"
          />
        ),
      },
      setupAdjustType: {
        key: "setupAdjustType",
        renderEditor: (rowId, draft) => (
          <select
            value={draft.setupAdjustType}
            onChange={(event) => updateEditingRowField("setupAdjustType", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="setupAdjustType"
            data-prevent-row-click="true"
          >
            <option value="">-</option>
            <option value="(BA)架車">(BA)架車</option>
            <option value="(SA)調機">(SA)調機</option>
          </select>
        ),
      },
      setupAdjustMinutes: {
        key: "setupAdjustMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.setupAdjustMinutes}
            onChange={(event) => updateEditingRowField("setupAdjustMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="setupAdjustMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      countSetupTimeFlag: {
        key: "countSetupTimeFlag",
        renderEditor: (rowId, draft) => (
          <select
            value={draft.countSetupTimeFlag.trim() === "v" ? "v" : ""}
            onChange={(event) => updateEditingRowField("countSetupTimeFlag", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="countSetupTimeFlag"
            data-prevent-row-click="true"
          >
            <option value="">-</option>
            <option value="v">✓</option>
          </select>
        ),
      },
      plannedIdleMinutes: {
        key: "plannedIdleMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.plannedIdleMinutes}
            onChange={(event) => updateEditingRowField("plannedIdleMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="plannedIdleMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      unplannedIdleMinutes: {
        key: "unplannedIdleMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.unplannedIdleMinutes}
            onChange={(event) => updateEditingRowField("unplannedIdleMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="unplannedIdleMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      absentOrTrainingMinutes: {
        key: "absentOrTrainingMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.absentOrTrainingMinutes}
            onChange={(event) => updateEditingRowField("absentOrTrainingMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="absentOrTrainingMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      noMaterialMinutes: {
        key: "noMaterialMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.noMaterialMinutes}
            onChange={(event) => updateEditingRowField("noMaterialMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="noMaterialMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      waitingQcApprovalMinutes: {
        key: "waitingQcApprovalMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.waitingQcApprovalMinutes}
            onChange={(event) => updateEditingRowField("waitingQcApprovalMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="waitingQcApprovalMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      meetingMinutes: {
        key: "meetingMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.meetingMinutes}
            onChange={(event) => updateEditingRowField("meetingMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="meetingMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      cleaningMinutes: {
        key: "cleaningMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.cleaningMinutes}
            onChange={(event) => updateEditingRowField("cleaningMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="cleaningMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      rdSamplingMinutes: {
        key: "rdSamplingMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.rdSamplingMinutes}
            onChange={(event) => updateEditingRowField("rdSamplingMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="rdSamplingMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      supportOtherMachinesMinutes: {
        key: "supportOtherMachinesMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.supportOtherMachinesMinutes}
            onChange={(event) => updateEditingRowField("supportOtherMachinesMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="supportOtherMachinesMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      machineBreakdownMinutes: {
        key: "machineBreakdownMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.machineBreakdownMinutes}
            onChange={(event) => updateEditingRowField("machineBreakdownMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="machineBreakdownMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      machineAdjustmentMinutes: {
        key: "machineAdjustmentMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.machineAdjustmentMinutes}
            onChange={(event) => updateEditingRowField("machineAdjustmentMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="machineAdjustmentMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      othersMinutes: {
        key: "othersMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.othersMinutes}
            onChange={(event) => updateEditingRowField("othersMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="othersMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      waitingForDiesMinutes: {
        key: "waitingForDiesMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.waitingForDiesMinutes}
            onChange={(event) => updateEditingRowField("waitingForDiesMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="waitingForDiesMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      testingDiesMinutes: {
        key: "testingDiesMinutes",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.testingDiesMinutes}
            onChange={(event) => updateEditingRowField("testingDiesMinutes", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="testingDiesMinutes"
            data-prevent-row-click="true"
          />
        ),
      },
      date: {
        key: "date",
        renderEditor: (rowId, draft) => (
          <input
            type="date"
            value={draft.date}
            min="1900-01-01"
            max="9999-12-31"
            onChange={(event) => updateEditingRowField("date", normalizeDateInputValue(event.target.value))}
            onBlur={(event) => updateEditingRowField("date", normalizeDateInputValue(event.target.value))}
            disabled={savingRowId === rowId}
            data-inline-editor-key="date"
            data-prevent-row-click="true"
          />
        ),
      },
      plannedIdle: {
        key: "plannedIdle",
        renderEditor: (rowId, draft) => (
          <select
            value={draft.plannedIdle}
            onChange={(event) => handleInlinePlannedIdleChange(event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="plannedIdle"
            data-prevent-row-click="true"
          >
            <option value="">-</option>
            <option value="No">—</option>
            <option value="Yes">✓</option>
          </select>
        ),
      },
      setupTimeStandardHours: {
        key: "setupTimeStandardHours",
        renderEditor: (_rowId, draft) => (
          <input
            type="text"
            value={draft.setupTimeStandardHours}
            readOnly
            disabled
          />
        ),
      },
      setupLossQtyPerPcs: {
        key: "setupLossQtyPerPcs",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.setupLossQtyPerPcs}
            onChange={(event) => updateEditingRowField("setupLossQtyPerPcs", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="setupLossQtyPerPcs"
            data-prevent-row-click="true"
          />
        ),
      },
      processLossQtyPerPcs: {
        key: "processLossQtyPerPcs",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.processLossQtyPerPcs}
            onChange={(event) => updateEditingRowField("processLossQtyPerPcs", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="processLossQtyPerPcs"
            data-prevent-row-click="true"
          />
        ),
      },
      totalContainerQty: {
        key: "totalContainerQty",
        renderEditor: (rowId, draft) => (
          <input
            type="number"
            min="0"
            step="1"
            value={draft.totalContainerQty}
            onChange={(event) => updateEditingRowField("totalContainerQty", event.target.value)}
            disabled={savingRowId === rowId}
            data-inline-editor-key="totalContainerQty"
            data-prevent-row-click="true"
          />
        ),
      },
      containerUnit: {
        key: "containerUnit",
        renderEditor: (rowId, draft) => (
          <>
            <input
              type="text"
              list="detail-inline-container-unit-options"
              value={draft.containerUnit}
              onChange={(event) => updateEditingRowField("containerUnit", event.target.value)}
              disabled={savingRowId === rowId}
              data-inline-editor-key="containerUnit"
              data-prevent-row-click="true"
            />
            <datalist id="detail-inline-container-unit-options">
              <option value="桶Barrel">桶Barrel</option>
              <option value="箱Box">箱Box</option>
              <option value="袋Bag">袋Bag</option>
            </datalist>
          </>
        ),
      },
    }),
    [
      blankTokenLabel,
      inlineTimeWarningField,
      openLinkedPicker,
      savingRowId,
      selectedInlineInputOption,
      selectedInlineMachineOption,
      selectedInlineOperatorOption,
      selectedInlineProcessOption,
      selectedInlineShiftTypeOption,
      t,
      handleInlinePlannedIdleChange,
      updateEditingTimeField,
      updateEditingRowField,
    ]
  );
  const renderInlineEditableCell = useCallback(
    (item: DetailTableRow, key: InlineEditableDetailKey, displayValue: unknown) => {
      const batchCreateDraft = isCreatePlaceholderRow(item)
        ? getBatchCreateDraftForRow(item.rowId)
        : null;
      if (batchCreateMode && batchCreateDraft && editingRowId !== item.rowId) {
        return renderStaticDetailCell(item, batchCreateDraft[key], key);
      }
      if (!editingRowDraft || !isInlineEditableCell(item.rowId, key)) {
        return renderStaticDetailCell(item, displayValue, key);
      }
      const editor = inlineEditorDefinitions[key].renderEditor(item.rowId, editingRowDraft);
      const shouldRenderFillHandle =
        batchCreateMode &&
        isCreatePlaceholderRow(item) &&
        BATCH_CREATE_FILLABLE_KEYS.has(key);
      if (!shouldRenderFillHandle) {
        return editor;
      }
      return (
        <div className="detail-inline-fill-cell" data-prevent-row-click="true">
          {editor}
          <div
            className="detail-inline-fill-handle"
            role="button"
            tabIndex={-1}
            aria-hidden="true"
            data-prevent-row-click="true"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const startIndex = parseInlineCreatePlaceholderIndex(item.rowId);
              if (startIndex === null) {
                return;
              }
              setBatchCreateFillDrag({
                sourceRowId: item.rowId,
                sourceKey: key,
                endKey: key,
                startIndex,
                endIndex: startIndex,
              });
            }}
          />
        </div>
      );
    },
    [
      batchCreateMode,
      editingRowDraft,
      editingRowId,
      getBatchCreateDraftForRow,
      inlineEditorDefinitions,
      isInlineEditableCell,
      renderStaticDetailCell,
    ]
  );
  // 預估 map + signature 一起 memo，避免 Map 新 ref 讓下游 useMemo / effect 失效
  const { predictedCumulativeMap, predictionSignature } = useMemo(() => {
    const map = computePredictedCumulative({
      detailRows,
      editingRowId,
      editingRowDraft,
      batchCreateDraftsByRowId,
      batchCreateMode,
      displayRows: displayDetailRows,
    });
    const sig = Array.from(map.entries())
      .map(([k, v]) => `${k}:${v.cum}:${v.isPredicted ? "1" : "0"}`)
      .join("|");
    return { predictedCumulativeMap: map, predictionSignature: sig };
  }, [detailRows, editingRowId, editingRowDraft, batchCreateDraftsByRowId, batchCreateMode, displayDetailRows]);

  // inline 編輯 draft 的 signature：draft 任一欄位變動就變，用來打破 DetailTableRowView 的 memo。
  // Why: columnKeysSignature/renderContextKey 原本不反映 draft 內容，
  //      導致使用者在 inline input 打字時看起來「卡死」——狀態有更新但 row 被 memo 擋住沒重 render
  const editingRowDraftSignature = useMemo(() => {
    if (!editingRowDraft) {
      return "";
    }
    return `${editingRowId ?? ""}|${Object.values(editingRowDraft).join("|")}`;
  }, [editingRowDraft, editingRowId]);

  // 記錄上一次預估值，detailRows 更新後比對 Ragic 真實值，不符就 warn（協助追公式落差）
  const lastPredictedSnapshotRef = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const snapshot = lastPredictedSnapshotRef.current;
    if (!snapshot || snapshot.size === 0) {
      return;
    }
    const mismatches: Array<{ rowId: string; predicted: number; actual: number | null }> = [];
    for (const row of detailRows) {
      const rowId = String(row.rowId);
      const predicted = snapshot.get(rowId);
      if (predicted === undefined) continue;
      const actual = Number(row.cumulativeQty);
      if (!Number.isFinite(actual)) continue;
      if (Math.round(predicted) !== Math.round(actual)) {
        mismatches.push({ rowId, predicted, actual });
      }
    }
    if (mismatches.length > 0) {
      console.warn("[cumulative-prediction-mismatch]", { mismatches });
    }
    lastPredictedSnapshotRef.current = null;
  }, [detailRows]);

  // 預估內容變動時更新 snapshot（只記「有預估」的列）
  useEffect(() => {
    const snapshot = new Map<string, number>();
    predictedCumulativeMap.forEach((value, rowId) => {
      if (value.isPredicted) {
        snapshot.set(rowId, value.cum);
      }
    });
    if (snapshot.size > 0) {
      lastPredictedSnapshotRef.current = snapshot;
    }
  }, [predictedCumulativeMap]);

  const baseDetailColumns = useMemo<ReadonlyArray<DetailColumnDefinition>>(
    () => [
      {
        key: "date",
        label: t("workReport:table.headers.date"),
        className: "col-date",
        renderCell: (item) => renderInlineEditableCell(item, "date", item.date),
      },
      {
        key: "plannedIdle",
        label: t("workReport:table.headers.plannedIdle"),
        className: "col-compact",
        renderCell: (item) => renderInlineEditableCell(item, "plannedIdle", item.plannedIdle),
      },
      {
        key: "processCode",
        label: t("workReport:table.headers.process"),
        className: "col-process",
        renderCell: (item) => renderInlineEditableCell(item, "processCode", item.processCode ?? item.processCodeDisplay),
      },
      {
        key: "machineId",
        label: t("workReport:table.headers.machine"),
        className: "col-machine",
        renderCell: (item) => renderInlineEditableCell(item, "machineId", item.machineId ?? item.machineIdDisplay),
      },
      {
        key: "operatorId",
        label: t("workReport:table.headers.operatorId"),
        className: "col-operator-id",
        renderCell: (item) => renderInlineEditableCell(item, "operatorId", item.operatorId),
      },
      {
        key: "operatorName",
        label: t("workReport:table.headers.operator"),
        className: "col-operator",
        renderCell: (item) =>
          renderStaticDetailCell(
            item,
            batchCreateMode && isCreatePlaceholderRow(item) && getBatchCreateDraftForRow(item.rowId)
              ? getBatchCreateDraftForRow(item.rowId)?.operatorName ||
                getBatchCreateDraftForRow(item.rowId)?.operatorId ||
                item.operatorName ||
                item.operatorIdDisplay ||
                item.operatorId
              : editingRowId === item.rowId && editingRowDraft
              ? editingRowDraft.operatorName || item.operatorName || item.operatorIdDisplay || item.operatorId
              : item.operatorName ?? item.operatorIdDisplay ?? item.operatorId
          ),
      },
      {
        key: "inputOptions",
        label: t("workReport:table.headers.inputOptions"),
        className: "col-input-options",
        renderCell: (item) => renderInlineEditableCell(item, "inputOptions", item.inputOptions),
      },
      {
        key: "shiftType",
        label: t("workReport:table.headers.shift"),
        className: "col-shift",
        renderCell: (item) => renderInlineEditableCell(item, "shiftType", item.shiftType),
      },
      {
        key: "startTime",
        label: t("workReport:table.headers.startTime"),
        className: "col-time",
        renderCell: (item) =>
          renderInlineEditableCell(item, "startTime", formatTimeDisplay(item.startTime)),
      },
      {
        key: "endTime",
        label: t("workReport:table.headers.endTime"),
        className: "col-time",
        renderCell: (item) =>
          renderInlineEditableCell(item, "endTime", formatTimeDisplay(item.endTime)),
      },
      {
        key: "breakTime",
        label: t("workReport:table.headers.breakTime"),
        className: "col-compact col-number",
        renderCell: (item) => renderInlineEditableCell(item, "breakTime", item.breakTime),
      },
      {
        key: "totalWorkTime",
        label: t("workReport:table.headers.totalWorkTime"),
        className: "col-number",
        renderCell: (item) => renderStaticDetailCell(item, item.totalWorkTime),
      },
      {
        key: "productionQty",
        label: t("workReport:table.headers.qty"),
        className: "col-number",
        renderCell: (item) => renderInlineEditableCell(item, "productionQty", item.productionQty),
      },
      {
        key: "cumulativeQty",
        label: t("workReport:table.headers.cumulativeQty"),
        className: "col-number",
        renderCell: (item) => {
          const predicted = predictedCumulativeMap.get(String(item.rowId));
          const isPlaceholder = isCreatePlaceholderRow(item);
          const showPredicted = Boolean(predicted) && (predicted!.isPredicted || isPlaceholder);

          // placeholder 無 draft：空格 UI
          if (isPlaceholder && !showPredicted) {
            return (
              <div className="detail-progress-cell detail-progress-cell--placeholder" aria-hidden="true">
                <span className="detail-cell-placeholder-empty" />
                <div className="detail-progress-track detail-progress-track--placeholder" />
              </div>
            );
          }

          const cumulativeValue = showPredicted ? predicted!.cum : Number(item.cumulativeQty ?? 0);
          const targetQty = Number(record?.targetQtyPc ?? 0);
          const progress =
            Number.isFinite(cumulativeValue) && Number.isFinite(targetQty) && targetQty > 0
              ? Math.max(0, Math.min(100, (cumulativeValue / targetQty) * 100))
              : null;

          return (
            <div className={`detail-progress-cell${showPredicted ? " detail-progress-cell--predicted" : ""}`}>
              {showPredicted ? (
                <span className="detail-cell-predicted-value" title="預估值（儲存後以 Ragic 計算為準）">
                  {predicted!.cum}
                  <span className="detail-cell-predicted-badge" aria-hidden="true">
                    預估
                  </span>
                </span>
              ) : (
                renderDetailCell(item.cumulativeQty)
              )}
              {progress !== null && (
                <div
                  className={`detail-progress-track${showPredicted ? " detail-progress-track--predicted" : ""}`}
                  aria-hidden="true"
                >
                  <div className="detail-progress-fill" style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
          );
        },
      },
      {
        key: "rowId",
        label: t("workReport:table.headers.rowId"),
        className: "col-row-id",
        renderCell: (item) => renderStaticDetailCell(item, isCreatePlaceholderRow(item) ? "" : item.rowId),
      },
      {
        key: "reportType",
        label: t("workReport:table.headers.reportType"),
        className: "col-report-type",
        renderCell: (item) =>
          renderStaticDetailCell(
            item,
            batchCreateMode && isCreatePlaceholderRow(item) && getBatchCreateDraftForRow(item.rowId)
              ? getBatchCreateDraftForRow(item.rowId)?.reportType
              : item.reportType
          ),
      },
      {
        key: "remark",
        label: t("workReport:table.headers.remark"),
        className: "col-remark",
        renderCell: (item) => renderInlineEditableCell(item, "remark", item.remark),
      },
    ],
    [
      editingRowDraft,
      editingRowId,
      batchCreateMode,
      getBatchCreateDraftForRow,
      predictedCumulativeMap,
      record?.targetQtyPc,
      renderDetailCell,
      renderInlineEditableCell,
      renderStaticDetailCell,
      t,
    ]
  );
  const fixedExtraColumnsDefinitions = useMemo<ReadonlyArray<DetailColumnDefinition>>(
    () =>
      fixedExtraColumns.map((column) => ({
        key: column.key,
        label: column.label,
        className: column.className,
        renderCell: (item) => {
          const value = (item as Record<string, unknown>)[column.key];
          const inlineKey = column.key as InlineEditableDetailKey;
          if (inlineEditableColumnKeySet.has(inlineKey)) {
            return renderInlineEditableCell(item, inlineKey, value);
          }
          return renderStaticDetailCell(item, value);
        },
      })),
    [fixedExtraColumns, inlineEditableColumnKeySet, renderInlineEditableCell, renderStaticDetailCell]
  );
  const dynamicExtraColumnsDefinitions = useMemo<ReadonlyArray<DetailColumnDefinition>>(
    () =>
      extraDetailKeys.map((fieldKey) => ({
        key: fieldKey,
        label: t(`workReport:table.dynamicHeaders.${fieldKey}`, { defaultValue: fieldKey }),
        renderCell: (item) => renderStaticDetailCell(item, (item as Record<string, unknown>)[fieldKey]),
      })),
    [extraDetailKeys, renderStaticDetailCell, t]
  );
  const pageTitle = t("workReport:detailPage.title");

  const handleManualCloseWorkOrder = useCallback(
    (action: "close" | "reopen") => {
      if (!record || workOrderClosing) return;
      setWorkOrderConfirmAction(action);
    },
    [record, workOrderClosing]
  );

  const confirmManualCloseWorkOrder = useCallback(async () => {
    if (!formId || !safeEntryId || !workOrderConfirmAction) return;
    setWorkOrderClosing(true);
    try {
      if (workOrderConfirmAction === "close") {
        await closeWorkOrder(formId, safeEntryId);
      } else {
        await reopenWorkOrder(formId, safeEntryId);
      }
      const successKey =
        workOrderConfirmAction === "close"
          ? "workReport:detailPage.manualCloseSuccess"
          : "workReport:detailPage.manualReopenSuccess";
      setWorkOrderConfirmAction(null);
      setNotice({ type: "success", message: t(successKey) });
      await loadEntry({ silent: true, forceRefresh: true });
    } catch (error) {
      setNotice({ type: "error", message: getErrorMessage(error) });
    } finally {
      setWorkOrderClosing(false);
    }
  }, [
    formId,
    loadEntry,
    safeEntryId,
    t,
    workOrderConfirmAction,
  ]);

  const handleDelete = useCallback(
    async (rowId: string): Promise<void> => {
      if (!formId || !safeEntryId) {
        return;
      }
      const modal = Modal.confirm({
        title: t("common:actions.delete"),
        content: t("workReport:messages.confirmDeleteDetailPermanent"),
        okText: t("common:actions.delete"),
        cancelText: t("common:actions.cancel"),
        okButtonProps: { danger: true },
        centered: true,
        maskClosable: false,
        keyboard: false,
        closable: false,
        onOk: async () => {
          const operationId = createFrontendOperationId("detail-delete");
          const startedAt = new Date().toISOString();
          logDetailEvent("api", "detail-delete-started", "開始刪除報工明細", {
            rowId,
            operationId,
            operationType: "detail-delete",
            phase: "started",
            startedAt,
          });
          modal.update({
            okButtonProps: { danger: true, loading: true },
            cancelButtonProps: { disabled: true },
            maskClosable: false,
            keyboard: false,
            closable: false,
          });
          logDetailEvent("api", "detail-delete-lock-acquire-started", "開始取得刪除列鎖", {
            rowId,
            operationId,
            operationType: "detail-delete",
            phase: "lock-acquire",
            startedAt,
          });
          const lockVersion = await acquireRowEditLock(rowId);
          if (lockVersion === null) {
            logDetailEvent("api", "detail-delete-lock-failed", "刪除列鎖取得失敗", {
              level: "warn",
              rowId,
              operationId,
              operationType: "detail-delete",
              phase: "lock-failed",
              startedAt,
            });
            modal.update({
              okButtonProps: { danger: true, loading: false },
              cancelButtonProps: { disabled: false },
            });
            return;
          }
          logDetailEvent("api", "detail-delete-lock-acquired", "已取得刪除列鎖", {
            rowId,
            operationId,
            operationType: "detail-delete",
            phase: "lock-acquired",
            startedAt,
          });
          setSubmitting(true);
          try {
            logDetailEvent("api", "detail-delete-request-started", "刪除 request 已送出", {
              rowId,
              operationId,
              operationType: "detail-delete",
              phase: "request",
              startedAt,
            });
            await deleteReport(formId, safeEntryId, rowId, {
              editSessionId: currentEditSessionId,
              editLockVersion: lockVersion,
            });
            const requestEndedAt = new Date().toISOString();
            logDetailEvent("api", "detail-delete-succeeded", "刪除報工明細成功", {
              rowId,
              operationId,
              operationType: "detail-delete",
              phase: "request-succeeded",
              startedAt,
              endedAt: requestEndedAt,
              durationMs: calculateDurationMs(startedAt, requestEndedAt),
            });
            setNotice({ type: "success", message: t("workReport:messages.detailDeletedPermanent") });
            void message.success(t("workReport:messages.detailDeletedPermanent"));
            logDetailEvent("realtime", "detail-delete-refresh-started", "刪除後開始刷新明細", {
              rowId,
              operationId,
              operationType: "detail-delete",
              phase: "refresh",
              startedAt,
            });
            void loadEntry({ silent: true, forceRefresh: false }).finally(() => {
              const refreshEndedAt = new Date().toISOString();
              logDetailEvent(
                "realtime",
                "detail-delete-refresh-completed",
                "刪除後刷新明細完成",
                {
                  rowId,
                  operationId,
                  operationType: "detail-delete",
                  phase: "refresh-completed",
                  startedAt,
                  endedAt: refreshEndedAt,
                  durationMs: calculateDurationMs(startedAt, refreshEndedAt),
                }
              );
            });
          } catch (error) {
            logDetailEvent("api", "detail-delete-failed", getErrorMessage(error), {
              level: "error",
              rowId,
              operationId,
              operationType: "detail-delete",
              phase: "failed",
              startedAt,
              endedAt: new Date().toISOString(),
            });
            setNotice({
              type: "error",
              message: t("workReport:messages.deleteFailed", { error: getErrorMessage(error) }),
            });
            void message.error(
              t("workReport:messages.deleteFailed", { error: getErrorMessage(error) })
            );
            modal.update({
              okButtonProps: { danger: true, loading: false },
              cancelButtonProps: { disabled: false },
            });
            throw error;
          } finally {
            void releaseRowEditLock(rowId);
            setSubmitting(false);
          }
        },
      });
    },
    [
      acquireRowEditLock,
      currentEditSessionId,
      formId,
      logDetailEvent,
      releaseRowEditLock,
      safeEntryId,
      t,
      loadEntry,
    ]
  );

  const toggleBatchDeleteRowSelection = useCallback((rowId: string) => {
    setSelectedBatchDeleteRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }, []);
  const handleDetailRowClick = useCallback(
    (event: ReactMouseEvent<HTMLTableRowElement>, row: DetailTableRow) => {
      if (batchDeleteMode) {
        if (isCreatePlaceholderRow(row) || isInteractiveClickTarget(event.target)) {
          return;
        }
        toggleBatchDeleteRowSelection(row.rowId);
        return;
      }
      if (batchCreateMode) {
        if (isInteractiveClickTarget(event.target)) {
          return;
        }
        if (isCreatePlaceholderRow(row)) {
          void activateBatchCreateRow(row.rowId);
        }
        return;
      }
      if (submitting || editingRowId !== null || hasBlockingMutationTask) {
        return;
      }
      if (isInteractiveClickTarget(event.target)) {
        return;
      }
      if (isCreatePlaceholderRow(row)) {
        void activateBatchCreateRow(row.rowId);
        return;
      }
      if (hasActiveMutationTask) {
        return;
      }
      void startInlineRowEdit(row);
    },
    [
      activateBatchCreateRow,
      batchCreateMode,
      batchDeleteMode,
      editingRowId,
      hasActiveMutationTask,
      hasBlockingMutationTask,
      startInlineRowEdit,
      submitting,
      toggleBatchDeleteRowSelection,
    ]
  );
  const clearBatchDeleteSelection = useCallback(() => {
    setSelectedBatchDeleteRowIds(new Set());
  }, []);
  const toggleSelectAllBatchDeleteRows = useCallback(() => {
    setSelectedBatchDeleteRowIds((prev) => {
      if (
        batchDeleteSelectableRowIds.length > 0 &&
        batchDeleteSelectableRowIds.every((rowId) => prev.has(rowId))
      ) {
        return new Set();
      }
      return new Set(batchDeleteSelectableRowIds);
    });
  }, [batchDeleteSelectableRowIds]);
  const handleBatchDelete = useCallback(async (): Promise<void> => {
    if (!formId || !safeEntryId) {
      return;
    }
    const rowIds = Array.from(selectedBatchDeleteRowIds).filter((rowId) =>
      batchDeleteSelectableRowIds.includes(rowId)
    );
    if (rowIds.length === 0) {
      return;
    }
    Modal.confirm({
      title: t("workReport:detailPage.batchDeleteTitle"),
      content: t("workReport:messages.confirmDeleteDetailBatchPermanent", {
        count: rowIds.length,
      }),
      okText: t("common:actions.delete"),
      cancelText: t("common:actions.cancel"),
      okButtonProps: { danger: true },
      centered: true,
      maskClosable: false,
      keyboard: false,
      closable: false,
      onOk: async () => {
        await deleteReportsBatchAccepted(formId, safeEntryId, rowIds, {
          editSessionId: currentEditSessionId,
          workOrderNo: record?.workOrderNo ?? null,
        });
        setNotice({
          type: "success",
          message: t("workReport:messages.batchDeleteAccepted", {
            count: rowIds.length,
          }),
        });
        setBatchDeleteMode(false);
        setSelectedBatchDeleteRowIds(new Set());
        setTaskQueueDrawerOpen(true);
      },
    });
  }, [
    batchDeleteSelectableRowIds,
    currentEditSessionId,
    formId,
    record?.workOrderNo,
    safeEntryId,
    selectedBatchDeleteRowIds,
    t,
  ]);
  const openTaskQueueDrawer = useCallback(() => {
    setTaskQueueDrawerOpen(true);
  }, []);
  const [auditHistoryOpen, setAuditHistoryOpen] = useState(false);
  const openAuditHistory = useCallback(() => {
    if (!formId) return;
    setAuditHistoryOpen(true);
    pushFrontendEvent({
      level: "info",
      category: "ui",
      action: "audit-history-opened",
      summary: `開啟工令歷史 entryId=${safeEntryId}`,
      formId,
      ...(safeEntryId ? { entryId: safeEntryId } : {}),
      meta: { scope: "work-report" },
    });
  }, [formId, safeEntryId]);
  const enterBatchDeleteMode = useCallback(() => {
    setBatchDeleteMode(true);
  }, []);
  const cancelBatchDeleteMode = useCallback(() => {
    setBatchDeleteMode(false);
    setSelectedBatchDeleteRowIds(new Set());
  }, []);
  const refreshDetailEntry = useCallback(async () => {
    try {
      await loadEntry({ forceRefresh: true, silent: Boolean(record) });
      void message.success(t("workReport:messages.toastDetailRefreshed"));
    } catch (error) {
      void message.error(
        t("workReport:messages.toastDetailRefreshFailed", {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }, [loadEntry, record, t]);
  const actionsColumnDefinition = useMemo<DetailColumnDefinition>(
    () => ({
      key: "__actions",
      label: t("workReport:table.headers.actions"),
      className: "col-actions",
      isToggleable: false,
      renderCell: (item) => {
        const isEditing = editingRowId === item.rowId;
        if (isEditing && !batchCreateMode) {
          const isSaving = savingRowId === item.rowId;
          return (
            <div className="action-cell" data-prevent-row-click="true">
              <button
                type="button"
                data-inline-action="save"
                onClick={() => void saveInlineRowEdit(item)}
                disabled={isSaving}
              >
                {isSaving ? t("common:actions.saving") : t("common:actions.save")}
              </button>
              <button type="button" onClick={cancelInlineRowEdit} disabled={isSaving}>
                {t("common:actions.cancel")}
              </button>
              <button
                type="button"
                className="detail-clear-btn"
                onClick={() => setEditingRowDraft(EMPTY_FORM)}
                disabled={isSaving}
              >
                {t("workReport:reportForm.actions.clearAll")}
              </button>
            </div>
          );
        }

        if (isCreatePlaceholderRow(item)) {
          if (batchCreateMode && isMeaningfulBatchCreateDraft(getBatchCreateDraftForRow(item.rowId) ?? EMPTY_FORM)) {
            return (
              <div className="action-cell" data-prevent-row-click="true">
                <button
                  type="button"
                  onClick={() => cancelSingleBatchCreateRow(item.rowId)}
                  disabled={submitting}
                >
                  {t("workReport:detailPage.cancelBatchCreateRow")}
                </button>
              </div>
            );
          }
          return <span className="detail-cell-placeholder-empty" aria-hidden="true" />;
        }

        const isRecordClosed = record?.status === "已結案";
        return (
          <div className="action-cell" data-prevent-row-click="true">
            <button
              type="button"
              className={isRecordClosed ? "is-locked" : undefined}
              onClick={() => {
                if (isRecordClosed) {
                  showClosedLockWarning(t("workReport:detailPage.closedLockedMessage"));
                  return;
                }
                openEditModal(item);
              }}
              disabled={
                batchDeleteMode ||
                batchCreateMode ||
                submitting ||
                editingRowId !== null ||
                hasActiveMutationTask
              }
            >
              {t("common:actions.edit")}
            </button>
            <button
              type="button"
              className={`detail-delete-btn${isRecordClosed ? " is-locked" : ""}`}
              onClick={() => {
                if (isRecordClosed) {
                  showClosedLockWarning(t("workReport:detailPage.closedLockedMessage"));
                  return;
                }
                void handleDelete(item.rowId);
              }}
              disabled={
                batchDeleteMode ||
                batchCreateMode ||
                submitting ||
                editingRowId !== null ||
                hasActiveMutationTask
              }
            >
              {t("common:actions.delete")}
            </button>
          </div>
        );
      },
    }),
    [
      batchDeleteMode,
      batchCreateMode,
      cancelInlineRowEdit,
      cancelSingleBatchCreateRow,
      editingRowId,
      getBatchCreateDraftForRow,
      handleDelete,
      openEditModal,
      record?.status,
      saveInlineRowEdit,
      setEditingRowDraft,
      savingRowId,
      submitting,
      hasActiveMutationTask,
      t,
    ]
  );
  const batchDeleteColumnDefinition = useMemo<DetailColumnDefinition>(
    () => ({
      key: "__batch_select",
      label: t("workReport:detailPage.batchSelectLabel"),
      className: "col-batch-select",
      isToggleable: false,
      renderCell: (item) => {
        if (isCreatePlaceholderRow(item)) {
          return <span className="detail-cell-placeholder-empty" aria-hidden="true" />;
        }
        return (
          <div className="action-cell" data-prevent-row-click="true">
            <input
              type="checkbox"
              checked={selectedBatchDeleteRowIds.has(item.rowId)}
              onChange={() => toggleBatchDeleteRowSelection(item.rowId)}
            />
          </div>
        );
      },
    }),
    [selectedBatchDeleteRowIds, t, toggleBatchDeleteRowSelection]
  );
  const allDetailColumns = useMemo<ReadonlyArray<DetailColumnDefinition>>(
    () => [
      ...baseDetailColumns,
      ...fixedExtraColumnsDefinitions,
      ...dynamicExtraColumnsDefinitions,
      actionsColumnDefinition,
    ],
    [actionsColumnDefinition, baseDetailColumns, dynamicExtraColumnsDefinitions, fixedExtraColumnsDefinitions]
  );
  const toggleableDetailColumns = useMemo(
    () => allDetailColumns.filter((column) => column.isToggleable !== false && column.key !== "__actions"),
    [allDetailColumns]
  );
  const visibleDetailColumns = useMemo(
    () => allDetailColumns.filter((column) => column.key === "__actions" || !hiddenColumnKeys.has(column.key)),
    [allDetailColumns, hiddenColumnKeys]
  );
  const renderedDetailColumns = useMemo(
    () =>
      batchDeleteMode
        ? [batchDeleteColumnDefinition, ...visibleDetailColumns]
        : visibleDetailColumns,
    [batchDeleteColumnDefinition, batchDeleteMode, visibleDetailColumns]
  );

  return (
    <main className="page">
      <section className="detail-page">
        <section className="detail-sticky-stack">
          {maintenanceMessage ? (
            <section className="detail-system-status-wrap" role="status" aria-live="polite">
              <div className="detail-system-status detail-system-status--warn">
                <span className="detail-system-status-content">
                  <span>{maintenanceMessage}</span>
                </span>
              </div>
            </section>
          ) : null}
          {blocked ? (
            <div
              role="alert"
              aria-live="assertive"
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 3000,
                background: "rgba(15, 23, 42, 0.72)",
                backdropFilter: "blur(2px)",
                display: "grid",
                placeItems: "center",
                padding: "1.5rem",
              }}
            >
              <div
                style={{
                  width: "min(560px, 100%)",
                  padding: "1.4rem 1.5rem",
                  borderRadius: "16px",
                  border: "1px solid rgba(248, 113, 113, 0.5)",
                  background: "#1f1111",
                  boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
                  color: "#fecaca",
                }}
              >
                <div style={{ fontSize: "1.05rem", fontWeight: 700, marginBottom: "0.55rem" }}>
                  此裝置已被管理端停用
                </div>
                <div style={{ lineHeight: 1.65, fontSize: "0.96rem" }}>
                  {blockedReason || "此裝置已被管理端暫時停用"}
                </div>
              </div>
            </div>
          ) : null}
          <header className="detail-page-header">
            <div className="detail-page-title-wrap">
              <button
                type="button"
                className="detail-page-back-btn"
                onClick={() => navigate(backToListUrl, { state: listReturnState })}
              >
                {t("workReport:detailPage.backToList")}
              </button>
              <h1 className="detail-page-title">
                <span>{pageTitle}</span>
                {record?.workOrderNo ? <span className="detail-page-title-separator">｜</span> : null}
                {record?.workOrderNo ? (
                  ragicEntryUrl ? (
                    <a
                      className="detail-page-title-link"
                      href={ragicEntryUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {String(record.workOrderNo)}
                    </a>
                  ) : (
                    <span>{String(record.workOrderNo)}</span>
                  )
                ) : null}
                <button
                  type="button"
                  className="detail-page-history-btn"
                  onClick={openAuditHistory}
                  disabled={!safeEntryId}
                >
                  {t("workReport:auditHistory.openHistory")}
                </button>
              </h1>
            </div>
          </header>

          <section className="detail-system-status-wrap" role="status" aria-live="polite">
            <div className={`detail-system-status detail-system-status--${systemStatus.type}`}>
              <span className="detail-system-status-content">
                {systemStatus.showSpinner && (
                  <span className="detail-system-status-spinner" aria-hidden="true" />
                )}
                <span>{systemStatus.message}</span>
              </span>
              {systemStatus.onAction && systemStatus.actionLabel ? (
                <button
                  type="button"
                  className="detail-system-status-action"
                  onClick={systemStatus.onAction}
                  disabled={systemStatus.actionDisabled}
                >
                  {systemStatus.actionLabel}
                </button>
              ) : null}
            </div>
          </section>
        </section>

        {isValidRoute && (
          <>
            {!loading && !loadError && record && (
              <>
                <WorkOrderContextCard
                  key={`${record?.id ?? "empty"}:detail`}
                  record={record}
                  uiLanguage={uiLanguage}
                  detailCollapsible
                  detailDefaultCollapsed
                />

                <WorkReportDetailTableSection
                  key={`${formId ?? "none"}:${safeEntryId || "none"}`}
                  detailRowsCount={detailRows.length}
                  batchCreateMode={batchCreateMode}
                  batchCreateDraftCount={batchCreateDraftRowIds.length}
                  batchDeleteMode={batchDeleteMode}
                  allBatchDeleteRowsSelected={allBatchDeleteRowsSelected}
                  selectedBatchDeleteCount={selectedBatchDeleteRowIds.size}
                  editingRowId={editingRowId}
                  savingRowId={savingRowId}
                  loading={loading}
                  refreshing={refreshing}
                  submitting={submitting}
                  hasActiveMutationTask={hasActiveMutationTask}
                  hasBlockingMutationTask={hasBlockingMutationTask}
                  modalOpen={modalState.open}
                  workOrderClosing={workOrderClosing}
                  recordStatus={record?.status ?? null}
                  highlightedDetailRowId={highlightedDetailRowId}
                  predictionSignature={predictionSignature}
                  editingRowDraftSignature={editingRowDraftSignature}
                  renderedDetailColumns={renderedDetailColumns}
                  toggleableDetailColumns={toggleableDetailColumns}
                  hiddenColumnKeys={hiddenColumnKeys}
                  displayDetailRows={displayDetailRows}
                  displayDetailRowMetaByRowId={displayDetailRowMetaByRowId}
                  detailTableScrollRef={detailTableScrollRef}
                  batchCreateFillDrag={batchCreateFillDrag}
                  batchCreateFieldErrorsByRowId={batchCreateFieldErrorsByRowId}
                  inlineEditableColumnKeySet={inlineEditableColumnKeySet}
                  autoHighlightedInlineKeys={autoHighlightedInlineKeys}
                  selectedBatchDeleteRowIds={selectedBatchDeleteRowIds}
                  getBatchCreateFillPreviewRowMeta={getBatchCreateFillPreviewRowMeta}
                  getBatchCreateDraftForRow={getBatchCreateDraftForRow}
                  resolveBatchCreateFillKeys={resolveBatchCreateFillKeys}
                  isBatchCreateFillPreviewCell={isBatchCreateFillPreviewCell}
                  onFillPreviewHover={handleFillPreviewHover}
                  onDetailRowClick={handleDetailRowClick}
                  onDetailTableKeyDown={handleDetailTableKeyDown}
                  onToggleColumnVisibility={toggleColumnVisibility}
                  onShowAllColumns={showAllColumns}
                  onResetDefaultColumns={resetDefaultColumns}
                  onRefresh={refreshDetailEntry}
                  onOpenTaskQueue={openTaskQueueDrawer}
                  onToggleSelectAllBatchDeleteRows={toggleSelectAllBatchDeleteRows}
                  onClearBatchDeleteSelection={clearBatchDeleteSelection}
                  onHandleBatchDelete={() => void handleBatchDelete()}
                  onCancelBatchDeleteMode={cancelBatchDeleteMode}
                  onSaveBatchCreate={() => void saveBatchCreate()}
                  onCancelBatchCreate={cancelBatchCreate}
                  onClearBatchCreate={() => void clearBatchCreate()}
                  onEnterBatchDeleteMode={enterBatchDeleteMode}
                  onOpenMainMachineModal={openMainMachineModal}
                  onHandleManualCloseWorkOrder={(action) => void handleManualCloseWorkOrder(action)}
                  onOpenCreateModal={openCreateModal}
                />
              </>
            )}
          </>
        )}
      </section>

      {linkedPickerState && linkedPickerCopy ? (
        <DetailLinkedPickerModal
          title={linkedPickerCopy.title}
          hint={linkedPickerCopy.hint}
          closeLabel={t("common:actions.cancel")}
          currentSelectionLabel={t("workReport:detailPage.pickerCurrentSelectionLabel")}
          currentSelectionOption={currentLinkedPickerOption}
          topContent={linkedPickerTopContent}
          searchLabel={linkedPickerCopy.searchLabel}
          searchPlaceholder={linkedPickerCopy.searchPlaceholder}
          emptyText={linkedPickerCopy.emptyText}
          searchValue={linkedPickerState.search}
          options={filteredLinkedPickerOptions}
          selectedValue={linkedPickerSelectedValue}
          onSearchChange={updateLinkedPickerSearch}
          onSelect={handleLinkedOptionSelect}
          onClose={closeLinkedPicker}
        />
      ) : null}

      <ReportFormModal
        key={`${modalState.open ? "open" : "closed"}:${modalState.mode}:${modalState.row?.rowId ?? "new"}:${record?.id ?? "entry"}:${createFormResetToken}`}
        formId={formId ?? "104"}
        open={modalState.open}
        mode={modalState.mode}
        resetToken={createFormResetToken}
        initialValue={modalState.row}
        entryContext={record}
        entryContextLoading={loading}
        uiLanguage={uiLanguage}
        options={formOptions}
        operatorGroupOptions={operatorGroupOptions}
        selectedOperatorGroupKey={selectedOperatorGroupKey}
        onOperatorGroupChange={handleOperatorGroupPreferenceChange}
        optionsLoading={optionsLoading}
        submitting={submitting}
        onClose={closeModal}
        onSubmit={handleSubmit}
        onDebugEvent={(action, summary, meta) => {
          logDetailEvent("api", action, summary, {
            level: "warn",
            rowId: modalState.row?.rowId ?? undefined,
            meta,
          });
        }}
      />
      <WorkReportTaskQueueDrawer
        open={taskQueueDrawerOpen}
        formId={formId}
        entryId={safeEntryId || null}
        workOrderNo={record?.workOrderNo ?? null}
        onRetryAccepted={async (kind, accepted, rowId) => {
          await registerAcceptedMutationTask(kind, accepted, rowId);
          setNotice({
            type: "success",
            message:
              kind === "create"
                ? t("workReport:messages.createAcceptedTaskProcessing")
                : t("workReport:messages.updateAcceptedTaskProcessing"),
          });
        }}
        onClose={() => setTaskQueueDrawerOpen(false)}
      />
      {formId ? (
        <RecordAuditHistoryModal
          open={auditHistoryOpen}
          onClose={() => setAuditHistoryOpen(false)}
          scope="work-report"
          formId={formId}
          entryId={safeEntryId}
          recordLabel={
            safeEntryId
              ? t("workReport:auditHistory.recordLabelWorkReportAll", {
                  entryId: safeEntryId,
                })
              : undefined
          }
        />
      ) : null}
      {mainMachineModalOpen && (
        <div className="modal-backdrop" onMouseDown={closeMainMachineModal}>
          <section
            className="modal-panel detail-main-machine-panel"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={t("workReport:detailPage.mainMachineDialogTitle")}
          >
            <header className="modal-header detail-main-machine-header">
              <h2>{t("workReport:detailPage.mainMachineDialogTitle")}</h2>
              <button
                type="button"
                className="detail-main-machine-close"
                onClick={closeMainMachineModal}
                disabled={mainMachineSaving}
                aria-label={t("common:actions.close")}
              >
                ×
              </button>
            </header>
            <div className="detail-main-machine-body">
              <div className="detail-main-machine-current">
                <span className="detail-main-machine-label">
                  {t("workReport:detailPage.mainMachineDialogCurrent")}
                </span>
                <strong>{String(record?.machineCode ?? "").trim() || "-"}</strong>
              </div>
              <label className="modal-field">
                <span className="modal-field-label detail-main-machine-next-label">
                  {t("workReport:detailPage.mainMachineDialogNext")}
                </span>
                <span className="modal-field-hint detail-main-machine-hint">
                  {t("workReport:detailPage.mainMachineDialogHint")}
                </span>
                <DetailInlinePickerTrigger
                  value={mainMachineDraft}
                  hint={
                    currentMainMachineOption?.display &&
                    currentMainMachineOption.display !== currentMainMachineOption.value
                      ? currentMainMachineOption.display
                      : null
                  }
                  blankLabel={t("common:options.select")}
                  editorKey="main-machine-picker"
                  disabled={optionsLoading || mainMachineSaving}
                  onOpen={() => {
                    setMainMachinePickerSearch("");
                    setMainMachinePickerOpen(true);
                  }}
                />
              </label>
            </div>
            <div className="modal-footer detail-main-machine-footer">
              {(mainMachineSaving || mainMachineSaveProgress > 0) && (
                <div className="modal-save-progress" aria-label={t("common:actions.saving")}>
                  <div className="modal-save-progress-track">
                    <div
                      className="modal-save-progress-fill"
                      style={{ width: `${Math.max(0, Math.min(100, mainMachineSaveProgress))}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="modal-actions-secondary detail-main-machine-cancel"
                  onClick={closeMainMachineModal}
                  disabled={mainMachineSaving}
                >
                  {t("common:actions.cancel")}
                </button>
                <button
                  type="button"
                  className="detail-main-machine-save"
                  onClick={() => void submitMainMachineUpdate()}
                  disabled={optionsLoading || mainMachineSaving}
                >
                  {t("common:actions.save")}
                </button>
              </div>
            </div>
            {mainMachinePickerOpen ? (
              <DetailLinkedPickerModal
                title={mainMachinePickerCopy.title}
                hint={mainMachinePickerCopy.hint}
                closeLabel={t("common:actions.cancel")}
                currentSelectionLabel={t("workReport:detailPage.pickerCurrentSelectionLabel")}
                currentSelectionOption={currentMainMachineOption}
                topContent={mainMachinePickerTopContent}
                searchLabel={mainMachinePickerCopy.searchLabel}
                searchPlaceholder={mainMachinePickerCopy.searchPlaceholder}
                emptyText={mainMachinePickerCopy.emptyText}
                searchValue={mainMachinePickerSearch}
                options={filteredMainMachinePickerOptions}
                selectedValue={mainMachineDraft}
                onSearchChange={setMainMachinePickerSearch}
                onSelect={(value) => {
                  setMainMachineDraft(value);
                  setMainMachinePickerOpen(false);
                }}
                onClose={() => setMainMachinePickerOpen(false)}
              />
            ) : null}
          </section>
        </div>
      )}
      {workOrderConfirmAction && (
        <div
          className="modal-backdrop"
          onMouseDown={() => {
            if (!workOrderClosing) setWorkOrderConfirmAction(null);
          }}
        >
          <section
            className="modal-panel detail-work-order-confirm-panel"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            {workOrderClosing && <div className="modal-closing-progress" aria-hidden="true" />}
            <header className="modal-header detail-main-machine-header">
              <h2>
                {t(
                  workOrderConfirmAction === "close"
                    ? "workReport:detailPage.manualClose"
                    : "workReport:detailPage.manualReopen"
                )}
              </h2>
              <button
                type="button"
                className="detail-main-machine-close"
                onClick={() => setWorkOrderConfirmAction(null)}
                disabled={workOrderClosing}
                aria-label={t("common:actions.close")}
              >
                ×
              </button>
            </header>
            <div className="detail-work-order-confirm-body">
              <p>
                {t(
                  workOrderConfirmAction === "close"
                    ? "workReport:detailPage.manualCloseConfirm"
                    : "workReport:detailPage.manualReopenConfirm",
                  { workOrderNo: String(record?.workOrderNo ?? "").trim() }
                )}
              </p>
            </div>
            <div className="modal-footer">
              <div className="modal-actions">
                <button
                  type="button"
                  className="modal-actions-secondary detail-main-machine-cancel"
                  onClick={() => setWorkOrderConfirmAction(null)}
                  disabled={workOrderClosing}
                >
                  {t("common:actions.cancel")}
                </button>
                <button
                  type="button"
                  className={
                    workOrderConfirmAction === "close"
                      ? "detail-page-close-btn"
                      : "detail-page-reopen-btn"
                  }
                  onClick={() => void confirmManualCloseWorkOrder()}
                  disabled={workOrderClosing}
                >
                  {workOrderClosing ? t("common:actions.saving") : t("common:actions.ok")}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
