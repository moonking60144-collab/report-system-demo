import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  FormOptionItem,
  WorkReportRecord,
} from "../../../../api/workReport";
import type { FormState } from "../../../../components/report-form/types";
import type { InlineEditableDetailKey } from "./types";

export function isInlineFieldEmpty(
  key: InlineEditableDetailKey,
  state: FormState
): boolean {
  const value = state[key];
  return String(value ?? "").trim() === "";
}

export function resolveExpectedEntryLastUpdatedAt(
  record: WorkReportRecord | null
): string | undefined {
  const value = String(record?.lastUpdatedAt ?? "").trim();
  return value || undefined;
}

export function isInlineElementFocusable(el: HTMLElement): boolean {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLButtonElement
  ) {
    if (el.disabled) {
      return false;
    }
    if (
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
      el.readOnly
    ) {
      return false;
    }
  }
  return true;
}

export function resolveInlineEditorTarget(
  target: EventTarget | null
): {
  element: HTMLElement;
  key: InlineEditableDetailKey;
} | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  const inlineRoot = target.closest<HTMLElement>("[data-inline-editor-key]");
  if (!inlineRoot) {
    return null;
  }
  const key = inlineRoot.getAttribute(
    "data-inline-editor-key"
  ) as InlineEditableDetailKey | null;
  if (!key) {
    return null;
  }
  return {
    element: inlineRoot,
    key,
  };
}

export function shouldHandleHorizontalArrow(
  event: ReactKeyboardEvent,
  target: HTMLElement
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement) {
    return false;
  }
  if (target instanceof HTMLButtonElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (!(target instanceof HTMLInputElement)) {
    return false;
  }
  const inputType = String(target.type ?? "").toLowerCase();
  if (inputType === "checkbox" || inputType === "radio") {
    return true;
  }
  const rawValue = String(target.value ?? "");
  const selectionStart =
    typeof target.selectionStart === "number" ? target.selectionStart : null;
  const selectionEnd =
    typeof target.selectionEnd === "number" ? target.selectionEnd : null;
  if (selectionStart === null || selectionEnd === null) {
    return true;
  }
  if (event.key === "ArrowLeft") {
    return selectionStart === 0 && selectionEnd === 0;
  }
  if (event.key === "ArrowRight") {
    return (
      selectionStart === rawValue.length && selectionEnd === rawValue.length
    );
  }
  return false;
}

export function findOptionByValue(
  options: FormOptionItem[],
  value: string
): FormOptionItem | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return options.find((item) => item.value.trim() === normalized);
}

export const INLINE_EDITABLE_DETAIL_KEYS_BY_FORM: Record<
  "104" | "105",
  readonly InlineEditableDetailKey[]
> = {
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
