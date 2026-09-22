import type { ActivityLogDowntimeRecord } from "../../types/activityLogDowntime";
import { normalizeDateOnly } from "../../utils/dateOnly";
import { HttpError } from "../../utils/httpError";
import type { UpdateActivityLogDowntimeInput } from "./activityLogDowntimeService";

const labels = {
  date: "日期", machineId: "機台", processCode: "製程",
  operatorId: "操作者", plannedIdleMinutes: "停機分鐘", remark: "備註",
} as const;
type Field = keyof typeof labels;
export type ActivityLogExpectedValues = Partial<Pick<ActivityLogDowntimeRecord, Field>>;

function comparable(key: Field, value: unknown): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  if (key === "date") return normalizeDateOnly(value) ?? String(value).trim();
  if (key === "plannedIdleMinutes") return Number(value);
  return String(value).trim() || null;
}

export function parseActivityLogFieldPrecondition(
  input: { fieldPreconditionVersion?: unknown; expectedValues?: unknown },
  patch: UpdateActivityLogDowntimeInput
): ActivityLogExpectedValues | undefined {
  if (input.fieldPreconditionVersion === undefined && input.expectedValues === undefined) return undefined;
  const expected = input.expectedValues;
  const keys = Object.keys(patch).filter((key) => patch[key as Field] !== undefined);
  if (input.fieldPreconditionVersion !== 1 || !expected || typeof expected !== "object" ||
      Array.isArray(expected) || keys.length === 0 || Object.keys(expected).length !== keys.length) {
    throw new HttpError(400, "缺少停機紀錄修改前的欄位值", "INVALID_PAYLOAD");
  }
  for (const key of keys) {
    const value = (expected as Record<string, unknown>)[key];
    const valid = key === "plannedIdleMinutes"
      ? value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0)
      : value === null || typeof value === "string";
    if (!Object.hasOwn(labels, key) || !Object.hasOwn(expected, key) || !valid) {
      throw new HttpError(400, `停機紀錄 ${key} 的原值格式錯誤`, "INVALID_PAYLOAD");
    }
  }
  return expected as ActivityLogExpectedValues;
}

export function resolveActivityLogFieldPatch(
  current: ActivityLogDowntimeRecord,
  patch: UpdateActivityLogDowntimeInput,
  expected: ActivityLogExpectedValues
): UpdateActivityLogDowntimeInput {
  const pending: UpdateActivityLogDowntimeInput = { ...patch };
  for (const key of Object.keys(expected) as Field[]) {
    const observed = comparable(key, current[key]);
    if (Object.is(observed, comparable(key, patch[key]))) {
      delete pending[key];
    } else if (!Object.is(observed, comparable(key, expected[key]))) {
      throw new HttpError(409, `停機紀錄的${labels[key]}已被修改，請重新整理後確認。`, "DOWNTIME_RECORD_STALE");
    }
  }
  return pending;
}
