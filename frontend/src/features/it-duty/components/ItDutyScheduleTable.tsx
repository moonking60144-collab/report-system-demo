import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";
import { Dropdown, type MenuProps } from "antd";
import { MoreOutlined } from "@ant-design/icons";
import type {
  ItDutyDaySwap,
  ItDutyMember,
  ItDutyOverride,
} from "../../../api/itDuty";
import { calculateDutyForWeek } from "../utils/rotationCalculator";
import { isoWeekDiff, parseIsoWeek } from "../utils/isoWeek";
import {
  getHolidaysInRange,
  type TaiwanHoliday,
} from "../utils/taiwanHolidays";

interface Props {
  weeks: string[];
  currentIsoWeek: string;
  members: ItDutyMember[];
  overrides: ItDutyOverride[];
  daySwaps: ItDutyDaySwap[];
  weeksPerSlot: number;
  searchQuery: string;
  onAssign: (
    isoWeek: string,
    currentOverride: ItDutyOverride | null,
    defaultMemberId: number | null
  ) => void;
  onClearOverride: (isoWeek: string) => void;
}

interface RowComputedData {
  isoWeek: string;
  rangeLabel: string;
  member: ItDutyMember | null;
  override: ItDutyOverride | null;
  isOverrideRow: boolean;
  holidays: TaiwanHoliday[];
  delta: number; // 相對於 currentIsoWeek 的週差
  /** 該週裡的 day swap 數量（含 leave 跟 repay）*/
  swapCount: number;
}

function formatDateRange(start: dayjs.Dayjs, end: dayjs.Dayjs): string {
  const sameYear = start.year() === end.year();
  const startFmt = sameYear ? "MM/DD" : "YYYY/MM/DD";
  const endFmt = sameYear ? "MM/DD" : "YYYY/MM/DD";
  return `${start.format(startFmt)} ~ ${end.format(endFmt)}`;
}

function buildRelativeLabel(
  delta: number,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  if (delta === 0) return t("table.currentWeekTag");
  if (delta === -1) return t("table.relativeLastWeek");
  if (delta === 1) return t("table.relativeNextWeek");
  if (delta < 0) return t("table.relativeWeeksAgo", { count: Math.abs(delta) });
  return t("table.relativeWeeksLater", { count: delta });
}

