import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ReloadOutlined } from "@ant-design/icons";
import { ConfigProvider, Modal, message, theme as antdTheme } from "antd";
import dayjs from "dayjs";
import {
  deleteItDutyOverride,
  deleteItDutySwap,
  fetchItDutyDebts,
  fetchItDutyMembers,
  fetchItDutyOverrides,
  fetchItDutySetting,
  fetchItDutySwaps,
  updateItDutySetting,
  type ItDutyDaySwap,
  type ItDutyDebtEntry,
  type ItDutyMember,
  type ItDutyOverride,
} from "../../../api/itDuty";
import { ItDutyMemberManagerModal } from "../components/ItDutyMemberManagerModal";
import { ItDutyAssignWeekModal } from "../components/ItDutyAssignWeekModal";
import { ItDutyScheduleTable } from "../components/ItDutyScheduleTable";
import { ItDutyHeroCards } from "../components/ItDutyHeroCards";
import { ItDutyMonthCalendar } from "../components/ItDutyMonthCalendar";
import { ItDutyThemeToggle } from "../components/ItDutyThemeToggle";
import { ItDutyDaySwapModal } from "../components/ItDutyDaySwapModal";
import { ItDutyDebtPanel } from "../components/ItDutyDebtPanel";
import { ItDutyRepayModal } from "../components/ItDutyRepayModal";
import { findNextDutyDateForMember } from "../utils/dayResolver";
import { useItDutyTheme } from "../hooks/useItDutyTheme";
import {
  buildIsoWeekRange,
  currentIsoWeek as computeCurrentIsoWeek,
  formatIsoWeek,
  shiftIsoWeek,
} from "../utils/isoWeek";
import "../styles/it-duty-page.css";

const PAST_WEEKS = 1;
const DEFAULT_FUTURE_WEEKS = 12;
const WEEKS_PER_SLOT_OPTIONS = [1, 2, 3, 4];

interface AssignTarget {
  isoWeek: string;
  currentOverride: ItDutyOverride | null;
  defaultMemberId: number | null;
}

interface DaySwapTarget {
  date: string;
  baseMember: ItDutyMember | null;
  existingSwap: ItDutyDaySwap | null;
}

interface RepayTarget {
  debtor: ItDutyMember | null;
  creditor: ItDutyMember | null;
  pendingLeaves: ItDutyDaySwap[];
  suggestedCoverDate: string | null;
}

