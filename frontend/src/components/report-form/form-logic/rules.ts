import type { FormState, InputOptionDefaultRule } from "../types";
import { normalizeShiftTypeValue } from "./inference";

export function applyInputOptionRule(
  state: FormState,
  rule: InputOptionDefaultRule | undefined
): FormState {
  if (!rule) {
    return state;
  }

  const next = { ...state };
  if (rule.shiftType) {
    next.shiftType = normalizeShiftTypeValue(rule.shiftType);
  }
  if (rule.startTime !== undefined) {
    next.startTime = rule.startTime;
  }
  if (rule.endTime !== undefined) {
    next.endTime = rule.endTime;
  }
  if (rule.breakTime !== undefined) {
    next.breakTime = rule.breakTime;
  }
  if (rule.plannedIdleMinutes !== undefined) {
    next.plannedIdleMinutes = rule.plannedIdleMinutes;
  }
  return next;
}
