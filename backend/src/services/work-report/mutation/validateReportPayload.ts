import { ReportWritePayload } from "../../../types/workReport";
import { HttpError } from "../../../utils/httpError";
import {
  INPUT_OPTION_DEFAULT_RULES,
  normalizeInputOptionsValue,
} from "../create/payloadValueRules";
import { isEmptyValue } from "../shared/valueUtils";

export function validateReportPayload(
  payload: ReportWritePayload,
  requiredFields: string[]
): void {
  const normalizedInputOptions = normalizeInputOptionsValue(payload.inputOptions);
  const inputOptionRule = normalizedInputOptions
    ? INPUT_OPTION_DEFAULT_RULES[normalizedInputOptions]
    : undefined;
  const isPlannedIdleYes = String(payload.plannedIdle ?? "").trim() === "Yes";

  for (const requiredField of requiredFields) {
    if (isPlannedIdleYes && requiredField === "productionQty") {
      continue;
    }
    const value = payload[requiredField];
    if (
      inputOptionRule &&
      (requiredField === "startTime" || requiredField === "endTime") &&
      isEmptyValue(value)
    ) {
      const fallbackValue = requiredField === "startTime"
        ? inputOptionRule.startTime
        : inputOptionRule.endTime;
      if (!isEmptyValue(fallbackValue)) {
        continue;
      }
    }
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new HttpError(400, `缺少必填欄位：${requiredField}`, "INVALID_PAYLOAD");
    }
  }
}
