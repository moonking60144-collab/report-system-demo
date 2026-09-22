// 舊檔保留為 re-export 入口；新邏輯請直接 import from
// "./weekRotation" 或 "./dayResolver"。
export {
  calculateDutyForWeek,
  type RotationLookupResult,
  type RotationOptions,
} from "./weekRotation";
export {
  calculateDutyForDay,
  findNextDutyDateForMember,
  type DayDutyResult,
} from "./dayResolver";
