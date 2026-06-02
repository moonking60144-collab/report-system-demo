import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import dayjs, { type Dayjs } from "dayjs";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import type {
  ItDutyDaySwap,
  ItDutyMember,
  ItDutyOverride,
} from "../../../api/itDuty";
import {
  calculateDutyForDay,
  calculateDutyForWeek,
} from "../utils/rotationCalculator";
import { formatIsoWeek } from "../utils/isoWeek";
import {
  getHolidaysInRange,
  type TaiwanHoliday,
} from "../utils/taiwanHolidays";

interface Props {
  displayMonth: Dayjs;
  currentIsoWeek: string;
  members: ItDutyMember[];
  overrides: ItDutyOverride[];
  daySwaps: ItDutyDaySwap[];
  weeksPerSlot: number;
  onChangeMonth: (next: Dayjs) => void;
  onAssign: (
    isoWeek: string,
    currentOverride: ItDutyOverride | null,
    defaultMemberId: number | null
  ) => void;
  onDayClick: (
    date: string,
    baseMember: ItDutyMember | null,
    existingSwap: ItDutyDaySwap | null
  ) => void;
}

interface DayCell {
  date: Dayjs;
  isoDate: string;
  isCurrentMonth: boolean;
  isToday: boolean;
  holiday: TaiwanHoliday | null;
  baseMember: ItDutyMember | null;
  actualMember: ItDutyMember | null;
  swap: ItDutyDaySwap | null;
}

interface WeekRow {
  isoWeek: string;
  member: ItDutyMember | null;
  override: ItDutyOverride | null;
  isOverride: boolean;
  isCurrent: boolean;
  days: DayCell[];
}

function buildWeekRows(
  displayMonth: Dayjs,
  members: ItDutyMember[],
  overrides: ItDutyOverride[],
  daySwaps: ItDutyDaySwap[],
  currentIsoWeek: string,
  weeksPerSlot: number
): WeekRow[] {
  const today = dayjs().startOf("day");
  const firstOfMonth = displayMonth.startOf("month");
  const lastOfMonth = displayMonth.endOf("month");
  const calendarStart = firstOfMonth.startOf("isoWeek");
  const calendarEnd = lastOfMonth.endOf("isoWeek");
  const holidays = getHolidaysInRange(calendarStart.toDate(), calendarEnd.toDate());
  const holidayByDate = new Map<string, TaiwanHoliday>();
  for (const h of holidays) {
    if (!holidayByDate.has(h.date)) holidayByDate.set(h.date, h);
  }
  const overrideMap = new Map<string, ItDutyOverride>();
  for (const o of overrides) overrideMap.set(o.isoWeek, o);

  const rows: WeekRow[] = [];
  let cursor = calendarStart;
  while (cursor.isBefore(calendarEnd) || cursor.isSame(calendarEnd, "day")) {
    const weekStart = cursor.startOf("isoWeek");
    const isoWeek = formatIsoWeek(weekStart);
    const weekResult = calculateDutyForWeek(isoWeek, members, overrides, {
      autoAnchorIsoWeek: currentIsoWeek,
      weeksPerSlot,
    });
    const days: DayCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const day = weekStart.add(i, "day");
      const isoDate = day.format("YYYY-MM-DD");
      const dayResult = calculateDutyForDay(
        day,
        members,
        overrides,
        daySwaps,
        { autoAnchorIsoWeek: currentIsoWeek, weeksPerSlot }
      );
      days.push({
        date: day,
        isoDate,
        isCurrentMonth: day.isSame(displayMonth, "month"),
        isToday: day.isSame(today, "day"),
        holiday: holidayByDate.get(isoDate) ?? null,
        baseMember: dayResult.baseMember,
        actualMember: dayResult.member,
        swap: dayResult.swap,
      });
    }
    const override = overrideMap.get(isoWeek) ?? null;
    rows.push({
      isoWeek,
      member: weekResult.member,
      override,
      isOverride: !!override,
      isCurrent: isoWeek === currentIsoWeek,
      days,
    });
    cursor = weekStart.add(7, "day");
  }
  return rows;
}

