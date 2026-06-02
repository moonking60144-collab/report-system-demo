import { FormConfig } from "../../../types/formConfig";
import { ReportWritePayload } from "../../../types/workReport";
import { HttpError } from "../../../utils/httpError";
import {
  INPUT_OPTION_DEFAULT_RULES,
  NormalizeBreakTimeResult,
  normalizeBreakTimeValue,
  normalizeHourMinuteInput,
  normalizeInputOptionsValue,
  normalizeShiftTypeValue,
  SHIFT_TYPE_ALLOWED_VALUES,
} from "../create/payloadValueRules";
import { getOperatorOptionMap } from "../operator/operatorOptionCache";
import { logCreateOperatorDiagnostics } from "../shared/workReportDiagnostics";
import { isEmptyValue, parseNumericValue } from "../shared/valueUtils";

const REASON_MINUTE_FIELDS = [
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
] as const;

export async function normalizePayloadForWrite(
  formId: string,
  config: FormConfig,
  payload: ReportWritePayload
): Promise<ReportWritePayload> {
  const normalizedPayload: ReportWritePayload = { ...payload };
  const operatorId = String(payload.operatorId ?? "").trim();
  if (!operatorId) {
    throw new HttpError(400, "缺少必填欄位：operatorId", "INVALID_PAYLOAD");
  }

  let operatorMap = await getOperatorOptionMap(formId, config);
  if (!operatorMap.has(operatorId)) {
    operatorMap = await getOperatorOptionMap(formId, config, {
      forceRefresh: true,
    });
  }
  if (!operatorMap.has(operatorId)) {
    throw new HttpError(
      400,
      `操作者工號無效：${operatorId}，請從下拉選單重新選擇`,
      "INVALID_OPERATOR_ID"
    );
  }

  const operatorName = operatorMap.get(operatorId);
  if (!operatorName) {
    throw new HttpError(
      400,
      `操作者工號對應姓名缺失：${operatorId}`,
      "INVALID_OPERATOR_MAPPING"
    );
  }

  normalizedPayload.operatorId = operatorId;
  normalizedPayload.operatorName = operatorName;

  const normalizedInputOptions = normalizeInputOptionsValue(payload.inputOptions);
  const inputOptionRule = normalizedInputOptions
    ? INPUT_OPTION_DEFAULT_RULES[normalizedInputOptions]
    : undefined;
  const autoFilledFields: string[] = [];
  if (normalizedInputOptions) {
    normalizedPayload.inputOptions = normalizedInputOptions;
  }

  const startTimeInput =
    !isEmptyValue(payload.startTime) || isEmptyValue(inputOptionRule?.startTime)
      ? payload.startTime
      : inputOptionRule?.startTime;
  if (isEmptyValue(payload.startTime) && !isEmptyValue(inputOptionRule?.startTime)) {
    autoFilledFields.push("startTime");
  }
  normalizedPayload.startTime = normalizeHourMinuteInput(startTimeInput, "startTime");

  const endTimeInput =
    !isEmptyValue(payload.endTime) || isEmptyValue(inputOptionRule?.endTime)
      ? payload.endTime
      : inputOptionRule?.endTime;
  if (isEmptyValue(payload.endTime) && !isEmptyValue(inputOptionRule?.endTime)) {
    autoFilledFields.push("endTime");
  }
  normalizedPayload.endTime = normalizeHourMinuteInput(endTimeInput, "endTime");

  const normalizedShiftType = normalizeShiftTypeValue(payload.shiftType);
  if (normalizedShiftType && !SHIFT_TYPE_ALLOWED_VALUES.has(normalizedShiftType)) {
    throw new HttpError(
      400,
      `班別無效：${normalizedShiftType}，請從下拉選單重新選擇`,
      "INVALID_PAYLOAD"
    );
  }
  const resolvedShiftType = normalizedShiftType || inputOptionRule?.shiftType || "";
  if (resolvedShiftType) {
    normalizedPayload.shiftType = resolvedShiftType;
    if (!normalizedShiftType && inputOptionRule?.shiftType) {
      autoFilledFields.push("shiftType");
    }
  }

  const breakTimeInput =
    !isEmptyValue(payload.breakTime) || isEmptyValue(inputOptionRule?.breakTime)
      ? payload.breakTime
      : inputOptionRule?.breakTime;
  const breakTimeSource: NormalizeBreakTimeResult["source"] =
    isEmptyValue(payload.breakTime) && !isEmptyValue(inputOptionRule?.breakTime)
      ? "input-options-rule"
      : "payload";
  if (breakTimeSource === "input-options-rule") {
    autoFilledFields.push("breakTime");
  }
  const normalizedBreakTime = normalizeBreakTimeValue(breakTimeInput, breakTimeSource);
  normalizedPayload.breakTime = normalizedBreakTime.value;

  for (const reasonField of REASON_MINUTE_FIELDS) {
    if (!(reasonField in payload)) {
      continue;
    }

    const rawValue = payload[reasonField];
    if (isEmptyValue(rawValue)) {
      delete normalizedPayload[reasonField];
      continue;
    }

    const parsed = parseNumericValue(rawValue);
    if (parsed === null || parsed < 0) {
      throw new HttpError(400, `${reasonField} 需為 0 以上數字`, "INVALID_PAYLOAD");
    }
    normalizedPayload[reasonField] = String(parsed);
  }

  if (inputOptionRule && autoFilledFields.length > 0) {
    logCreateOperatorDiagnostics("rule-applied", {
      operatorId,
      inputOptions: normalizedInputOptions,
      autoFilledFields,
      shiftType: normalizedPayload.shiftType,
      startTime: normalizedPayload.startTime,
      endTime: normalizedPayload.endTime,
      breakTime: normalizedPayload.breakTime,
    });
  }

  logCreateOperatorDiagnostics("break-time-normalized", {
    operatorId,
    breakTime: normalizedBreakTime.value,
    source: normalizedBreakTime.source,
  });
  return normalizedPayload;
}
