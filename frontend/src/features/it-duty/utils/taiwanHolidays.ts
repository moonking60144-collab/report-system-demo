import dayjs from "dayjs";

import { TAIWAN_HOLIDAYS_BY_YEAR } from "./taiwanHolidayData";

export interface TaiwanHoliday {
  date: string; // 'YYYY-MM-DD'
  name: string;
}

// 按年快取，避免月曆與值班表重複切片同一份資料。
const yearCache = new Map<number, TaiwanHoliday[]>();

/**
 * 抓指定年份內的台灣國定假日（給 IT 內部值班表用，"見紅休"語意）。
 * 目前快照範圍：2020-2040。超出範圍時回傳空陣列。
 */
export function getTaiwanHolidaysInYear(year: number): TaiwanHoliday[] {
  const cached = yearCache.get(year);
  if (cached) return cached;
  const holidays = TAIWAN_HOLIDAYS_BY_YEAR[year] ?? [];
  const result = holidays.map((holiday) => ({ ...holiday }));
  yearCache.set(year, result);
  return result;
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
  const targetDate = dayjs(date);
  if (!targetDate.isValid()) return null;
  const target = targetDate.format("YYYY-MM-DD");
  const list = getTaiwanHolidaysInYear(targetDate.year());
  return list.find((h) => h.date === target) ?? null;
}
