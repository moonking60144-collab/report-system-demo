import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";
import type {
  ItDutyDaySwap,
  ItDutyMember,
  ItDutyOverride,
} from "../../../api/itDuty";
import {
  calculateDutyForDay,
  calculateDutyForWeek,
} from "../utils/rotationCalculator";
import { parseIsoWeek, shiftIsoWeek } from "../utils/isoWeek";
import { getHolidaysInRange } from "../utils/taiwanHolidays";

interface Props {
  currentIsoWeek: string;
  members: ItDutyMember[];
  overrides: ItDutyOverride[];
  daySwaps: ItDutyDaySwap[];
  weeksPerSlot: number;
  onAssign: (
    isoWeek: string,
    currentOverride: ItDutyOverride | null,
    defaultMemberId: number | null
  ) => void;
}

interface CardData {
  isoWeek: string;
  rangeLabel: string;
  /** 該週基本值班（rotation / override 後）*/
  baseMember: ItDutyMember | null;
  /** 該週 override 紀錄 */
  override: ItDutyOverride | null;
  /** 「今天」這天的實際值班人（含 day swap overlay）；本週卡片才有意義 */
  todayActualMember: ItDutyMember | null;
  /** 今天是否有 swap */
  todayIsSwapped: boolean;
  /** 該週裡的 swap 數量（不含今天）*/
  weekSwapCount: number;
  daysToHandover: number;
  holidayCount: number;
  isCurrent: boolean;
}

function formatDateRange(start: dayjs.Dayjs, end: dayjs.Dayjs): string {
  return `${start.format("MM/DD")} ~ ${end.format("MM/DD")}`;
}

export function ItDutyHeroCards({
  currentIsoWeek,
  members,
  overrides,
  daySwaps,
  weeksPerSlot,
  onAssign,
}: Props) {
  const { t } = useTranslation("itDuty");

  const cards = useMemo<CardData[]>(() => {
    const today = dayjs().startOf("day");
    const todayKey = today.format("YYYY-MM-DD");
    return [currentIsoWeek, shiftIsoWeek(currentIsoWeek, 1)].map((isoWeek, idx) => {
      const range = parseIsoWeek(isoWeek);
      const baseResult = calculateDutyForWeek(isoWeek, members, overrides, {
        autoAnchorIsoWeek: currentIsoWeek,
        weeksPerSlot,
      });
      const overrideMatch = overrides.find((o) => o.isoWeek === isoWeek) ?? null;
      const holidays = getHolidaysInRange(range.start.toDate(), range.end.toDate());
      const nextMonday = range.end.add(1, "day").startOf("day");
      const daysToHandover = Math.max(0, nextMonday.diff(today, "day"));

      // 該週所有 swap
      const weekSwaps = daySwaps.filter(
        (s) =>
          s.coverDate >= range.start.format("YYYY-MM-DD") &&
          s.coverDate <= range.end.format("YYYY-MM-DD")
      );
      const todaySwap = weekSwaps.find((s) => s.coverDate === todayKey) ?? null;
      const todayInThisWeek =
        idx === 0 &&
        today.format("YYYY-MM-DD") >= range.start.format("YYYY-MM-DD") &&
        today.format("YYYY-MM-DD") <= range.end.format("YYYY-MM-DD");

      let todayActualMember: ItDutyMember | null = null;
      if (todayInThisWeek) {
        const dayResult = calculateDutyForDay(
          today,
          members,
          overrides,
          daySwaps,
          { autoAnchorIsoWeek: currentIsoWeek, weeksPerSlot }
        );
        todayActualMember = dayResult.member;
      }

      const weekSwapCount = todaySwap
        ? Math.max(0, weekSwaps.length - 1)
        : weekSwaps.length;

      return {
        isoWeek,
        rangeLabel: formatDateRange(range.start, range.end),
        baseMember: baseResult.member,
        override: overrideMatch,
        todayActualMember,
        todayIsSwapped: !!todaySwap,
        weekSwapCount,
        daysToHandover,
        holidayCount: holidays.length,
        isCurrent: idx === 0,
      };
    });
  }, [currentIsoWeek, members, overrides, daySwaps, weeksPerSlot]);

  return (
    <div className="itduty-hero-grid">
      {cards.map((card) => {
        // 主要顯示的人：本週卡片若今天有 swap，顯示實際代班人；其餘顯示週 base
        const displayMember = card.isCurrent && card.todayActualMember
          ? card.todayActualMember
          : card.baseMember;
        const showTodayCoverHint =
          card.isCurrent &&
          card.todayIsSwapped &&
          card.todayActualMember?.id !== card.baseMember?.id;
        return (
          <div
            key={card.isoWeek}
            className={[
              "itduty-hero-card",
              card.isCurrent
                ? "itduty-hero-card--current"
                : "itduty-hero-card--next",
            ].join(" ")}
          >
            <div className="itduty-hero-card__head">
              <span
                className={[
                  "itduty-hero-card__tag",
                  card.isCurrent
                    ? "itduty-hero-card__tag--current"
                    : "itduty-hero-card__tag--next",
                ].join(" ")}
              >
                {card.isCurrent
                  ? t("table.currentWeekTag")
                  : t("table.nextWeekTag")}
              </span>
              <span className="itduty-hero-card__week">{card.isoWeek}</span>
            </div>
            <div className="itduty-hero-card__member">
              {displayMember?.name ?? "—"}
              {card.override ? (
                <span
                  className="itduty-hero-card__override-dot"
                  aria-label={t("table.overrideTag")}
                  title={t("table.overrideTag")}
                />
              ) : null}
              {card.todayIsSwapped ? (
                <span
                  className="itduty-hero-card__swap-dot"
                  aria-label={t("hero.todaySwapTag")}
                  title={t("hero.todaySwapTag")}
                />
              ) : null}
            </div>
            {showTodayCoverHint ? (
              <div className="itduty-hero-card__sub">
                {t("hero.todayCoverHint", {
                  base: card.baseMember?.name ?? "",
                  cover: card.todayActualMember?.name ?? "",
                })}
              </div>
            ) : null}
            <div className="itduty-hero-card__meta">
              <span className="itduty-hero-card__date-range">
                {card.rangeLabel}
              </span>
              <span className="itduty-hero-card__sep">·</span>
              <span className="itduty-hero-card__countdown">
                {card.isCurrent
                  ? t("hero.daysUntilHandover", { count: card.daysToHandover })
                  : t("hero.daysUntilStart", { count: card.daysToHandover })}
              </span>
              <span className="itduty-hero-card__sep">·</span>
              <span
                className={[
                  "itduty-hero-card__holiday",
                  card.holidayCount > 0
                    ? "itduty-hero-card__holiday--has"
                    : "itduty-hero-card__holiday--none",
                ].join(" ")}
              >
                {card.holidayCount > 0
                  ? t("hero.holidayCount", { count: card.holidayCount })
                  : t("hero.noHoliday")}
              </span>
              {card.weekSwapCount > 0 ? (
                <>
                  <span className="itduty-hero-card__sep">·</span>
                  <span className="itduty-hero-card__week-swap">
                    {t("hero.weekSwapCount", { count: card.weekSwapCount })}
                  </span>
                </>
              ) : null}
            </div>
            <div className="itduty-hero-card__actions">
              <button
                type="button"
                className="itduty-btn"
                onClick={() =>
                  onAssign(
                    card.isoWeek,
                    card.override,
                    card.baseMember?.id ?? null
                  )
                }
              >
                {t("table.assign")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
