import Holidays from "date-holidays";
import dayjs from "dayjs";

export interface TaiwanHoliday {
  date: string; // 'YYYY-MM-DD'
  name: string;
}

let holidaysInstance: Holidays | null = null;

function getHolidaysInstance(): Holidays {
  if (!holidaysInstance) {
    holidaysInstance = new Holidays("TW");
  }
  return holidaysInstance;
}

function toDateOnly(input: Date | string | number): string {
  return dayjs(input).format("YYYY-MM-DD");
}

// date-holidays 的 TW 資料把 type='public' 視為「政府員工」假，所以 5/1 勞動節
// 被歸到 observance（公務員不放、勞工才放）。我們的使用者是私部門 IT，
// 補一個白名單從 observance 收回真實會放假的節日。
const OBSERVANCE_WHITELIST_NAMES = new Set<string>(["勞動節"]);

// date-holidays 來源資料部分 entry 是簡體字 / 異體字，這裡統一改成繁中正字。
const HOLIDAY_NAME_NORMALIZE: Record<string, string> = {
  "淸明節": "清明節",
  "淸明節 (更换日)": "清明節（補假）",
  "农历新年假期": "春節連假",
};

function normalizeHolidayName(raw: string): string {
  return HOLIDAY_NAME_NORMALIZE[raw] ?? raw;
}

function shouldIncludeHoliday(type: string | undefined, name: string): boolean {
  if (type === "public") return true;
  if (type === "observance" && OBSERVANCE_WHITELIST_NAMES.has(name)) return true;
  return false;
}

/**
 * 抓指定年份內的台灣國定假日（給 IT 內部值班表用，"見紅休"語意）。
 * - 包含所有 type='public'（公部門/全民假日）
 * - 加上 observance 中明確會放假的節日（如勞動節）
 * - 排除民俗節氣（媽祖、佛誕、文藝節等）
 *
 * date-holidays 會回 lunar 換算後的西曆日期，農曆假日（春節等）已正確解析。
 */
export function getTaiwanHolidaysInYear(year: number): TaiwanHoliday[] {
  const hd = getHolidaysInstance();
  const raw = hd.getHolidays(year);
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const result: TaiwanHoliday[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: string }).type;
    const dateValue = (item as { date?: unknown }).date;
    if (typeof dateValue !== "string" && !(dateValue instanceof Date)) continue;
    const rawName = String((item as { name?: unknown }).name ?? "").trim();
    if (!rawName) continue;
    if (!shouldIncludeHoliday(type, rawName)) continue;
    const name = normalizeHolidayName(rawName);
    const dateOnly = toDateOnly(dateValue as string | Date);
    const dedupKey = `${dateOnly}|${name}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    result.push({ date: dateOnly, name });
  }
  return result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function getHolidaysInRange(
  start: dayjs.ConfigType,
  end: dayjs.ConfigType
): TaiwanHoliday[] {
  const startD = dayjs(start).startOf("day");
  const endD = dayjs(end).endOf("day");
  if (!startD.isValid() || !endD.isValid() || endD.isBefore(startD)) {
    return [];
  }
  const startYear = startD.year();
  const endYear = endD.year();
  const result: TaiwanHoliday[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    for (const h of getTaiwanHolidaysInYear(year)) {
      const d = dayjs(h.date);
      if (d.isValid() && !d.isBefore(startD) && !d.isAfter(endD)) {
        result.push(h);
      }
    }
  }
  return result;
}

export function isHoliday(date: dayjs.ConfigType): TaiwanHoliday | null {
  const target = toDateOnly(dayjs(date).toDate());
  const year = dayjs(date).year();
  const list = getTaiwanHolidaysInYear(year);
  return list.find((h) => h.date === target) ?? null;
}
