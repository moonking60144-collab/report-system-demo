import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import "../styles/work-report-detail.css";
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
  type ReportMutationPayload,
  type WorkReportRecord,
  closeWorkOrderAccepted,
  reopenWorkOrderAccepted,
} from "../../../api/workReport";
import {
  EMPTY_FORM,
} from "../../../components/report-form/constants";
import {
  applyCreateDefaultsToFormState,
  buildInitialFormState,
} from "../../../components/report-form/formMemory";
import { buildReportMutationPayload } from "../../../components/report-form/formLogic";
import { WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY } from "../constants";
import type { FormState } from "../../../components/report-form/types";
import { ReportFormModal } from "../../../components/ReportFormModal";
import { formatTimeDisplay } from "../../../components/report-form/timeUtils";
import { WorkOrderContextCard } from "../../../components/WorkOrderContextCard";
import {
  LoadingSpinner,
  PageLoadingBoundary,
  type PageLoadingState,
} from "../../../components/PageLoadingBoundary";
import { WorkReportTaskQueueDrawer } from "../components/WorkReportTaskQueueDrawer";
import { RecordAuditHistoryModal } from "../components/RecordAuditHistoryModal";
import {
  DetailInlinePickerTrigger,
  DetailLinkedPickerModal,
} from "../components/DetailLinkedPicker";
import {
  WorkReportDetailTableSection,
  type WorkReportDetailTableEditorViewModel,
} from "../components/WorkReportDetailTableSection";
import { useWorkReportTaskMonitorContext } from "../context/useWorkReportTaskMonitorContext";
import { useWorkReportDetailInlineController } from "../hooks/detail/useWorkReportDetailInlineController";
import { useWorkReportDetailModalController } from "../hooks/detail/useWorkReportDetailModalController";
import { useWorkReportDetailPickerController } from "../hooks/detail/useWorkReportDetailPickerController";
import { useWorkReportDetailRefreshController } from "../hooks/detail/useWorkReportDetailRefreshController";
import { useWorkReportDetailResourceController } from "../hooks/detail/useWorkReportDetailResourceController";
import {
  resolveEditableMainMachineCode,
  useWorkReportMainMachineController,
} from "../hooks/detail/useWorkReportMainMachineController";
import { useWorkReportDetailStatusController } from "../hooks/detail/useWorkReportDetailStatusController";
import { useWorkReportDetailTaskController } from "../hooks/detail/useWorkReportDetailTaskController";
import { INLINE_EDITABLE_DETAIL_KEYS_BY_FORM } from "../hooks/detail/inlineControllerUtils";
import { workReportDetailEditorModeReducer } from "../hooks/detail/detailEditorMode";
import { useWorkReportClientPresence } from "../hooks/useWorkReportClientPresence";
import { useWorkReportSessionExpiryGuard } from "../hooks/useWorkReportSessionExpiryGuard";
import { saveRetryableBatchCreateRecord } from "../taskBatchRetryStore";
import type {
  DetailTableRow,
  InlineEditableDetailKey,
} from "../hooks/detail/types";
import type {
  UiLanguage,
  WorkReportFormId,
  WorkReportListLocationState,
  WorkReportMutationTaskKind,
} from "../types";
import { getErrorMessage, isWorkOrderClosedStatus } from "../utils";
import { showClosedLockWarning } from "../utils/closedLockWarning";
import { computePredictedCumulative } from "../utils/predictedCumulative";
import {
  calculateDurationMs,
  createFrontendOperationId,
  pushFrontendEvent,
  summarizeChangedPayloadFields,
} from "../logging/frontendEventLog";
import {
  BATCH_CREATE_FILLABLE_KEYS,
  buildBatchCreateFieldErrors,
  buildCreatePlaceholderRow,
  INLINE_CREATE_PLACEHOLDER_COUNT,
  INLINE_CREATE_PLACEHOLDER_ROW_PREFIX,
  INLINE_CREATE_TRAILING_PLACEHOLDER_COUNT,
  isCreatePlaceholderRow,
  isMeaningfulBatchCreateDraft,
  parseInlineCreatePlaceholderIndex,
  resolveBatchCreateFillKeys,
  type BatchCreateFieldErrorMap,
  type BatchCreateFillDragState,
} from "./detailBatchCreateUtils";
import {
  resolveLatestWorkOrderProductionProgress,
  resolveWorkOrderProductionProgress,
} from "../utils/workOrderProductionProgress";

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

const BATCH_CREATE_FILL_SCROLL_FALLBACK_PX = 62;
const BATCH_CREATE_FILL_SCROLL_MIN_PX = 44;
const BATCH_CREATE_FILL_SCROLL_MAX_PX = 96;

function getBatchCreateFillVerticalScrollAmount(scrollRoot: HTMLElement): number {
  const placeholderRows = Array.from(
    scrollRoot.querySelectorAll<HTMLElement>("tr[data-row-kind='create-placeholder']")
  );
  const measuredRow =
    placeholderRows.find((row) => !row.classList.contains("is-inline-editing")) ??
    placeholderRows[0] ??
    null;
  const measuredHeight = measuredRow
    ? Math.ceil(measuredRow.getBoundingClientRect().height)
    : 0;
  if (!measuredHeight) {
    return BATCH_CREATE_FILL_SCROLL_FALLBACK_PX;
  }
  return Math.min(
    BATCH_CREATE_FILL_SCROLL_MAX_PX,
    Math.max(BATCH_CREATE_FILL_SCROLL_MIN_PX, measuredHeight)
  );
}

function isPlannedIdleYesValue(value: unknown): boolean {
  return String(value ?? "").trim() === "Yes";
}

function resolveExpectedEntryLastUpdatedAt(
  record: WorkReportRecord | null
): string | undefined {
  const value = String(record?.lastUpdatedAt ?? "").trim();
  return value || undefined;
}

interface PendingMutationReplay {
  kind: WorkReportMutationTaskKind;
  formId: WorkReportFormId;
  entryId: string;
  rowId?: string;
  payload: ReportMutationPayload;
  clientMutationId: string;
  createIdempotencyKey?: string;
  expectedEntryLastUpdatedAt?: string;
  editSessionId?: string;
  editLockVersion?: number;
  attempts: number;
  createdAt: string;
}

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

