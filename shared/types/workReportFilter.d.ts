export type WorkReportFilterJoinMode = "all" | "any";

export type WorkReportFilterField =
  | "workOrderNo"
  | "customerPartNo"
  | "machineCode"
  | "modificationStatus"
  | "previousMachine"
  | "forgingMother"
  | "urgent"
  | "sortOrder"
  | "size"
  | "plannedStartDate"
  | "plannedEndDate"
  | "estimatedHours"
  | "prevPlanEndDate"
  | "targetQtyPc"
  | "pendingQty"
  | "producedQtyStat"
  | "prevReportQtyPc"
  | "prevReportQtyKg"
  | "prevReportContainerQty"
  | "processName"
  | "workOrderType"
  | "currentMaterial"
  | "completedQty"
  | "processLossPc"
  | "finishedWireSize"
  | "sourceCloseStatus"
  | "workOrderRemark"
  | "productUsageType"
  | "moldCondition"
  | "createdBy"
  | "primaryMaterial"
  | "defaultMainMaterial"
  | "prevStationRunning"
  | "prevStationStatus"
  | "prevCompletePc"
  | "prevCompleteKg"
  | "prevCompleteContainer"
  | "status"
  | "siteRunning"
  | "startSchedule"
  | "lastUpdatedAt";

export type WorkReportFilterOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "startsWith"
  | "isAnyOf"
  | "isNotAnyOf"
  | "isEmpty"
  | "isNotEmpty"
  | "before"
  | "after"
  | "between"
  | "greaterThan"
  | "lessThan"
  | "atLeast"
  | "atMost";

export interface WorkReportFilterCondition {
  id: string;
  field: WorkReportFilterField;
  operator: WorkReportFilterOperator;
  values: string[];
}

export interface WorkReportFilterGroup {
  joinMode: WorkReportFilterJoinMode;
  conditions: WorkReportFilterCondition[];
}
