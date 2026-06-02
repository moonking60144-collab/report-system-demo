import dayjs from "dayjs";
import type {
  ItDutyDaySwap,
  ItDutyMember,
  ItDutyOverride,
} from "../../../api/itDuty";
import { formatIsoWeek } from "./isoWeek";
import {
  calculateDutyForWeek,
  type RotationLookupResult,
  type RotationOptions,
} from "./weekRotation";

export interface DayDutyResult {
  /** 實際當天值班人 (考慮 day swap 後)。可能跟 baseMember 不同 */
  member: ItDutyMember | null;
  /** 該週原本輪到誰（沒 swap 時就是這位）*/
  baseMember: ItDutyMember | null;
  /** 該天的 swap，若有 */
  swap: ItDutyDaySwap | null;
  /** baseMember 的 source（override / auto / empty）跟 appliedOverride */
  baseSource: RotationLookupResult["source"];
  baseAppliedOverride: ItDutyOverride | null;
}

/**
 * 算一天「真正的」值班人：
 * 1. 算該週 base member（呼叫 calculateDutyForWeek）
 * 2. 若該天有 swap → 用 swap.coverMember 取代 base
 *
 * 注意：swap 紀錄是「過去事實的快照」，即使後續 override 改變了 baseMember，
 * 該天 swap 仍以紀錄的 cover_member 為準（但 baseMember 反映「現在算」的）。
 */
export function calculateDutyForDay(
  date: dayjs.ConfigType,
  members: ItDutyMember[],
  overrides: ItDutyOverride[],
  daySwaps: ItDutyDaySwap[],
  options: RotationOptions = {}
): DayDutyResult {
  const target = dayjs(date);
  const isoWeek = formatIsoWeek(target);
  const weekResult = calculateDutyForWeek(isoWeek, members, overrides, options);
  const dateKey = target.format("YYYY-MM-DD");
  const swap = daySwaps.find((s) => s.coverDate === dateKey) ?? null;
  if (swap) {
    const coverMember =
      members.find((m) => m.id === swap.coverMemberId) ?? null;
    return {
      member: coverMember,
      baseMember: weekResult.member,
      swap,
      baseSource: weekResult.source,
      baseAppliedOverride: weekResult.appliedOverride,
    };
  }
  return {
    member: weekResult.member,
    baseMember: weekResult.member,
    swap: null,
    baseSource: weekResult.source,
    baseAppliedOverride: weekResult.appliedOverride,
  };
}

/**
 * 找出某 member 接下來「下一個 cycle 的第一天」當還班預設日期。
 *
 * 語意：
 * - 假設 creditor 現在正在值班（current cycle）→ 跳過整個 cycle，找他**再次**輪到的第一天
 * - 假設 creditor 現在不在值班 → 找他下一個值班 cycle 的第一天
 * - 同時必須沒被其他 swap 占用、且 base 上是該 member（不能是別人代他班代過來）
 *
 * 直覺：「等下次他輪回來再還」，不會把今天/明天本來就他的值班日當成還班日。
 *
 * 回傳 YYYY-MM-DD；找不到回 null
 */
export function findNextDutyDateForMember(
  memberId: number,
  members: ItDutyMember[],
  overrides: ItDutyOverride[],
  daySwaps: ItDutyDaySwap[],
  options: {
    /** 從哪天開始往後找。預設「明天」 */
    fromDate?: dayjs.ConfigType;
    /** 不能落點的日期（例如已存在 swap） */
    blockedDates?: ReadonlySet<string>;
    /** 最多往後找幾天（避免無限迴圈）*/
    searchDays?: number;
  } & RotationOptions = {}
): string | null {
  const start = options.fromDate
    ? dayjs(options.fromDate)
    : dayjs().add(1, "day");
  const limit = options.searchDays ?? 365;
  const blocked = options.blockedDates ?? new Set<string>();
  const passOptions: RotationOptions = {};
  if (options.autoAnchorIsoWeek !== undefined) {
    passOptions.autoAnchorIsoWeek = options.autoAnchorIsoWeek;
  }
  if (options.weeksPerSlot !== undefined) {
    passOptions.weeksPerSlot = options.weeksPerSlot;
  }
  let cursor = start.startOf("day");
  // 兩階段：
  //  Phase 1 (foundEnd=false)：等 creditor 現在這輪結束（連續 base 是 creditor 的時段）
  //  Phase 2 (foundEnd=true)：找 creditor **再次**輪到、且該天未被代班占用的第一天
  let foundEnd = false;
  for (let i = 0; i < limit; i += 1) {
    const dateKey = cursor.format("YYYY-MM-DD");
    const result = calculateDutyForDay(
      cursor,
      members,
      overrides,
      daySwaps,
      passOptions
    );
    if (!foundEnd) {
      // 等 base 不再是 creditor → 那天就是 cycle 的「之後」
      if (result.member?.id !== memberId) {
        foundEnd = true;
      }
    } else if (
      result.member?.id === memberId &&
      result.swap === null &&
      !blocked.has(dateKey)
    ) {
      return dateKey;
    }
    cursor = cursor.add(1, "day");
  }
  return null;
}
