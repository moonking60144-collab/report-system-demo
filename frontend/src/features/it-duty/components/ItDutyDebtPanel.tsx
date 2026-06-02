import { useTranslation } from "react-i18next";
import type {
  ItDutyDaySwap,
  ItDutyDebtEntry,
  ItDutyMember,
} from "../../../api/itDuty";

interface Props {
  debts: ItDutyDebtEntry[];
  members: ItDutyMember[];
  daySwaps: ItDutyDaySwap[];
  onSettle: (
    debtorId: number,
    creditorId: number,
    pendingLeaves: ItDutyDaySwap[]
  ) => void;
}

function memberById(members: ItDutyMember[], id: number): ItDutyMember | null {
  return members.find((m) => m.id === id) ?? null;
}

export function ItDutyDebtPanel({ debts, members, daySwaps, onSettle }: Props) {
  const { t } = useTranslation("itDuty");

  if (debts.length === 0) {
    return null;
  }

  return (
    <section className="itduty-debt-panel">
      <header className="itduty-debt-panel__head">
        <h2 className="itduty-debt-panel__title">{t("debt.title")}</h2>
        <span className="itduty-debt-panel__hint">{t("debt.hint")}</span>
      </header>
      <ul className="itduty-debt-panel__list">
        {debts.map((d) => {
          const debtor = memberById(members, d.debtorMemberId);
          const creditor = memberById(members, d.creditorMemberId);
          const pendingLeaves = daySwaps
            .filter(
              (s) =>
                s.reason === "leave" &&
                s.pairedSwapId === null &&
                s.originalMemberId === d.debtorMemberId &&
                s.coverMemberId === d.creditorMemberId
            )
            .sort((a, b) => (a.coverDate < b.coverDate ? -1 : 1));
          return (
            <li
              key={`${d.debtorMemberId}:${d.creditorMemberId}`}
              className="itduty-debt-panel__row"
            >
              <span className="itduty-debt-panel__sentence">
                <strong>{debtor?.name ?? `#${d.debtorMemberId}`}</strong>
                <span className="itduty-debt-panel__owe-text">
                  {t("debt.owesText")}
                </span>
                <strong>{creditor?.name ?? `#${d.creditorMemberId}`}</strong>
                <span className="itduty-debt-panel__days">
                  {t("debt.days", { count: d.unsettledDays })}
                </span>
              </span>
              <button
                type="button"
                className="itduty-btn"
                onClick={() =>
                  onSettle(d.debtorMemberId, d.creditorMemberId, pendingLeaves)
                }
                disabled={pendingLeaves.length === 0}
              >
                {t("debt.settleAction")}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
