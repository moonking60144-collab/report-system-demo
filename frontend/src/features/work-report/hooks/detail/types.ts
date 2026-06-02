import type { WorkReportItem } from "../../../../api/workReport";

export interface DetailModalState {
  open: boolean;
  mode: "create" | "edit";
  row: WorkReportItem | null;
}

export type InlineEditableDetailKey =
  | "date"
  | "plannedIdle"
  | "machineId"
  | "operatorId"
  | "processCode"
  | "inputOptions"
  | "shiftType"
  | "startTime"
  | "endTime"
  | "breakTime"
  | "productionQty"
  | "remark"
  | "setupAdjustType"
  | "setupAdjustMinutes"
  | "countSetupTimeFlag"
  | "setupTimeStandardHours"
  | "setupLossQtyPerPcs"
  | "processLossQtyPerPcs"
  | "totalContainerQty"
  | "containerUnit"
  | "plannedIdleMinutes"
  | "unplannedIdleMinutes"
  | "absentOrTrainingMinutes"
  | "noMaterialMinutes"
  | "waitingQcApprovalMinutes"
  | "meetingMinutes"
  | "cleaningMinutes"
  | "rdSamplingMinutes"
  | "supportOtherMachinesMinutes"
  | "machineBreakdownMinutes"
  | "machineAdjustmentMinutes"
  | "othersMinutes"
  | "waitingForDiesMinutes"
  | "testingDiesMinutes";

export type LinkedPickerFieldKey =
  | "machineId"
  | "operatorId"
  | "processCode"
  | "inputOptions"
  | "shiftType";

export interface LinkedPickerState {
  key: LinkedPickerFieldKey;
  rowId: string;
  search: string;
}

export interface LoadEntryOptions {
  silent?: boolean;
  forceRefresh?: boolean;
}

export type DetailTableRow = WorkReportItem & {
  __placeholder?: true;
};
