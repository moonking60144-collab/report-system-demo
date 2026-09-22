import { HttpError } from "../../../utils/httpError";
import { parseHourMinuteValue } from "../shared/valueUtils";

export interface InputOptionDefaultRule {
  shiftType: string;
  startTime?: string;
  endTime?: string;
  breakTime?: string;
}

export const INPUT_OPTION_DEFAULT_RULES: Record<string, InputOptionDefaultRule> = {
  "整天": {
    shiftType: "正常班Reg",
    startTime: "08:00",
    endTime: "17:00",
    breakTime: "1.00",
  },
  "上午12:00": { shiftType: "正常班Reg" },
  "下午13:00": { shiftType: "正常班Reg" },
  "無人12:00": {
    shiftType: "無人生產班Unmanned",
    startTime: "12:00",
    endTime: "13:00",
    breakTime: "0.00",
  },
  "無人17:00": {
    shiftType: "無人生產班Unmanned",
    startTime: "17:00",
    endTime: "17:30",
    breakTime: "0.00",
  },
  "加班2H": {
    shiftType: "加班OT",
    startTime: "17:30",
    endTime: "19:30",
    breakTime: "0.00",
  },
  "加班3.5H": {
    shiftType: "加班OT",
    startTime: "17:30",
    endTime: "21:00",
    breakTime: "0.00",
  },
};

export const SHIFT_TYPE_ALIAS_TO_CANONICAL: Record<string, string> = {
  "正常班Reg": "正常班Reg",
  正常班: "正常班Reg",
  Reg: "正常班Reg",
  "加班OT": "加班OT",
  OT: "加班OT",
  加班: "加班OT",
  "無人生產班Unmanned": "無人生產班Unmanned",
  "無人生產班 Unmanned": "無人生產班Unmanned",
  無人生產班: "無人生產班Unmanned",
  Unmanned: "無人生產班Unmanned",
  "休息日加班SAT-OT": "休息日加班SAT-OT",
  "休息日加班 SAT-OT": "休息日加班SAT-OT",
  "SAT-OT": "休息日加班SAT-OT",
  換線清機改車: "換線/清機/改車",
  "換線/清機/改車": "換線/清機/改車",
  參數設定: "參數設定",
  "調機(參數調整)": "調機(參數調整)",
};

export const SHIFT_TYPE_ALLOWED_VALUES = new Set<string>([
  "正常班Reg",
  "加班OT",
  "無人生產班Unmanned",
  "休息日加班SAT-OT",
  "換線/清機/改車",
  "參數設定",
  "調機(參數調整)",
]);

export interface NormalizeBreakTimeResult {
  value: string;
  source: "default-zero" | "payload" | "input-options-rule";
}

export function normalizeInputOptionsValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

export function normalizeShiftTypeValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return "";
  }
  return SHIFT_TYPE_ALIAS_TO_CANONICAL[normalized] ?? normalized;
}

export function normalizeHourMinuteInput(value: unknown, fieldName: string): string {
  if (value === undefined || value === null) {
    throw new HttpError(400, `缺少必填欄位：${fieldName}`, "INVALID_PAYLOAD");
  }
  const normalized = String(value).trim();
  if (!normalized) {
    throw new HttpError(400, `缺少必填欄位：${fieldName}`, "INVALID_PAYLOAD");
  }
  const minutes = parseHourMinuteValue(normalized);
  if (minutes === null) {
    throw new HttpError(
      400,
      `${fieldName} 時間格式無效，請使用 HH:mm 或 上午/下午 HH:mm`,
      "INVALID_PAYLOAD"
    );
  }
  const hour = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const minute = (minutes % 60).toString().padStart(2, "0");
  return `${hour}:${minute}:00`;
}

export function normalizeBreakTimeValue(
  value: unknown,
  sourceHint: NormalizeBreakTimeResult["source"] = "payload"
): NormalizeBreakTimeResult {
  if (value === undefined || value === null) {
    return { value: "0", source: "default-zero" };
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return { value: "0", source: "default-zero" };
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new HttpError(400, "休息時間需為 0 以上數字", "INVALID_PAYLOAD");
  }

  return { value: String(parsed), source: sourceHint };
}
