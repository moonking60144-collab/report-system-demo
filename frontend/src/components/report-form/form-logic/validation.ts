import { REASON_MINUTE_FIELD_DEFS, SHIFT_TYPE_ALLOWED_VALUES } from "../constants";
import type { FormState, TranslateFunction } from "../types";
import { normalizeShiftTypeValue } from "./inference";

const SETUP_NUMERIC_FIELD_LABELS: ReadonlyArray<{
  key:
    | "setupAdjustMinutes"
    | "setupTimeStandardHours"
    | "setupLossQtyPerPcs"
    | "processLossQtyPerPcs"
    | "totalContainerQty";
  i18nKey: string;
}> = [
  { key: "setupAdjustMinutes", i18nKey: "workReport:reportForm.setupSection.fields.setupAdjustMinutes" },
  { key: "setupTimeStandardHours", i18nKey: "workReport:reportForm.setupSection.fields.setupTimeStandardHours" },
  { key: "setupLossQtyPerPcs", i18nKey: "workReport:reportForm.setupSection.fields.setupLossQtyPerPcs" },
  { key: "processLossQtyPerPcs", i18nKey: "workReport:reportForm.setupSection.fields.processLossQtyPerPcs" },
  { key: "totalContainerQty", i18nKey: "workReport:reportForm.setupSection.fields.totalContainerQty" },
];

const REQUIRED_FIELD_LABEL_KEYS: Readonly<Partial<Record<keyof FormState, string>>> = {
  date: "workReport:reportForm.fields.dateRequired",
  machineId: "workReport:reportForm.fields.machineRequired",
  operatorId: "workReport:reportForm.fields.operatorIdRequired",
  startTime: "workReport:reportForm.fields.startTimeRequired",
  endTime: "workReport:reportForm.fields.endTimeRequired",
  productionQty: "workReport:reportForm.fields.productionQtyRequired",
};

function parseMaskedTime(value: string): number | null {
  const normalized = value.trim();
  const matched = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (!matched) {
    return null;
  }

  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

export function validate(state: FormState, tr: TranslateFunction): string | null {
  const isPlannedIdleYes = state.plannedIdle.trim() === "Yes";
  const requiredFields: Array<keyof FormState> = [
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
    if (!state[field].trim()) {
      const fieldLabel = REQUIRED_FIELD_LABEL_KEYS[field]
        ? tr(REQUIRED_FIELD_LABEL_KEYS[field] as string)
        : field;
      return tr("workReport:reportForm.validation.requiredField", { field: fieldLabel });
    }
  }

  const start = state.startTime.trim();
  const end = state.endTime.trim();
  const startMinutes = parseMaskedTime(start);
  const endMinutes = parseMaskedTime(end);
  if (start && startMinutes === null) {
    return tr("workReport:reportForm.validation.invalidTime", {
      field: tr("workReport:reportForm.fields.startTimeRequired"),
    });
  }
  if (end && endMinutes === null) {
    return tr("workReport:reportForm.validation.invalidTime", {
      field: tr("workReport:reportForm.fields.endTimeRequired"),
    });
  }
  if (
    startMinutes !== null &&
    endMinutes !== null &&
    startMinutes > endMinutes
  ) {
    return tr("workReport:reportForm.validation.startLaterThanEnd");
  }

  const productionQty = Number(state.productionQty);
  if (!Number.isFinite(productionQty) || productionQty < 0) {
    return tr("workReport:reportForm.validation.invalidProductionQty");
  }

  if (state.breakTime.trim()) {
    const breakTime = Number(state.breakTime);
    if (!Number.isFinite(breakTime) || breakTime < 0) {
      return tr("workReport:reportForm.validation.invalidBreakTime");
    }
  }

  for (const field of SETUP_NUMERIC_FIELD_LABELS) {
    const raw = state[field.key];
    if (!raw.trim()) {
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return tr("workReport:reportForm.validation.invalidReasonMinute", {
        field: tr(field.i18nKey),
      });
    }
  }

  for (const reasonField of REASON_MINUTE_FIELD_DEFS) {
    const raw = state[reasonField.key];
    if (!raw.trim()) {
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return tr("workReport:reportForm.validation.invalidReasonMinute", {
        field: tr(reasonField.i18nKey),
      });
    }
  }

  const normalizedShiftType = normalizeShiftTypeValue(state.shiftType);
  if (normalizedShiftType && !SHIFT_TYPE_ALLOWED_VALUES.has(normalizedShiftType)) {
    return tr("workReport:reportForm.validation.invalidShiftType");
  }

  return null;
}
