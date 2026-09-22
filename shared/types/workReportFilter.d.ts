export type WorkReportFilterJoinMode = "all" | "any";

export type WorkReportFilterField =
  | "workOrderNo"
  | "customerPartNo"
  | "machineCode"
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
  | "between";

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