export function ItDutyScheduleTable({
  weeks,
  currentIsoWeek,
  members,
  overrides,
  daySwaps,
  weeksPerSlot,
  searchQuery,
  onAssign,
  onClearOverride,
}: Props) {
  const { t } = useTranslation("itDuty");

  const overrideMap = useMemo(() => {
    const m = new Map<string, ItDutyOverride>();
    for (const o of overrides) m.set(o.isoWeek, o);
    return m;
  }, [overrides]);

  const rows: RowComputedData[] = useMemo(
    () =>
      weeks.map((isoWeek) => {
        const range = parseIsoWeek(isoWeek);
        const result = calculateDutyForWeek(isoWeek, members, overrides, {
          autoAnchorIsoWeek: currentIsoWeek,
          weeksPerSlot,
        });
        const override = overrideMap.get(isoWeek) ?? null;
        const startKey = range.start.format("YYYY-MM-DD");
        const endKey = range.end.format("YYYY-MM-DD");
        const swapCount = daySwaps.filter(
          (s) => s.coverDate >= startKey && s.coverDate <= endKey
        ).length;
        return {
          isoWeek,
          rangeLabel: formatDateRange(range.start, range.end),
          member: result.member,
          override,
          isOverrideRow: !!override,
          holidays: getHolidaysInRange(range.start.toDate(), range.end.toDate()),
          delta: isoWeekDiff(isoWeek, currentIsoWeek),
          swapCount,
        };
      }),
    [
      weeks,
      members,
      overrides,
      daySwaps,
      currentIsoWeek,
      weeksPerSlot,
      overrideMap,
    ]
  );

  const visibleRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      (row.member?.name ?? "").toLowerCase().includes(q)
    );
  }, [rows, searchQuery]);

  if (visibleRows.length === 0) {
    return (
      <div className="itduty-table-empty">{t("table.noMatches")}</div>
    );
  }

  return (
    <div className="itduty-schedule-table-wrapper">
      <table className="itduty-schedule-table">
        <thead>
          <tr>
            <th scope="col" className="itduty-schedule-table__col-time">
              {t("table.week")}
            </th>
            <th scope="col" className="itduty-schedule-table__col-range">
              {t("table.dateRange")}
            </th>
            <th scope="col" className="itduty-schedule-table__col-member">
              {t("table.member")}
            </th>
            <th scope="col" className="itduty-schedule-table__col-actions">
              <span className="itduty-visually-hidden">
                {t("table.actions")}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => {
            const isCurrent = row.delta === 0;
            const isPast = row.delta < 0;
            const hasHoliday = row.holidays.length > 0;
            const trClassName = [
              "itduty-week-row",
              isCurrent ? "itduty-week-row--current" : "",
              isPast ? "itduty-week-row--past" : "",
              hasHoliday ? "itduty-week-row--has-holiday" : "",
              row.isOverrideRow ? "itduty-week-row--override" : "",
            ]
              .filter(Boolean)
              .join(" ");

            const menuItems: MenuProps["items"] = [
              {
                key: "assign",
                label: t("table.assign"),
                onClick: () =>
                  onAssign(row.isoWeek, row.override, row.member?.id ?? null),
              },
            ];
            if (row.isOverrideRow) {
              menuItems.push({
                key: "clear-override",
                label: t("table.clearOverride"),
                onClick: () => onClearOverride(row.isoWeek),
              });
            }

            return (
              <tr key={row.isoWeek} className={trClassName}>
                <td className="itduty-schedule-table__cell-time">
                  <div className="itduty-time-cell">
                    <span className="itduty-time-cell__relative">
                      {buildRelativeLabel(row.delta, t)}
                    </span>
                    <span className="itduty-time-cell__iso">{row.isoWeek}</span>
                  </div>
                </td>
                <td className="itduty-schedule-table__cell-range">
                  <span>{row.rangeLabel}</span>
                </td>
                <td className="itduty-schedule-table__cell-member">
                  <div className="itduty-member-cell">
                    <span className="itduty-member-cell__name">
                      {row.member?.name ?? "—"}
                      {row.isOverrideRow ? (
                        <span
                          className="itduty-member-cell__override-dot"
                          aria-label={t("table.overrideTag")}
                          title={t("table.overrideTag")}
                        />
                      ) : null}
                      {row.swapCount > 0 ? (
                        <span
                          className="itduty-member-cell__swap-tag"
                          title={t("table.swapTooltip", {
                            count: row.swapCount,
                          })}
                        >
                          {t("table.swapTag", { count: row.swapCount })}
                        </span>
                      ) : null}
                    </span>
                    {hasHoliday ? (
                      <ul className="itduty-member-cell__holiday-tags">
                        {row.holidays.map((h) => (
                          <li
                            key={`${h.date}-${h.name}`}
                            className="itduty-member-cell__holiday-tag"
                            title={h.name}
                          >
                            {h.name} {dayjs(h.date).format("MM/DD")}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  {row.override?.note ? (
                    <p className="itduty-member-cell__note">{row.override.note}</p>
                  ) : null}
                </td>
                <td className="itduty-schedule-table__cell-actions">
                  <Dropdown
                    menu={{ items: menuItems }}
                    trigger={["click"]}
                    placement="bottomRight"
                  >
                    <button
                      type="button"
                      className="itduty-btn itduty-btn--icon"
                      aria-label={t("table.actionsMenu")}
                    >
                      <MoreOutlined />
                    </button>
                  </Dropdown>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
