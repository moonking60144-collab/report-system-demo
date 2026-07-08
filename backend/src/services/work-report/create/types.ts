export type CreateTimingStage =
  | "preflight"
  | "normalize"
  | "beforeRead"
  | "contextRead"
  | "write"
  | "verifyWrite"
  | "polling"
  | "patch"
  | "actionButton"
  | "recalculateVerify"
  | "fallback";

export type CreateTimingMap = Record<CreateTimingStage, number>;

export interface CreateRecalculateActionTarget {
  source: "form16-row" | "form-entry";
  formPath: string;
  targetEntryId: string;
  buttonId: string;
}

export interface CreateRecalculateVerifyResult {
  completed: boolean;
  attempts: number;
  lastCheck: {
    needsRecalculate: boolean;
    missingFields: string[];
    checkedFields: string[];
    formulaGaps: string[];
  };
}