export function ItDutyPage() {
  const { t } = useTranslation("itDuty");

  const [members, setMembers] = useState<ItDutyMember[]>([]);
  const [overrides, setOverrides] = useState<ItDutyOverride[]>([]);
  const [daySwaps, setDaySwaps] = useState<ItDutyDaySwap[]>([]);
  const [debts, setDebts] = useState<ItDutyDebtEntry[]>([]);
  const [weeksPerSlot, setWeeksPerSlot] = useState(1);
  const [loading, setLoading] = useState(true);
  const [memberModalOpen, setMemberModalOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  const [daySwapTarget, setDaySwapTarget] = useState<DaySwapTarget | null>(null);
  const [repayTarget, setRepayTarget] = useState<RepayTarget | null>(null);
  const [futureWeeks, setFutureWeeks] = useState(DEFAULT_FUTURE_WEEKS);
  const [searchQuery, setSearchQuery] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(() =>
    dayjs().startOf("month")
  );
  const { mode: themeMode, resolved: resolvedTheme, setMode: setThemeMode } =
    useItDutyTheme();

  const currentIsoWeek = useMemo(() => computeCurrentIsoWeek(dayjs()), []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const earliestWeek = shiftIsoWeek(currentIsoWeek, -PAST_WEEKS - 4);
      const latestWeek = shiftIsoWeek(currentIsoWeek, futureWeeks + 4);
      // Day swap 全抓不分範圍：debt panel 需要對應到所有未配對 leave，
      // 範圍限制會讓「N 天前的舊請假找不到 leave 配對 → 還班 dead-end」。
      // IT 內部表使用量小，全 fetch 完全沒效能負擔。
      const [memberList, overrideList, setting, swapList, debtList] =
        await Promise.all([
          fetchItDutyMembers(),
          fetchItDutyOverrides({ from: earliestWeek, to: latestWeek }),
          fetchItDutySetting(),
          fetchItDutySwaps(),
          fetchItDutyDebts(),
        ]);
      setMembers(memberList);
      setOverrides(overrideList);
      setWeeksPerSlot(setting.weeksPerSlot);
      setDaySwaps(swapList);
      setDebts(debtList);
    } catch (error) {
      console.error("[itDuty] load failed", error);
      void message.error(t("errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [currentIsoWeek, futureWeeks, t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const weeks = useMemo(
    () => buildIsoWeekRange(currentIsoWeek, PAST_WEEKS, futureWeeks),
    [currentIsoWeek, futureWeeks]
  );

  const hasMembers = members.some((m) => m.active);

  async function performClearOverride(
    isoWeek: string,
    swapsToDelete: ItDutyDaySwap[]
  ) {
    try {
      await deleteItDutyOverride(isoWeek);
      // 連動刪該週的 day swap（依使用者選擇）
      // 刪除順序：repay 先於 leave。後端 deleteSwap 已會連動刪 paired，
      // 為了避免重複刪同一筆已被連動掉的 id，這裡 dedupe 過濾。
      const seenIds = new Set<number>();
      for (const swap of swapsToDelete) {
        if (seenIds.has(swap.id)) continue;
        seenIds.add(swap.id);
        if (swap.pairedSwapId) seenIds.add(swap.pairedSwapId);
        try {
          await deleteItDutySwap(swap.id);
        } catch (error) {
          console.warn("[itDuty] cascade delete swap failed", error);
        }
      }
      void message.success(t("assignModal.clearSuccess", { isoWeek }));
      void loadData();
    } catch (error) {
      console.error("[itDuty] clear override failed", error);
      void message.error(t("errors.deleteFailed"));
    }
  }

  async function handleClearOverride(isoWeek: string) {
    // 該週是否還有 day swap
    const range = daySwaps.filter(
      (s) => formatIsoWeek(dayjs(s.coverDate)) === isoWeek
    );
    if (range.length === 0) {
      void performClearOverride(isoWeek, []);
      return;
    }
    // 提示使用者選擇
    Modal.confirm({
      title: t("clearOverridePrompt.title", { isoWeek }),
      content: t("clearOverridePrompt.content", { count: range.length }),
      okText: t("clearOverridePrompt.deleteBoth"),
      cancelText: t("clearOverridePrompt.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        await performClearOverride(isoWeek, range);
      },
      footer: (_, { OkBtn, CancelBtn }) => (
        <>
          <button
            type="button"
            className="itduty-btn"
            onClick={() => {
              Modal.destroyAll();
              void performClearOverride(isoWeek, []);
            }}
          >
            {t("clearOverridePrompt.keepSwaps")}
          </button>
          <CancelBtn />
          <OkBtn />
        </>
      ),
    });
  }

  async function handleWeeksPerSlotChange(next: number) {
    if (next === weeksPerSlot) return;
    const previous = weeksPerSlot;
    setWeeksPerSlot(next); // 樂觀更新
    try {
      const updated = await updateItDutySetting(next);
      setWeeksPerSlot(updated.weeksPerSlot);
      void message.success(
        t("page.settingsSavedToast", { weeks: updated.weeksPerSlot })
      );
    } catch (error) {
      console.error("[itDuty] update setting failed", error);
      setWeeksPerSlot(previous);
      void message.error(t("errors.saveFailed"));
    }
  }

  return (
    <ConfigProvider
      theme={{
        algorithm:
          resolvedTheme === "dark"
            ? antdTheme.darkAlgorithm
            : antdTheme.defaultAlgorithm,
      }}
    >
    <div className="itduty-page-shell" data-theme={resolvedTheme}>
      <header className="itduty-page-header">
        <div>
          <h1 className="itduty-page-title">{t("page.title")}</h1>
          <p className="itduty-page-subtitle">{t("page.subtitle")}</p>
        </div>
        <div className="itduty-page-header__right">
          <ItDutyThemeToggle mode={themeMode} onChange={setThemeMode} />
        </div>
      </header>

      {hasMembers ? (
        <ItDutyHeroCards
          currentIsoWeek={currentIsoWeek}
          members={members}
          overrides={overrides}
          daySwaps={daySwaps}
          weeksPerSlot={weeksPerSlot}
          onAssign={(isoWeek, currentOverride, defaultMemberId) =>
            setAssignTarget({ isoWeek, currentOverride, defaultMemberId })
          }
        />
      ) : null}

      {hasMembers ? (
        <ItDutyMonthCalendar
          displayMonth={calendarMonth}
          currentIsoWeek={currentIsoWeek}
          members={members}
          overrides={overrides}
          daySwaps={daySwaps}
          weeksPerSlot={weeksPerSlot}
          onChangeMonth={setCalendarMonth}
          onAssign={(isoWeek, currentOverride, defaultMemberId) =>
            setAssignTarget({ isoWeek, currentOverride, defaultMemberId })
          }
          onDayClick={(date, baseMember, existingSwap) =>
            setDaySwapTarget({ date, baseMember, existingSwap })
          }
        />
      ) : null}

      {hasMembers ? (
        <ItDutyDebtPanel
          debts={debts}
          members={members}
          daySwaps={daySwaps}
          onSettle={(debtorId, creditorId, pendingLeaves) => {
            // 預估還班日：creditor 接下來第一個輪到、且未被代班占用的日期
            const blockedDates = new Set(daySwaps.map((s) => s.coverDate));
            const suggestedCoverDate = findNextDutyDateForMember(
              creditorId,
              members,
              overrides,
              daySwaps,
              {
                blockedDates,
                autoAnchorIsoWeek: currentIsoWeek,
                weeksPerSlot,
              }
            );
            setRepayTarget({
              debtor: members.find((m) => m.id === debtorId) ?? null,
              creditor: members.find((m) => m.id === creditorId) ?? null,
              pendingLeaves,
              suggestedCoverDate,
            });
          }}
        />
      ) : null}

      <section className="itduty-page-toolbar">
        <input
          type="search"
          className="itduty-input itduty-input--search"
          placeholder={t("table.searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <label className="itduty-page-range">
          <span>{t("toolbar.weeksPerSlotLabel")}</span>
          <select
            className="itduty-input itduty-input--inline"
            value={weeksPerSlot}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) {
                void handleWeeksPerSlotChange(v);
              }
            }}
            disabled={loading}
          >
            {WEEKS_PER_SLOT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} {t("toolbar.weeksPerSlotUnit")}
              </option>
            ))}
          </select>
        </label>
        <label className="itduty-page-range">
          <select
            className="itduty-input itduty-input--inline"
            value={futureWeeks}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) {
                setFutureWeeks(v);
              }
            }}
            disabled={loading}
          >
            {[4, 8, 12, 24, 52].map((n) => (
              <option key={n} value={n}>
                {t("toolbar.rangeWeeks", { count: n })}
              </option>
            ))}
          </select>
        </label>
        <div className="itduty-page-toolbar__spacer" />
        <button
          type="button"
          className="itduty-btn"
          onClick={() => void loadData()}
          disabled={loading}
        >
          <ReloadOutlined /> {t("page.refresh")}
        </button>
        <button
          type="button"
          className="itduty-btn itduty-btn--primary"
          onClick={() => setMemberModalOpen(true)}
        >
          {t("page.manageMembers")}
        </button>
      </section>

      {!hasMembers && !loading ? (
        <div className="itduty-empty-state">
          <p>{t("page.emptyMembers")}</p>
        </div>
      ) : (
        <ItDutyScheduleTable
          weeks={weeks}
          currentIsoWeek={currentIsoWeek}
          members={members}
          overrides={overrides}
          daySwaps={daySwaps}
          weeksPerSlot={weeksPerSlot}
          searchQuery={searchQuery}
          onAssign={(isoWeek, currentOverride, defaultMemberId) =>
            setAssignTarget({ isoWeek, currentOverride, defaultMemberId })
          }
          onClearOverride={(isoWeek) => void handleClearOverride(isoWeek)}
        />
      )}

      <ItDutyMemberManagerModal
        open={memberModalOpen}
        members={members}
        onClose={() => setMemberModalOpen(false)}
        onChanged={() => void loadData()}
      />

      <ItDutyAssignWeekModal
        open={assignTarget !== null}
        isoWeek={assignTarget?.isoWeek ?? null}
        members={members}
        currentOverride={assignTarget?.currentOverride ?? null}
        defaultMemberId={assignTarget?.defaultMemberId ?? null}
        onClose={() => setAssignTarget(null)}
        onSaved={() => void loadData()}
      />

      <ItDutyDaySwapModal
        open={daySwapTarget !== null}
        date={daySwapTarget?.date ?? null}
        baseMember={daySwapTarget?.baseMember ?? null}
        existingSwap={daySwapTarget?.existingSwap ?? null}
        members={members}
        onClose={() => setDaySwapTarget(null)}
        onSaved={() => void loadData()}
      />

      <ItDutyRepayModal
        open={repayTarget !== null}
        pendingLeaves={repayTarget?.pendingLeaves ?? []}
        debtor={repayTarget?.debtor ?? null}
        creditor={repayTarget?.creditor ?? null}
        blockedDates={new Set(daySwaps.map((s) => s.coverDate))}
        suggestedCoverDate={repayTarget?.suggestedCoverDate ?? null}
        onClose={() => setRepayTarget(null)}
        onSaved={() => void loadData()}
      />
    </div>
    </ConfigProvider>
  );
}