const SETUP_COLUMNS_ORDER_901: ReadonlyArray<OrderedDetailColumn> = [
  { key: "setupAdjustType", label: "workReport:reportForm.setupSection.fields.setupAdjustType", className: "col-setup-adjust-type" },
  { key: "setupAdjustMinutes", label: "workReport:reportForm.setupSection.fields.setupAdjustMinutes", className: "col-compact col-number" },
  { key: "countSetupTimeFlag", label: "workReport:reportForm.setupSection.fields.countSetupTimeFlag", className: "col-compact col-flag" },
  { key: "setupTimeStandardHours", label: "workReport:reportForm.setupSection.fields.setupTimeStandardHours" },
  { key: "setupLossQtyPerPcs", label: "workReport:reportForm.setupSection.fields.setupLossQtyPerPcs" },
  { key: "processLossQtyPerPcs", label: "workReport:reportForm.setupSection.fields.processLossQtyPerPcs" },
  { key: "totalContainerQty", label: "workReport:reportForm.setupSection.fields.totalContainerQty" },
  { key: "containerUnit", label: "workReport:reportForm.setupSection.fields.containerUnit" },
];

const REASON_COLUMNS_ORDER_901: ReadonlyArray<OrderedDetailColumn> = [
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

const SUPPORTED_FORM_IDS = new Set<WorkReportFormId>(["901", "902"]);
const DETAIL_HIDDEN_COLUMNS_STORAGE_KEY = "work-report:detail-hidden-columns:v4";
const ALWAYS_AVAILABLE_DETAIL_DYNAMIC_KEYS: ReadonlyArray<string> = [
  "demo_created_by",
  "demo_reference_no",
  "demo_actual_minutes",
  "demo_utilization_rate",
  "demo_prod_type",
  "demo_process_name",
  "demo_report_type",
  "demo_created_at",
  "demo_department_group",
  "demo_efficiency_default_active",
  "demo_efficiency_default_code",
  "demo_efficiency_assigned_code",
  "demo_category_qty_a",
  "demo_category_qty_b",
  "demo_test_value",
  "demo_cumulative_qty_a",
  "demo_cumulative_qty_b",
  "demo_part_no",
  "demo_primary_operator_id",
];
const DEFAULT_HIDDEN_DETAIL_COLUMNS = new Set<string>([
  "reportType",
  "rowId",
  "demo_prod_type",
  "demo_process_name",
  "demo_report_type",
  "demo_created_at",
  "demo_department_group",
  "demo_efficiency_default_active",
  "demo_efficiency_default_code",
  "demo_efficiency_assigned_code",
  "demo_category_qty_a",
  "demo_category_qty_b",
  "demo_test_value",
  "demo_cumulative_qty_a",
  "demo_cumulative_qty_b",
  "demo_part_no",
  "demo_primary_operator_id",
]);

const BATCH_CREATE_VALIDATION_FIELD_LABEL_KEYS: Partial<Record<InlineEditableDetailKey, string>> = {
  date: "workReport:table.headers.date",
  processCode: "workReport:table.headers.process",
  machineId: "workReport:table.headers.machine",
  operatorId: "workReport:table.headers.operatorId",
  startTime: "workReport:table.headers.startTime",
  endTime: "workReport:table.headers.endTime",
  productionQty: "workReport:table.headers.qty",
};

function isSupportedFormId(value: string | undefined): value is WorkReportFormId {
  return value !== undefined && SUPPORTED_FORM_IDS.has(value as WorkReportFormId);
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
  const {
    createTaskMonitors,
    registerEntryFieldSettlementConsumer,
    upsertCreateTaskMonitor,
    retryEntryFieldConfirmation,
  } = useWorkReportTaskMonitorContext();

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

  const [notice, setNotice] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);
  const {
    entry: {
      record,
      authoritativeRecord,
      loading,
      refreshing,
      loadError,
      loadEntry,
      mergeAuthoritativeRecord,
    },
    options: { formOptions, optionsLoading, ensureOptionsLoaded },
    editing: {
      entryEditingSummary,
      currentEditSessionId,
      editLockVersion,
      acquireRowEditLock,
      releaseRowEditLock,
      clearActiveRowEditLock,
    },
  } = useWorkReportDetailResourceController({
    isValidRoute,
    formId,
    safeEntryId,
    createTaskMonitors,
    setNotice,
    t,
  });
  const expectedEntryLastUpdatedAt = resolveExpectedEntryLastUpdatedAt(record);
  const [contextCollapsed, setContextCollapsed] = useState(false); // 工令資訊卡收合 → 表格區吃滿剩餘高
  const [submitting, setSubmitting] = useState(false);
  const [taskQueueDrawerOpen, setTaskQueueDrawerOpen] = useState(false);
  const batchCreateSubmitInFlightRef = useRef(false);
  const [detailEditorMode, dispatchDetailEditorMode] = useReducer(
    workReportDetailEditorModeReducer,
    "idle"
  );
  const batchCreateMode = detailEditorMode === "batch-create";
  const batchDeleteMode = detailEditorMode === "batch-delete";
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
  const batchCreateFillDragRef = useRef<BatchCreateFillDragState | null>(null);
  const batchCreateFillPointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const batchCreateFillVerticalStepAtRef = useRef(0);
  const batchCreateFillHorizontalStepAtRef = useRef(0);
  const batchCreateFillPendingVerticalScrollRef = useRef(0);
  const batchCreateFillScrollFrameRef = useRef(0);
  const [selectedBatchDeleteRowIds, setSelectedBatchDeleteRowIds] = useState<Set<string>>(
    () => new Set()
  );
  const [highlightedDetailRowId, setHighlightedDetailRowId] = useState<string | null>(null);
  const [workOrderClosing, setWorkOrderClosing] = useState(false);
  const workOrderCloseRequestInFlightRef = useRef(false);
  const [workOrderConfirmAction, setWorkOrderConfirmAction] = useState<"close" | "reopen" | null>(null);
  const [workOrderUnderTargetAcknowledged, setWorkOrderUnderTargetAcknowledged] = useState(false);
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
      "901": "/demo/work-orders/line-a",
      "902": "/demo/work-orders/line-b",
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
    expectedEntryLastUpdatedAt,
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
    plannedIdlePickerOptions,
    setupAdjustTypePickerOptions,
    countSetupTimeFlagPickerOptions,
    containerUnitPickerOptions,
    selectedInlineMachineOption,
    selectedInlineOperatorOption,
    selectedInlineProcessOption,
    selectedInlineInputOption,
    selectedInlineShiftTypeOption,
    selectedInlinePlannedIdleOption,
    selectedInlineSetupAdjustTypeOption,
    selectedInlineCountSetupTimeFlagOption,
    selectedInlineContainerUnitOption,
    setEditingRowDraft,
    activateInlineCreateRow,
    startInlineRowEdit,
    handleDetailTableKeyDown,
    updateEditingRowField,
    updateEditingTimeField,
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
    hasActiveMutationTask: hasActiveMutationTask || hasBlockingMutationTask,
    modalOpen: modalState.open,
    loading,
    refreshing,
    submitting,
    ensureOptionsLoaded,
    registerAcceptedMutationTask,
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
    retryEntryFieldConfirmation,
    registerEntryFieldSettlementConsumer,
    activeMutationTask,
    activeMutationTaskCount,
    registerAcceptedMutationTask,
    pendingMutationReplayStorageKey: WORK_REPORT_PENDING_MUTATION_REPLAY_STORAGE_KEY,
    setNotice,
    setHighlightedDetailRowId,
    loadEntry,
    currentRecord: authoritativeRecord,
    mergeAuthoritativeRecord,
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
  useEffect(() => {
    dispatchDetailEditorMode({ type: "reset" });
    setBatchCreateDraftsByRowId({});
    setBatchCreateFieldErrorsByRowId({});
    setBatchCreateFillDrag(null);
    setSelectedBatchDeleteRowIds(new Set());
  }, [formId, safeEntryId]);
  useEffect(() => {
    if (!batchCreateMode) {
      setBatchCreateFillDrag(null);
    }
  }, [batchCreateMode]);

  const detailRows = useMemo(() => record?.reports ?? [], [record]);
  const workOrderProductionProgress = useMemo(
    () =>
      resolveLatestWorkOrderProductionProgress(
        detailRows,
        record?.targetQtyPc
      ),
    [detailRows, record?.targetQtyPc]
  );
  const productionQtyFormatter = useMemo(
    () =>
      new Intl.NumberFormat(uiLanguage === "en" ? "en-US" : "zh-TW", {
        maximumFractionDigits: 2,
      }),
    [uiLanguage]
  );
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
      if (isWorkOrderClosedStatus(record?.status)) {
        showClosedLockWarning(t("workReport:detailPage.closedLockedMessage"));
        return;
      }
      const existingDraft = batchCreateDraftsByRowId[rowId] ?? null;
      dispatchDetailEditorMode({ type: "enter-batch-create" });
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
    dispatchDetailEditorMode({ type: "reset" });
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
    if (!formId || !safeEntryId || submitting || batchCreateSubmitInFlightRef.current) {
      return;
    }
    batchCreateSubmitInFlightRef.current = true;
    setSubmitting(true);
    try {
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

      const defaultedDraftEntries = draftEntries.map(
        ([rowId, draft]) =>
          [
            rowId,
            applyCreateDefaultsToFormState(
              draft,
              record,
              formOptions.machineId ?? [],
              formOptions.operatorId ?? []
            ),
          ] as const
      );

      const nextErrors: Record<string, BatchCreateFieldErrorMap> = {};
      for (const [rowId, draft] of defaultedDraftEntries) {
        const rowErrors = buildBatchCreateFieldErrors(draft, t);
        if (Object.keys(rowErrors).length > 0) {
          nextErrors[rowId] = rowErrors;
        }
      }
      setBatchCreateFieldErrorsByRowId(nextErrors);
      if (Object.keys(nextErrors).length > 0) {
        setNotice({ type: "error", message: t("workReport:detailPage.batchCreateValidationHint") });
        const sortedInvalidRowIds = Object.keys(nextErrors).sort(
          (leftRowId, rightRowId) =>
            (parseInlineCreatePlaceholderIndex(leftRowId) ?? 0) -
            (parseInlineCreatePlaceholderIndex(rightRowId) ?? 0)
        );
        const validationRows = sortedInvalidRowIds.map((rowId) => {
          const rowIndex = parseInlineCreatePlaceholderIndex(rowId);
          const fieldLabels = (Object.keys(nextErrors[rowId] ?? {}) as InlineEditableDetailKey[])
            .map((field) => {
              const labelKey = BATCH_CREATE_VALIDATION_FIELD_LABEL_KEYS[field];
              return labelKey ? t(labelKey) : field;
            })
            .join("、");
          return {
            rowId,
            rowNumber: rowIndex === null ? rowId : String(rowIndex + 1),
            fieldLabels,
          };
        });
        Modal.warning({
          title: t("workReport:detailPage.batchCreateValidationModalTitle"),
          content: (
            <div>
              <p>{t("workReport:detailPage.batchCreateValidationModalContent")}</p>
              <ul>
                {validationRows.map((row) => (
                  <li key={row.rowId}>
                    {t("workReport:detailPage.batchCreateValidationModalRow", {
                      row: row.rowNumber,
                      fields: row.fieldLabels,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ),
          okText: t("common:actions.ok"),
          centered: true,
        });
        const firstInvalidRowId = sortedInvalidRowIds[0];
        await activateBatchCreateRow(firstInvalidRowId);
        return;
      }

      // 組 rows：每筆帶上 placeholder rowId 對應的 clientRowKey（UUID）
      // 已經在 activateBatchCreateRow 產過 key；萬一缺（理論上不會）當場補一個
      const rows = defaultedDraftEntries.map(([placeholderRowId, draft]) => {
        const clientRowKey =
          batchCreateClientKeysByRowId[placeholderRowId] ?? crypto.randomUUID();
        return {
          payload: buildReportMutationPayload(draft),
          clientRowKey,
        };
      });
      const accepted = await createReportsBatchAccepted(formId, safeEntryId, rows, {
        expectedEntryLastUpdatedAt,
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
        expectedEntryLastUpdatedAt,
        editSessionId: currentEditSessionId ?? undefined,
        createdAt: new Date().toISOString(),
      });
      await registerAcceptedMutationTask("create-batch", accepted, undefined, {
        mutationId: accepted.taskId,
        operation: "work-report-batch-create",
        target: {
          domain: "work-report",
          formId,
          entryId: safeEntryId,
        },
        patch: {
          kind: "create-rows",
          rows,
        },
        previousSnapshot: null,
        reconcilePolicy: "partial",
        failurePolicy: "rollback",
      });
      setNotice({
        type: "success",
        message: t("workReport:detailPage.batchCreateAcceptedTask", { count: draftEntries.length }),
      });
      setBatchCreateFieldErrorsByRowId({});
      setBatchCreateDraftsByRowId({});
      setBatchCreateClientKeysByRowId({});
      dispatchDetailEditorMode({ type: "reset" });
      cancelInlineRowEdit();
      setTaskQueueDrawerOpen(true);
    } finally {
      batchCreateSubmitInFlightRef.current = false;
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
    expectedEntryLastUpdatedAt,
    formId,
    formOptions.machineId,
    formOptions.operatorId,
    record,
    registerAcceptedMutationTask,
    safeEntryId,
    submitting,
    t,
  ]);
  const updateBatchCreateFillTarget = useCallback(
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
        const nextFillState = {
          ...previous,
          endKey: key,
          endIndex: hoverIndex,
        };
        batchCreateFillDragRef.current = nextFillState;
        return nextFillState;
      });
    },
    []
  );
  const handleFillPreviewHover = useCallback(
    (rowId: string, key: InlineEditableDetailKey) => {
      updateBatchCreateFillTarget(rowId, key);
    },
    [updateBatchCreateFillTarget]
  );
  useEffect(() => {
    batchCreateFillDragRef.current = batchCreateFillDrag;
  }, [batchCreateFillDrag]);
  const finalizeBatchCreateFill = useCallback(async (currentFillState?: BatchCreateFillDragState | null) => {
    const fillState = currentFillState ?? batchCreateFillDragRef.current;
    batchCreateFillDragRef.current = null;
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
          "create",
          null,
          record,
          formOptions.machineId ?? []
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
    editingRowDraft,
    editingRowId,
    formId,
    formOptions.machineId,
    record,
    t,
  ]);
  const scheduleBatchCreateFillVerticalScroll = useCallback(
    (amount: number) => {
      batchCreateFillPendingVerticalScrollRef.current += amount;
      if (batchCreateFillScrollFrameRef.current) {
        return;
      }
      batchCreateFillScrollFrameRef.current = window.requestAnimationFrame(() => {
        batchCreateFillScrollFrameRef.current = 0;
        const pendingAmount = batchCreateFillPendingVerticalScrollRef.current;
        batchCreateFillPendingVerticalScrollRef.current = 0;
        if (pendingAmount === 0) {
          return;
        }
        const scrollRoot = detailTableScrollRef.current;
        if (!scrollRoot) {
          return;
        }
        const maxScrollTop = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
        scrollRoot.scrollTop = Math.max(
          0,
          Math.min(maxScrollTop, scrollRoot.scrollTop + pendingAmount)
        );
      });
    },
    [detailTableScrollRef]
  );
  useEffect(
    () => () => {
      if (batchCreateFillScrollFrameRef.current) {
        window.cancelAnimationFrame(batchCreateFillScrollFrameRef.current);
        batchCreateFillScrollFrameRef.current = 0;
      }
      batchCreateFillPendingVerticalScrollRef.current = 0;
    },
    []
  );
  const batchCreateFillDragging = batchCreateFillDrag !== null;
  useEffect(() => {
    if (!batchCreateFillDragging) {
      return;
    }
    let frameId = 0;
    let pointerX = 0;
    let pointerY = 0;
    let hasPointer = false;
    const edgeThreshold = 56;
    const horizontalScrollStep = 18;
    const verticalStepIntervalMs = 140;
    const horizontalStepIntervalMs = 140;
    const verticalIntentThreshold = 36;

    const updateTargetFromPointer = () => {
      if (!hasPointer) {
        return false;
      }
      const scrollRoot = detailTableScrollRef.current;
      if (!scrollRoot) {
        return false;
      }

      const rootRect = scrollRoot.getBoundingClientRect();
      const nearBottom = pointerY >= rootRect.bottom - edgeThreshold;
      const nearTop = pointerY <= rootRect.top + edgeThreshold;
      const nearRight = pointerX >= rootRect.right - edgeThreshold;
      const nearLeft = pointerX <= rootRect.left + edgeThreshold;
      const pointerStart = batchCreateFillPointerStartRef.current;
      const deltaY = pointerStart ? pointerY - pointerStart.y : 0;
      const shouldMoveDown = deltaY >= verticalIntentThreshold;
      const shouldMoveUp = deltaY <= -verticalIntentThreshold;

      const now = Date.now();
      const shouldVerticalStep =
        ((nearBottom && shouldMoveDown) || (nearTop && shouldMoveUp)) &&
        now - batchCreateFillVerticalStepAtRef.current >= verticalStepIntervalMs;
      const shouldHorizontalStep =
        (nearRight || nearLeft) &&
        now - batchCreateFillHorizontalStepAtRef.current >= horizontalStepIntervalMs;

      if (nearBottom && shouldMoveDown && shouldVerticalStep) {
        batchCreateFillVerticalStepAtRef.current = now;
        const verticalScrollAmount = getBatchCreateFillVerticalScrollAmount(scrollRoot);
        setBatchCreateFillDrag((previous) => {
          if (!previous) {
            return previous;
          }
          const nextFillState = {
            ...previous,
            endIndex: previous.endIndex + 1,
          };
          batchCreateFillDragRef.current = nextFillState;
          return nextFillState;
        });
        scheduleBatchCreateFillVerticalScroll(verticalScrollAmount);
      } else if (nearTop && shouldMoveUp && shouldVerticalStep) {
        batchCreateFillVerticalStepAtRef.current = now;
        scheduleBatchCreateFillVerticalScroll(-getBatchCreateFillVerticalScrollAmount(scrollRoot));
      }
      if (nearRight && shouldHorizontalStep) {
        batchCreateFillHorizontalStepAtRef.current = now;
        scrollRoot.scrollLeft += horizontalScrollStep;
      } else if (nearLeft && shouldHorizontalStep) {
        batchCreateFillHorizontalStepAtRef.current = now;
        scrollRoot.scrollLeft -= horizontalScrollStep;
      }

      const pointedElement = document.elementFromPoint(pointerX, pointerY);
      const pointedCell = pointedElement?.closest?.<HTMLElement>("[data-inline-cell-key]");
      const pointedRow = pointedElement?.closest?.<HTMLElement>(
        "tr[data-row-kind='create-placeholder']"
      );
      const pointedKey = pointedCell?.getAttribute("data-inline-cell-key") as InlineEditableDetailKey | null;
      const pointedRowId = pointedRow?.getAttribute("data-row-id") ?? null;
      if (pointedRowId && pointedKey) {
        updateBatchCreateFillTarget(pointedRowId, pointedKey);
      }

      return (nearBottom && shouldMoveDown) || (nearTop && shouldMoveUp) || nearRight || nearLeft;
    };

    const scheduleFrame = () => {
      if (frameId) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        const keepRunning = updateTargetFromPointer();
        if (keepRunning) {
          scheduleFrame();
        }
      });
    };

    const handleMouseMove = (event: MouseEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      hasPointer = true;
      scheduleFrame();
    };
    const handleMouseUp = () => {
      batchCreateFillPointerStartRef.current = null;
      void finalizeBatchCreateFill(batchCreateFillDragRef.current);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      batchCreateFillPointerStartRef.current = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [
    batchCreateFillDragging,
    detailTableScrollRef,
    finalizeBatchCreateFill,
    scheduleBatchCreateFillVerticalScroll,
    updateBatchCreateFillTarget,
  ]);
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
        Math.max(
          activeBatchCreatePlaceholderIndex + INLINE_CREATE_TRAILING_PLACEHOLDER_COUNT,
          highestBatchCreateDraftIndex
        )
      );
      const trailingTargetRow = scrollRoot.querySelector<HTMLElement>(
        `tr[data-row-id="${INLINE_CREATE_PLACEHOLDER_ROW_PREFIX}:${trailingTargetIndex}"]`
      );
      if (trailingTargetRow) {
        trailingTargetRow.scrollIntoView({
          behavior: batchCreateFillDragRef.current ? "auto" : "smooth",
          block: "nearest",
        });
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
    highestBatchCreateDraftIndex,
  ]);
  const fixedExtraColumns = useMemo<ReadonlyArray<OrderedDetailColumn>>(() => {
    if (formId !== "901" && formId !== "902") {
      return [];
    }
    return [...SETUP_COLUMNS_ORDER_901, ...REASON_COLUMNS_ORDER_901].map((col) => ({
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
    recordMachineCode: resolveEditableMainMachineCode(formId, record),
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
    plannedIdlePickerOptions,
    setupAdjustTypePickerOptions,
    countSetupTimeFlagPickerOptions,
    containerUnitPickerOptions,
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
          <DetailInlinePickerTrigger
            value={selectedInlineSetupAdjustTypeOption?.display || draft.setupAdjustType}
            blankLabel={blankTokenLabel}
            editorKey="setupAdjustType"
            disabled={savingRowId === rowId}
            onOpen={() => openLinkedPicker("setupAdjustType", rowId)}
          />
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
          <DetailInlinePickerTrigger
            value={
              selectedInlineCountSetupTimeFlagOption?.display ||
              (draft.countSetupTimeFlag.trim() === "v" ? "是" : "否")
            }
            blankLabel="否"
            editorKey="countSetupTimeFlag"
            disabled={savingRowId === rowId}
            onOpen={() => openLinkedPicker("countSetupTimeFlag", rowId)}
          />
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
          <DetailInlinePickerTrigger
            value={selectedInlinePlannedIdleOption?.display || draft.plannedIdle}
            blankLabel={blankTokenLabel}
            editorKey="plannedIdle"
            disabled={savingRowId === rowId}
            onOpen={() => openLinkedPicker("plannedIdle", rowId)}
          />
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
            data-inline-editor-key="setupTimeStandardHours"
            data-prevent-row-click="true"
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
          <DetailInlinePickerTrigger
            value={selectedInlineContainerUnitOption?.display || draft.containerUnit}
            blankLabel={blankTokenLabel}
            editorKey="containerUnit"
            disabled={savingRowId === rowId}
            onOpen={() => openLinkedPicker("containerUnit", rowId)}
          />
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
      selectedInlinePlannedIdleOption,
      selectedInlineSetupAdjustTypeOption,
      selectedInlineCountSetupTimeFlagOption,
      selectedInlineContainerUnitOption,
      t,
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
              batchCreateFillPointerStartRef.current = {
                x: event.clientX,
                y: event.clientY,
              };
              batchCreateFillVerticalStepAtRef.current = 0;
              batchCreateFillHorizontalStepAtRef.current = 0;
              const nextFillState = {
                sourceRowId: item.rowId,
                sourceKey: key,
                endKey: key,
                startIndex,
                endIndex: startIndex,
              };
              batchCreateFillDragRef.current = nextFillState;
              setBatchCreateFillDrag(nextFillState);
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
  const predictionEditingState = useMemo(
    () => ({ editingRowId, editingRowDraft }),
    [editingRowDraft, editingRowId]
  );
  const deferredPredictionEditingState = useDeferredValue(predictionEditingState);
  const { predictedCumulativeMap, predictionSignature } = useMemo(() => {
    const map = computePredictedCumulative({
      detailRows,
      editingRowId: deferredPredictionEditingState.editingRowId,
      editingRowDraft: deferredPredictionEditingState.editingRowDraft,
      batchCreateDraftsByRowId,
      batchCreateMode,
      displayRows: displayDetailRows,
    });
    const sig = Array.from(map.entries())
      .map(([k, v]) => `${k}:${v.cum}:${v.isPredicted ? "1" : "0"}`)
      .join("|");
    return { predictedCumulativeMap: map, predictionSignature: sig };
  }, [detailRows, deferredPredictionEditingState, batchCreateDraftsByRowId, batchCreateMode, displayDetailRows]);

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

          const cumulativeValue = showPredicted ? predicted!.cum : item.cumulativeQty;
          const productionProgress = resolveWorkOrderProductionProgress(
            cumulativeValue,
            record?.targetQtyPc
          );
          const progressTitle =
            productionProgress.status === "below-target"
              ? t("workReport:detailPage.cumulativeBelowTarget", {
                  current: productionQtyFormatter.format(
                    productionProgress.cumulativeQty ?? 0
                  ),
                  target: productionQtyFormatter.format(
                    productionProgress.targetQty ?? 0
                  ),
                  shortfall: productionQtyFormatter.format(
                    productionProgress.shortfallQty ?? 0
                  ),
                })
              : productionProgress.status === "target-met"
                ? t("workReport:detailPage.cumulativeTargetMet", {
                    current: productionQtyFormatter.format(
                      productionProgress.cumulativeQty ?? 0
                    ),
                    target: productionQtyFormatter.format(
                      productionProgress.targetQty ?? 0
                    ),
                  })
                : undefined;

          return (
            <div
              className={`detail-progress-cell${showPredicted ? " detail-progress-cell--predicted" : ""}${
                productionProgress.status !== "unavailable"
                  ? ` detail-progress-cell--${productionProgress.status}`
                  : ""
              }`}
              data-production-status={productionProgress.status}
              title={progressTitle}
            >
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
              {productionProgress.progressPercent !== null && (
                <div
                  className={`detail-progress-track${showPredicted ? " detail-progress-track--predicted" : ""} detail-progress-track--${productionProgress.status}`}
                  aria-hidden="true"
                >
                  <div
                    className="detail-progress-fill"
                    style={{ width: `${productionProgress.progressPercent}%` }}
                  />
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
      productionQtyFormatter,
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
      setWorkOrderUnderTargetAcknowledged(false);
      setWorkOrderConfirmAction(action);
    },
    [record, workOrderClosing]
  );

  const isUnderTargetCloseWarningStep =
    workOrderConfirmAction === "close" &&
    workOrderProductionProgress.status === "below-target" &&
    !workOrderUnderTargetAcknowledged;

  const confirmManualCloseWorkOrder = useCallback(async () => {
    if (!formId || !safeEntryId || !workOrderConfirmAction) return;
    if (isUnderTargetCloseWarningStep) {
      setWorkOrderUnderTargetAcknowledged(true);
      return;
    }
    if (workOrderCloseRequestInFlightRef.current) {
      return;
    }
    workOrderCloseRequestInFlightRef.current = true;
    setWorkOrderClosing(true);
    try {
      const action = workOrderConfirmAction;
      const clientMutationId = createClientMutationId();
      const accepted = action === "close"
        ? await closeWorkOrderAccepted(formId, safeEntryId, {
            clientMutationId,
            workOrderNo: record?.workOrderNo ?? null,
            expectedEntryLastUpdatedAt,
          })
        : await reopenWorkOrderAccepted(formId, safeEntryId, {
            clientMutationId,
            workOrderNo: record?.workOrderNo ?? null,
            expectedEntryLastUpdatedAt,
          });
      await registerAcceptedMutationTask("update", accepted, undefined, {
        mutationId: clientMutationId,
        operation: action === "close" ? "work-report-close" : "work-report-reopen",
        target: {
          domain: "work-report",
          formId,
          entryId: safeEntryId,
        },
        patch: {
          kind: "update-entry",
          patch: { status: action === "close" ? "已結案" : "未結案" },
        },
        previousSnapshot: { status: record?.status ?? null },
        reconcilePolicy: "refresh-entry",
        failurePolicy: "rollback",
      });
      const successKey =
        action === "close"
          ? "workReport:detailPage.manualCloseSuccess"
          : "workReport:detailPage.manualReopenSuccess";
      setWorkOrderConfirmAction(null);
      setWorkOrderUnderTargetAcknowledged(false);
      setNotice({ type: "success", message: t(successKey) });
    } catch (error) {
      setNotice({ type: "error", message: getErrorMessage(error) });
    } finally {
      workOrderCloseRequestInFlightRef.current = false;
      setWorkOrderClosing(false);
    }
  }, [
    formId,
    expectedEntryLastUpdatedAt,
    isUnderTargetCloseWarningStep,
    record?.status,
    record?.workOrderNo,
    registerAcceptedMutationTask,
    safeEntryId,
    t,
    workOrderConfirmAction,
  ]);

  const dismissWorkOrderConfirm = useCallback(() => {
    if (workOrderClosing) {
      return;
    }
    setWorkOrderConfirmAction(null);
    setWorkOrderUnderTargetAcknowledged(false);
  }, [workOrderClosing]);

  const handleDelete = useCallback(
    async (rowId: string): Promise<void> => {
      if (!formId || !safeEntryId) {
        return;
      }
      if (
        loading ||
        refreshing ||
        submitting ||
        hasActiveMutationTask ||
        hasBlockingMutationTask
      ) {
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
            const accepted = await deleteReport(formId, safeEntryId, rowId, {
              expectedRowSnapshotHash: record?.reports?.find((item) => item.rowId === rowId)?.snapshotHash,
              expectedEntryLastUpdatedAt,
              editSessionId: currentEditSessionId,
              editLockVersion: lockVersion,
              workOrderNo: record?.workOrderNo ?? null,
            });
            const requestEndedAt = new Date().toISOString();
            logDetailEvent("api", "detail-delete-accepted", "刪除報工明細已排入佇列", {
              rowId,
              taskId: accepted.taskId,
              operationId,
              operationType: "detail-delete",
              phase: "accepted",
              startedAt,
              endedAt: requestEndedAt,
              durationMs: calculateDurationMs(startedAt, requestEndedAt),
            });
            await registerAcceptedMutationTask("delete", accepted, rowId, {
              mutationId: accepted.taskId,
              operation: "work-report-delete",
              target: {
                domain: "work-report",
                formId,
                entryId: safeEntryId,
                rowId,
              },
              patch: { kind: "delete-rows", rowIds: [rowId] },
              previousSnapshot:
                record?.reports?.find((item) => String(item.rowId) === rowId) ?? null,
              reconcilePolicy: "refresh-entry",
              failurePolicy: "rollback",
            });
            setNotice({ type: "success", message: t("workReport:messages.detailDeleteQueued") });
            setTaskQueueDrawerOpen(true);
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
      expectedEntryLastUpdatedAt,
      formId,
      hasActiveMutationTask,
      hasBlockingMutationTask,
      logDetailEvent,
      loading,
      record?.workOrderNo,
      record?.reports,
      registerAcceptedMutationTask,
      releaseRowEditLock,
      refreshing,
      safeEntryId,
      submitting,
      t,
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
      if (loading || refreshing) {
        return;
      }
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
      loading,
      refreshing,
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
    if (
      loading ||
      refreshing ||
      submitting ||
      hasActiveMutationTask ||
      hasBlockingMutationTask
    ) {
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
        const selectedRows = record?.reports?.filter((item) => rowIds.includes(item.rowId)) ?? [];
        const expectedRowSnapshotHashes = selectedRows.length === rowIds.length && selectedRows.every((item) => item.snapshotHash)
          ? Object.fromEntries(selectedRows.map((item) => [item.rowId, item.snapshotHash!])) : undefined;
        const accepted = await deleteReportsBatchAccepted(formId, safeEntryId, rowIds, {
          expectedRowSnapshotHashes,
          expectedEntryLastUpdatedAt,
          editSessionId: currentEditSessionId,
          workOrderNo: record?.workOrderNo ?? null,
        });
        await registerAcceptedMutationTask("delete-batch", accepted, undefined, {
          mutationId: accepted.taskId,
          operation: "work-report-batch-delete",
          target: {
            domain: "work-report",
            formId,
            entryId: safeEntryId,
          },
          patch: { kind: "delete-rows", rowIds },
          previousSnapshot:
            record?.reports?.filter((item) => rowIds.includes(String(item.rowId))) ?? [],
          reconcilePolicy: "partial",
          failurePolicy: "rollback",
        });
        setNotice({
          type: "success",
          message: t("workReport:messages.batchDeleteAccepted", {
            count: rowIds.length,
          }),
        });
        dispatchDetailEditorMode({ type: "reset" });
        setSelectedBatchDeleteRowIds(new Set());
        setTaskQueueDrawerOpen(true);
      },
    });
  }, [
    batchDeleteSelectableRowIds,
    currentEditSessionId,
    expectedEntryLastUpdatedAt,
    formId,
    hasActiveMutationTask,
    hasBlockingMutationTask,
    loading,
    registerAcceptedMutationTask,
    record?.workOrderNo,
    record?.reports,
    refreshing,
    safeEntryId,
    selectedBatchDeleteRowIds,
    submitting,
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
    dispatchDetailEditorMode({ type: "enter-batch-delete" });
  }, []);
  const cancelBatchDeleteMode = useCallback(() => {
    dispatchDetailEditorMode({ type: "reset" });
    setSelectedBatchDeleteRowIds(new Set());
  }, []);
  const refreshDetailEntry = useCallback(async () => {
    try {
      await loadEntry({
        forceRefresh: true,
        mode: record ? "background" : "foreground",
        notifyOnError: !record,
        throwOnError: true,
      });
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

        const isRecordClosed = isWorkOrderClosedStatus(record?.status);
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
                loading ||
                refreshing ||
                submitting ||
                editingRowId !== null ||
                hasActiveMutationTask ||
                hasBlockingMutationTask ||
                Boolean(item.__optimisticState)
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
                loading ||
                refreshing ||
                submitting ||
                editingRowId !== null ||
                hasActiveMutationTask ||
                hasBlockingMutationTask ||
                Boolean(item.__optimisticState)
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
      loading,
      openEditModal,
      record?.status,
      refreshing,
      saveInlineRowEdit,
      setEditingRowDraft,
      savingRowId,
      submitting,
      hasActiveMutationTask,
      hasBlockingMutationTask,
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
  const detailTableEditor = useMemo<WorkReportDetailTableEditorViewModel>(
    () => ({
      mode: detailEditorMode,
      batchCreateDraftCount: batchCreateDraftRowIds.length,
      allBatchDeleteRowsSelected,
      selectedBatchDeleteCount: selectedBatchDeleteRowIds.size,
      editingRowId,
      savingRowId,
      predictionSignature,
      editingRowDraftSignature,
      highlightedDetailRowId,
      batchCreateFillDrag,
      batchCreateFieldErrorsByRowId,
      inlineEditableColumnKeySet,
      autoHighlightedInlineKeys,
      selectedBatchDeleteRowIds,
    }),
    [
      allBatchDeleteRowsSelected,
      autoHighlightedInlineKeys,
      batchCreateDraftRowIds.length,
      batchCreateFieldErrorsByRowId,
      batchCreateFillDrag,
      detailEditorMode,
      editingRowDraftSignature,
      editingRowId,
      highlightedDetailRowId,
      inlineEditableColumnKeySet,
      predictionSignature,
      savingRowId,
      selectedBatchDeleteRowIds,
    ]
  );
  const hasRenderableDetail = record !== null;
  const detailPageState: PageLoadingState = !hasRenderableDetail && loading
    ? {
        kind: "pending",
        message: t("common:states.loadingData"),
      }
    : !hasRenderableDetail && loadError
      ? {
          kind: "error",
          title: t("common:states.loadFailedTitle"),
          message: loadError,
          action: isValidRoute
            ? {
                label: t("common:actions.retry"),
                onClick: () => {
                  void loadEntry();
                },
              }
            : undefined,
        }
      : !hasRenderableDetail
        ? {
            kind: "error",
            title: t("common:states.loadFailedTitle"),
            message: t("common:states.noData"),
          }
        : { kind: "ready" };

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

          {hasRenderableDetail ? (
            <section className="detail-system-status-wrap" role="status" aria-live="polite">
              <div className={`detail-system-status detail-system-status--${systemStatus.type}`}>
                <span className="detail-system-status-content">
                  {systemStatus.showSpinner ? <LoadingSpinner size="small" /> : null}
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
          ) : null}
        </section>

        <PageLoadingBoundary state={detailPageState} variant="section">
          {record ? (
            <>
              <WorkOrderContextCard
                  key={`${record?.id ?? "empty"}:detail`}
                  record={record}
                  uiLanguage={uiLanguage}
                  collapsible
                  collapsed={contextCollapsed}
                  onToggleCollapse={() => setContextCollapsed((v) => !v)}
                  detailCollapsible
                  detailDefaultCollapsed
              />

              <WorkReportDetailTableSection
                  key={`${formId ?? "none"}:${safeEntryId || "none"}`}
                  detailRowsCount={detailRows.length}
                  editor={detailTableEditor}
                  loading={loading}
                  refreshing={refreshing}
                  submitting={submitting}
                  hasActiveMutationTask={hasActiveMutationTask}
                  hasBlockingMutationTask={hasBlockingMutationTask}
                  modalOpen={modalState.open}
                  workOrderClosing={workOrderClosing}
                  recordStatus={record?.status ?? null}
                  renderedDetailColumns={renderedDetailColumns}
                  toggleableDetailColumns={toggleableDetailColumns}
                  hiddenColumnKeys={hiddenColumnKeys}
                  displayDetailRows={displayDetailRows}
                  displayDetailRowMetaByRowId={displayDetailRowMetaByRowId}
                  detailTableScrollRef={detailTableScrollRef}
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
          ) : null}
        </PageLoadingBoundary>
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
          initialFocusValue={
            linkedPickerState.key === "plannedIdle" ? linkedPickerSelectedValue : null
          }
          onSearchChange={updateLinkedPickerSearch}
          onSelect={handleLinkedOptionSelect}
          onClose={closeLinkedPicker}
        />
      ) : null}

      <ReportFormModal
        key={`${modalState.open ? "open" : "closed"}:${modalState.mode}:${modalState.row?.rowId ?? "new"}:${record?.id ?? "entry"}:${createFormResetToken}`}
        formId={formId ?? "901"}
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
                <strong>{resolveEditableMainMachineCode(formId, record) || "-"}</strong>
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
          onMouseDown={dismissWorkOrderConfirm}
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
                  isUnderTargetCloseWarningStep
                    ? "workReport:detailPage.manualCloseUnderTargetTitle"
                    : workOrderConfirmAction === "close"
                    ? "workReport:detailPage.manualClose"
                    : "workReport:detailPage.manualReopen"
                )}
              </h2>
              <button
                type="button"
                className="detail-main-machine-close"
                onClick={dismissWorkOrderConfirm}
                disabled={workOrderClosing}
                aria-label={t("common:actions.close")}
              >
                ×
              </button>
            </header>
            <div className="detail-work-order-confirm-body">
              {isUnderTargetCloseWarningStep ? (
                <div className="detail-work-order-under-target-warning">
                  <p className="detail-work-order-under-target-message">
                    {t("workReport:detailPage.manualCloseUnderTargetMessage", {
                      workOrderNo: String(record?.workOrderNo ?? "").trim(),
                    })}
                  </p>
                  <dl className="detail-work-order-under-target-metrics">
                    <div>
                      <dt>{t("workReport:detailPage.currentCumulativeQty")}</dt>
                      <dd>
                        {productionQtyFormatter.format(
                          workOrderProductionProgress.cumulativeQty ?? 0
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("workReport:detailPage.targetProductionQty")}</dt>
                      <dd>
                        {productionQtyFormatter.format(
                          workOrderProductionProgress.targetQty ?? 0
                        )}
                      </dd>
                    </div>
                    <div className="is-shortfall">
                      <dt>{t("workReport:detailPage.productionShortfallQty")}</dt>
                      <dd>
                        {productionQtyFormatter.format(
                          workOrderProductionProgress.shortfallQty ?? 0
                        )}
                      </dd>
                    </div>
                  </dl>
                  <p className="detail-work-order-under-target-hint">
                    {t("workReport:detailPage.manualCloseUnderTargetHint")}
                  </p>
                </div>
              ) : (
                <p>
                  {t(
                    workOrderConfirmAction === "close"
                      ? "workReport:detailPage.manualCloseConfirm"
                      : "workReport:detailPage.manualReopenConfirm",
                    { workOrderNo: String(record?.workOrderNo ?? "").trim() }
                  )}
                </p>
              )}
            </div>
            <div className="modal-footer">
              <div className="modal-actions">
                <button
                  type="button"
                  className="modal-actions-secondary detail-main-machine-cancel"
                  onClick={dismissWorkOrderConfirm}
                  disabled={workOrderClosing}
                >
                  {t("common:actions.cancel")}
                </button>
                <button
                  type="button"
                  className={
                    isUnderTargetCloseWarningStep
                      ? "detail-page-under-target-continue-btn"
                      : workOrderConfirmAction === "close"
                      ? "detail-page-close-btn"
                      : "detail-page-reopen-btn"
                  }
                  onClick={() => void confirmManualCloseWorkOrder()}
                  disabled={workOrderClosing}
                >
                  {workOrderClosing
                    ? t("common:actions.saving")
                    : isUnderTargetCloseWarningStep
                      ? t("workReport:detailPage.manualCloseUnderTargetContinue")
                      : t("common:actions.ok")}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
