export interface WorkReportItem {
  [key: string]: unknown;
  rowId: string;
  date: string | null;
  reportType?: string | null;
  plannedIdle: string | null;
  processCode: string | null;
  processCodeDisplay: string | null;
  machineId: string | null;
  machineIdDisplay: string | null;
  operatorId: string | null;
  operatorIdDisplay: string | null;
  operatorName: string | null;
  inputOptions: string | null;
  shiftType: string | null;
  startTime: string | null;
  endTime: string | null;
  breakTime: string | null;
  totalWorkTime: number | string | null;
  productionQty: number | string | null;
  cumulativeQty?: number | string | null;
  remark?: string | null;
  setupAdjustType?: string | null;
  setupAdjustMinutes?: number | string | null;
  countSetupTimeFlag?: string | null;
  setupTimeStandardHours?: number | string | null;
  setupLossQtyPerPcs?: number | string | null;
  processLossQtyPerPcs?: number | string | null;
  totalContainerQty?: number | string | null;
  containerUnit?: string | null;
  plannedIdleMinutes?: number | string | null;
  unplannedIdleMinutes?: number | string | null;
  absentOrTrainingMinutes?: number | string | null;
  noMaterialMinutes?: number | string | null;
  waitingQcApprovalMinutes?: number | string | null;
  meetingMinutes?: number | string | null;
  cleaningMinutes?: number | string | null;
  rdSamplingMinutes?: number | string | null;
  supportOtherMachinesMinutes?: number | string | null;
  machineBreakdownMinutes?: number | string | null;
  machineAdjustmentMinutes?: number | string | null;
  othersMinutes?: number | string | null;
  waitingForDiesMinutes?: number | string | null;
  testingDiesMinutes?: number | string | null;
}

export interface WorkReportRecord {
  id: string;
  lastUpdatedAt?: string | null;
  machineCode?: string | null;
  filterMachineCode?: string | null;
  modificationStatus?: string | null;
  workOrderNo: string | null;
  workOrderType?: string | null;
  processName?: string | null;
  defaultProcessCode?: string | null;
  prodType?: string | null;
  status: string | null;
  ragicUnfinishedStatus?: string | null;
  misCloseStatus?: string | null;
  targetQtyPc?: number | string | null;
  pendingQty?: number | string | null;
  producedQtyStat?: number | string | null;
  estimatedHours?: number | string | null;
  currentMaterial?: string | null;
  primaryMaterial?: string | null;
  defaultMainMaterial?: string | null;
  size?: string | null;
  prevStationRunning?: string | null;
  prevStationStatus?: string | null;
  siteRunning?: string | null;
  prevReportQtyPc?: number | string | null;
  prevReportQtyKg?: number | string | null;
  prevReportContainerQty?: number | string | null;
  prevCompletePc?: number | string | null;
  prevCompleteKg?: number | string | null;
  prevCompleteContainer?: number | string | null;
  plannedEndDate?: string | null;
  plannedStartDate?: string | null;
  prevPlanEndDate?: string | null;
  customerPartNo: string | null;
  erpPartNo: string | null;
  reports?: WorkReportItem[];
  reportsLoaded?: boolean;
  [key: string]: unknown;
}

export interface WorkReportResponse {
  data: WorkReportRecord[];
  meta: {
    formId: string;
    count: number;
    totalCount: number;
    hasMore: boolean;
    limit: number;
    offset: number;
    keyword: string;
    workOrderKeyword?: string;
    customerPartKeyword?: string;
    status?: string;
    ragicUnfinishedStatus?: string;
    machineCode?: string;
    siteRunning?: string;
    startSchedule?: string;
    updatedDateFrom?: string;
    updatedDateTo?: string;
    sort?: string;
    refresh?: boolean;
  };
}

export interface WorkReportFullResponse {
  data: WorkReportRecord[];
  meta: {
    formId: string;
    count: number;
    cacheSource: "file-cache" | "memory-cache" | "sqlite" | "ragic-live";
    cacheState: "fresh" | "stale" | "building";
    snapshotAt: string | null;
    expiresAt: string | null;
    refreshTriggered: boolean;
    truncated: boolean;
    truncatedCount?: number;
  };
}

export interface WorkReportFacetCount {
  token: string;
  count: number;
}

export interface WorkReportAnalysisSummary {
  totalCount: number;
  nonEmptyCount: number;
  blankCount: number;
  distinctCount: number;
  numberStats?: {
    sum: number;
    avg: number;
    min: number;
    max: number;
    count: number;
  };
  dateStats?: {
    earliest: string | null;
    latest: string | null;
    count: number;
  };
  booleanStats?: {
    yes: number;
    no: number;
    blank: number;
  };
  topValues?: Array<{ label: string; count: number }>;
}

export interface BackendColumnFilterRule {
  type: "text" | "number" | "date" | "boolean";
  selectedTokens?: string[];
  textQuery?: string;
}

export type BackendColumnFilterState = Partial<Record<string, BackendColumnFilterRule>>;

