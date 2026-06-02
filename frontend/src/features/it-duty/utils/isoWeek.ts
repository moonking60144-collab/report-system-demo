import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek";

dayjs.extend(isoWeek);

// 對齊 backend route 的 ISO_WEEK_REGEX：YYYY-Www，週數 01..53
export const ISO_WEEK_REGEX = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

export interface IsoWeekRange {
  isoWeek: string;
  start: dayjs.Dayjs; // ISO 週的週一 00:00
  end: dayjs.Dayjs; // ISO 週的週日 23:59:59.999
}

export function formatIsoWeek(date: dayjs.ConfigType): string {
  const d = dayjs(date);
  const year = d.isoWeekYear();
  const week = d.isoWeek();
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function parseIsoWeek(isoWeekStr: string): IsoWeekRange {
  if (!ISO_WEEK_REGEX.test(isoWeekStr)) {
    throw new Error(`Invalid ISO week format: ${isoWeekStr}`);
  }
  const yearStr = isoWeekStr.slice(0, 4);
  const weekStr = isoWeekStr.slice(6);
  const year = Number(yearStr);
  const week = Number(weekStr);
  // 用 Jan 4 當基準日（ISO 標準裡 Jan 4 永遠在該年的 W01），再 .isoWeek(week) 跳到目標週
  const base = dayjs(`${year}-01-04`);
  const start = base.isoWeek(week).startOf("isoWeek");
  const end = start.endOf("isoWeek");
  return { isoWeek: isoWeekStr, start, end };
}

export function currentIsoWeek(now: dayjs.ConfigType = dayjs()): string {
  return formatIsoWeek(now);
}

export function shiftIsoWeek(isoWeekStr: string, deltaWeeks: number): string {
  const { start } = parseIsoWeek(isoWeekStr);
  return formatIsoWeek(start.add(deltaWeeks, "week"));
}

export function isoWeekDiff(later: string, earlier: string): number {
  const a = parseIsoWeek(later).start;
  const b = parseIsoWeek(earlier).start;
  // 用 day 差除以 7 取整，避開 dayjs.diff('week') 的小數誤差
  const days = a.diff(b, "day");
  return Math.round(days / 7);
}

export function buildIsoWeekRange(
  centerIsoWeek: string,
  pastWeeks: number,
  futureWeeks: number
): string[] {
  const result: string[] = [];
  for (let delta = -pastWeeks; delta <= futureWeeks; delta += 1) {
    result.push(shiftIsoWeek(centerIsoWeek, delta));
  }
  return result;
}
