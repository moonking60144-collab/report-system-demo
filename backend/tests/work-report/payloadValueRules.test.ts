import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../src/utils/httpError";
import {
  INPUT_OPTION_DEFAULT_RULES,
  SHIFT_TYPE_ALLOWED_VALUES,
  normalizeBreakTimeValue,
  normalizeHourMinuteInput,
  normalizeInputOptionsValue,
  normalizeShiftTypeValue,
} from "../../src/services/work-report/create/payloadValueRules";

test("normalizeInputOptionsValue 與 normalizeShiftTypeValue alias 正規化", () => {
  assert.equal(normalizeInputOptionsValue(" 整天 "), "整天");
  assert.equal(normalizeInputOptionsValue(null), "");
  assert.equal(normalizeShiftTypeValue("正常班"), "正常班Reg");
  assert.equal(normalizeShiftTypeValue("OT"), "加班OT");
  assert.equal(normalizeShiftTypeValue("未知班別"), "未知班別");
});

test("normalizeHourMinuteInput 會轉成 HH:mm:ss", () => {
  assert.equal(normalizeHourMinuteInput("8:05", "startTime"), "08:05:00");
  assert.equal(normalizeHourMinuteInput("下午 1:30", "endTime"), "13:30:00");
});

test("normalizeHourMinuteInput 非法值會丟 HttpError", () => {
  assert.throws(
    () => normalizeHourMinuteInput("99:99", "startTime"),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_PAYLOAD"
  );
});

test("normalizeBreakTimeValue 預設值與防呆", () => {
  assert.deepEqual(normalizeBreakTimeValue(undefined), { value: "0", source: "default-zero" });
  assert.deepEqual(normalizeBreakTimeValue(" 1.5 ", "payload"), { value: "1.5", source: "payload" });
  assert.throws(
    () => normalizeBreakTimeValue("-1"),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_PAYLOAD"
  );
});

test("規則常數仍可用（避免重構時意外刪除）", () => {
  assert.equal(INPUT_OPTION_DEFAULT_RULES["整天"].shiftType, "正常班Reg");
  assert.equal(SHIFT_TYPE_ALLOWED_VALUES.has("加班OT"), true);
});
