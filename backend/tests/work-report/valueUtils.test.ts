import test from "node:test";
import assert from "node:assert/strict";
import {
  isEmptyValue,
  normalizeComparableValue,
  parseHourMinuteValue,
  parseNumericValue,
} from "../../src/services/work-report/shared/valueUtils";

test("isEmptyValue 與 normalizeComparableValue 基本行為", () => {
  assert.equal(isEmptyValue(undefined), true);
  assert.equal(isEmptyValue(null), true);
  assert.equal(isEmptyValue("   "), true);
  assert.equal(isEmptyValue("0"), false);
  assert.equal(normalizeComparableValue(undefined), "");
  assert.equal(normalizeComparableValue("  A1  "), "A1");
});

test("parseHourMinuteValue 支援 HH:mm / HH:mm:ss / ampm / 上午下午", () => {
  assert.equal(parseHourMinuteValue("08:30"), 8 * 60 + 30);
  assert.equal(parseHourMinuteValue("08:30:45"), 8 * 60 + 30);
  assert.equal(parseHourMinuteValue("pm 1:05"), 13 * 60 + 5);
  assert.equal(parseHourMinuteValue("1:05 pm"), 13 * 60 + 5);
  assert.equal(parseHourMinuteValue("上午 9:15"), 9 * 60 + 15);
  assert.equal(parseHourMinuteValue("下午 1:15"), 13 * 60 + 15);
});

test("parseHourMinuteValue 遇到非法格式回 null", () => {
  assert.equal(parseHourMinuteValue("25:00"), null);
  assert.equal(parseHourMinuteValue("09:61"), null);
  assert.equal(parseHourMinuteValue("abc"), null);
  assert.equal(parseHourMinuteValue("13:00 pm"), null);
});

test("parseNumericValue 基本行為", () => {
  assert.equal(parseNumericValue(undefined), null);
  assert.equal(parseNumericValue(""), null);
  assert.equal(parseNumericValue(" 12.5 "), 12.5);
  assert.equal(parseNumericValue("-3"), -3);
  assert.equal(parseNumericValue("abc"), null);
});