export function ItDutyMonthCalendar({
  displayMonth,
  currentIsoWeek,
  members,
  overrides,
  daySwaps,
  weeksPerSlot,
  onChangeMonth,
  onAssign,
  onDayClick,
}: Props) {
  const { t } = useTranslation("itDuty");

  const rows = useMemo(
    () =>
      buildWeekRows(
        displayMonth,
        members,
        overrides,
        daySwaps,
        currentIsoWeek,
        weeksPerSlot
      ),
    [displayMonth, members, overrides, daySwaps, currentIsoWeek, weeksPerSlot]
  );

  const monthLabel = t("calendar.title", {
    year: displayMonth.year(),
    month: String(displayMonth.month() + 1).padStart(2, "0"),
  });
  const isShowingCurrentMonth = displayMonth.isSame(dayjs(), "month");

  return (
    <section className="itduty-calendar">
      <header className="itduty-calendar__head">
        <button
          type="button"
          className="itduty-btn itduty-btn--icon"
          aria-label={t("calendar.prevMonth")}
          onClick={() => onChangeMonth(displayMonth.subtract(1, "month"))}
        >
          <LeftOutlined />
        </button>
        <h2 className="itduty-calendar__title">{monthLabel}</h2>
        <button
          type="button"
          className="itduty-btn itduty-btn--icon"
          aria-label={t("calendar.nextMonth")}
          onClick={() => onChangeMonth(displayMonth.add(1, "month"))}
        >
          <RightOutlined />
        </button>
        {!isShowingCurrentMonth ? (
          <button
            type="button"
            className="itduty-btn"
            onClick={() => onChangeMonth(dayjs().startOf("month"))}
          >
            {t("calendar.today")}
          </button>
        ) : null}
      </header>

      <div className="itduty-calendar__grid">
        <div className="itduty-calendar__weekday-row">
          {[
            t("calendar.weekdayMon"),
            t("calendar.weekdayTue"),
            t("calendar.weekdayWed"),
            t("calendar.weekdayThu"),
            t("calendar.weekdayFri"),
            t("calendar.weekdaySat"),
            t("calendar.weekdaySun"),
          ].map((label) => (
            <span key={label} className="itduty-calendar__weekday-cell">
              {label}
            </span>
          ))}
          <span className="itduty-calendar__weekday-cell itduty-calendar__weekday-cell--duty">
            {t("calendar.weekDutyLabel")}
          </span>
        </div>

        {rows.map((row) => (
          <div
            key={row.isoWeek}
            className={[
              "itduty-calendar__week-row",
              row.isCurrent ? "itduty-calendar__week-row--current" : "",
              row.days.every(
                (d) =>
                  !d.isCurrentMonth || d.date.isBefore(dayjs(), "day")
              )
                ? "itduty-calendar__week-row--past"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {row.days.map((day, idx) => {
              const cellClass = [
                "itduty-calendar__day-cell",
                day.isCurrentMonth ? "" : "itduty-calendar__day-cell--off",
                day.isToday ? "itduty-calendar__day-cell--today" : "",
                day.holiday ? "itduty-calendar__day-cell--holiday" : "",
                day.swap ? "itduty-calendar__day-cell--swapped" : "",
                idx === 5 || idx === 6
                  ? "itduty-calendar__day-cell--weekend"
                  : "",
              ]
                .filter(Boolean)
                .join(" ");
              const tooltip = day.swap
                ? t("calendar.daySwapTooltip", {
                    base: day.baseMember?.name ?? "",
                    cover: day.actualMember?.name ?? "",
                    reason: t(`daySwap.reason.${day.swap.reason}`),
                  })
                : day.holiday
                  ? t("calendar.holidayCellTitle", { name: day.holiday.name })
                  : day.actualMember?.name;
              return (
                <button
                  type="button"
                  key={day.isoDate}
                  className={cellClass}
                  title={tooltip}
                  onClick={() =>
                    onDayClick(day.isoDate, day.baseMember, day.swap)
                  }
                  disabled={!day.baseMember}
                >
                  <span className="itduty-calendar__day-number">
                    {day.date.date()}
                  </span>
                  {day.holiday ? (
                    <span className="itduty-calendar__day-holiday-mark">
                      {day.holiday.name}
                    </span>
                  ) : null}
                  {day.swap ? (
                    <span
                      className={[
                        "itduty-calendar__day-swap-tag",
                        day.swap.reason === "repay"
                          ? "itduty-calendar__day-swap-tag--repay"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {day.actualMember?.name ?? "—"}
                    </span>
                  ) : null}
                </button>
              );
            })}
            <button
              type="button"
              className={[
                "itduty-calendar__duty-cell",
                row.isOverride ? "itduty-calendar__duty-cell--override" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() =>
                onAssign(row.isoWeek, row.override, row.member?.id ?? null)
              }
              title={t("table.assign")}
            >
              <span className="itduty-calendar__duty-iso">{row.isoWeek}</span>
              <span className="itduty-calendar__duty-name">
                {row.member?.name ?? "—"}
              </span>
              {row.override?.note ? (
                <span
                  className="itduty-calendar__duty-note"
                  title={row.override.note}
                >
                  {row.override.note}
                </span>
              ) : null}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
