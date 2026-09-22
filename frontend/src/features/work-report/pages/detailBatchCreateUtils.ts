import type { FormState } from "../../../components/report-form/types";
import type {
  DetailTableRow,
  InlineEditableDetailKey,
} from "../hooks/detail/types";

export const INLINE_CREATE_PLACEHOLDER_COUNT = 3;
export const INLINE_CREATE_TRAILING_PLACEHOLDER_COUNT = 3;
export const INLINE_CREATE_PLACEHOLDER_ROW_PREFIX = "__inline-create__";

export const BATCH_CREATE_FILLABLE_KEYS = new Set<InlineEditableDetailKey>([
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

export type BatchCreateFieldErrorMap = Partial<
  Record<InlineEditableDetailKey, string>
>;

export type BatchCreateFillDragState = {
  sourceRowId: string;
  sourceKey: InlineEditableDetailKey;
  endKey: InlineEditableDetailKey;
  startIndex: number;
  endIndex: number;
};

export function resolveBatchCreateFillKeys(
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

export function parseInlineCreatePlaceholderIndex(rowId: string): number | null {
  const matched = rowId.match(/^__inline-create__:(\d+)$/);
  if (!matched) {
    return null;
  }
  const parsed = Number(matched[1]);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function isMeaningfulBatchCreateDraft(state: FormState): boolean {
  return Object.values(state).some(
    (value) => String(value ?? "").trim().length > 0
  );
}

export function buildBatchCreateFieldErrors(
  state: FormState,
  t: (key: string, options?: Record<string, unknown>) => string
): BatchCreateFieldErrorMap {
  const errors: BatchCreateFieldErrorMap = {};
  const isPlannedIdleYes = state.plannedIdle.trim() === "Yes";
  const requiredFields: InlineEditableDetailKey[] = [
    "date",
    "processCode",
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
      errors[field] = t("workReport:reportForm.validation.requiredField", {
        field,
      });
    }
  }

  if (state.startTime.trim() && !/^\d{2}:\d{2}$/.test(state.startTime.trim())) {
    errors.startTime = t("workReport:reportForm.validation.invalidTime", {
      field: "startTime",
    });
  }
  if (state.endTime.trim() && !/^\d{2}:\d{2}$/.test(state.endTime.trim())) {
    errors.endTime = t("workReport:reportForm.validation.invalidTime", {
      field: "endTime",
    });
  }
  if (state.productionQty.trim()) {
    const productionQty = Number(state.productionQty);
    if (!Number.isFinite(productionQty) || productionQty < 0) {
      errors.productionQty = t(
        "workReport:reportForm.validation.invalidProductionQty"
      );
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

export function isCreatePlaceholderRow(row: DetailTableRow): boolean {
  return row.__placeholder === true;
}

export function buildCreatePlaceholderRow(index: number): DetailTableRow {
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