export interface FormOptionItem {
  value: string;
  label: string;
  display: string;
  operatorGroupKey?: string;
  operatorGroupLabel?: string;
  processGroupKey?: string;
  processGroupLabel?: string;
  machineDefault?: {
    machineCode: string;
    processCategoryCode?: string;
    processCategoryName?: string;
    processCode?: string;
    mainOperatorId?: string;
    mainOperatorName?: string;
    machineSpec?: string;
    machineSpeed?: string;
    status?: string;
    sourceEntryId?: string;
  };
}

export type FormOptionMap = Record<string, FormOptionItem[]>;

export interface ReportMutationResult {
  rowId: string;
}

export interface MainMachineUpdateResult {
  machineCode: string;
}

export interface EditingPresenceSnapshot {
  hasOtherEditors: boolean;
  otherEditorCount: number;
  observedAt: string;
  canEdit: boolean;
  isCurrentSessionOwner: boolean;
  lockAcquiredAt?: string;
  idleMs?: number;
  lockVersion?: number;
}

export type WorkReportSyncTaskStatus = "pending" | "running" | "success" | "failed";

export interface WorkReportSyncTask {
  taskId: string;
  formId: string;
  status: WorkReportSyncTaskStatus;
  accepted: boolean;
  triggeredBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  scannedEntries: number;
  syncedEntries: number;
  syncedRows: number;
  snapshotAt?: string;
  message?: string;
  error?: {
    code?: string;
    message: string;
  };
}

export interface WorkReportSyncStateSnapshot {
  formId: string;
  status: "idle" | "running" | "success" | "failed";
  taskId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  snapshotAt: string | null;
  totalEntries: number;
  totalRows: number;
  message: string | null;
  updatedAt: string;
}

export type CreateReportTaskStatus = "pending" | "running" | "success" | "failed";

export interface CreateReportTaskAcceptedResult {
  taskId: string;
  status: CreateReportTaskStatus;
  createdAt: string;
  rowId?: string;
}

export interface CreateReportTaskResult {
  taskId: string;
  taskType?: "create-report" | "update-report";
  formId: string;
  entryId: string;
  queueKey: string;
  status: CreateReportTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: ReportMutationResult;
  error?: {
    code?: string;
    message: string;
  };
}

export type WorkReportQueueTaskType =
  | "create-report"
  | "update-report"
  | "create-report-batch"
  | "delete-report"
  | "delete-report-batch"
  | "sync"
  | "callback-refresh";

export type WorkReportQueueTaskStatus = "pending" | "running" | "success" | "failed";

export interface WorkReportQueueTask {
  taskId: string;
  taskType: WorkReportQueueTaskType;
  status: WorkReportQueueTaskStatus;
  formId: string;
  workOrderNo: string | null;
  entryId: string | null;
  rowId: string | null;
  queueKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  message: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  actorClientId: string | null;
  actorTabId: string | null;
  actorIp: string | null;
  actorLabel: string | null;
  /** 系統事件來源（e.g. ragic-callback-16、ragic-form-save）；跟 actorLabel 分流 */
  source: string | null;
  batchCreatedRowIds?: string[] | null;
  batchFinalizeFailed?: boolean | null;
  batchWriteIndeterminate?: boolean | null;
  retriedFromTaskId?: string | null;
}

export interface ReportMutationPayload {
  date: string;
  plannedIdle?: string;
  reportType?: string;
  processCode?: string;
  inputOptions?: string;
  shiftType?: string;
  machineId: string;
  operatorId: string;
  operatorName?: string;
  startTime: string;
  endTime: string;
  breakTime?: string;
  productionQty?: number;
  remark?: string;
  setupAdjustType?: string;
  setupAdjustMinutes?: number;
  countSetupTimeFlag?: string;
  setupTimeStandardHours?: number;
  setupLossQtyPerPcs?: number;
  processLossQtyPerPcs?: number;
  totalContainerQty?: number;
  containerUnit?: string;
  plannedIdleMinutes?: number;
  unplannedIdleMinutes?: number;
  absentOrTrainingMinutes?: number;
  noMaterialMinutes?: number;
  waitingQcApprovalMinutes?: number;
  meetingMinutes?: number;
  cleaningMinutes?: number;
  rdSamplingMinutes?: number;
  supportOtherMachinesMinutes?: number;
  machineBreakdownMinutes?: number;
  machineAdjustmentMinutes?: number;
  othersMinutes?: number;
  waitingForDiesMinutes?: number;
  testingDiesMinutes?: number;
}

export interface BatchDeleteTaskAcceptedResult {
  taskId: string;
  status: WorkReportQueueTaskStatus;
  createdAt: string;
  requestedCount?: number;
}

export type DeleteReportTaskAcceptedResult = BatchDeleteTaskAcceptedResult;

export interface BatchCreateTaskAcceptedResult {
  taskId: string;
  status: WorkReportQueueTaskStatus;
  createdAt: string;
  requestedCount?: number;
}

export interface BatchCreateRowRequest {
  payload: ReportMutationPayload;
  /** 前端產生的 UUID，後端用於 idempotency 映射（可省略，向後相容） */
  clientRowKey?: string;
}
