import { useEffect, useMemo, useState } from "react";
import { DatePicker, Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import dayjs, { type Dayjs } from "dayjs";
import {
  createItDutyRepaySwap,
  type ItDutyDaySwap,
  type ItDutyMember,
} from "../../../api/itDuty";

interface Props {
  open: boolean;
  /** 要清算的請假紀錄 (一群同 debtor→creditor 的 unpaired leave) */
  pendingLeaves: ItDutyDaySwap[];
  /** 該 debt 的 debtor (請假/欠的那位)，repay 中當 cover */
  debtor: ItDutyMember | null;
  /** 該 debt 的 creditor (代班/被欠的那位)，repay 中當 original */
  creditor: ItDutyMember | null;
  /** 已經被 swap 占用的日期，避免重複占同一天 */
  blockedDates: Set<string>;
  /** 系統推估的還班日期（creditor 下次輪到的第一天）*/
  suggestedCoverDate: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ItDutyRepayModal({
  open,
  pendingLeaves,
  debtor,
  creditor,
  blockedDates,
  suggestedCoverDate,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation("itDuty");
  const [pairLeaveSwapId, setPairLeaveSwapId] = useState<number | null>(null);
  const [coverDate, setCoverDate] = useState<Dayjs | null>(null);
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) {
      setPairLeaveSwapId(pendingLeaves[0]?.id ?? null);
      setCoverDate(suggestedCoverDate ? dayjs(suggestedCoverDate) : null);
      setNote("");
    }
  }, [open, pendingLeaves, suggestedCoverDate]);

  const coverDateString = useMemo(
    () => (coverDate ? coverDate.format("YYYY-MM-DD") : ""),
    [coverDate]
  );

  const dateConflict = useMemo(
    () => coverDateString.length > 0 && blockedDates.has(coverDateString),
    [coverDateString, blockedDates]
  );

  async function handleSave() {
    if (
      pairLeaveSwapId === null ||
      !coverDateString ||
      working ||
      dateConflict
    ) {
      return;
    }
    setWorking(true);
    try {
      await createItDutyRepaySwap({
        coverDate: coverDateString,
        pairLeaveSwapId,
        note: note.trim() ? note.trim() : null,
      });
      void message.success(
        t("repay.saveSuccess", {
          date: coverDateString,
          debtor: debtor?.name ?? "",
          creditor: creditor?.name ?? "",
        })
      );
      onSaved();
      onClose();
    } catch (error) {
      console.error("[itDuty] create repay swap failed", error);
      void message.error(t("errors.saveFailed"));
    } finally {
      setWorking(false);
    }
  }

  const today = useMemo(() => dayjs().startOf("day"), []);

  return (
    <Modal
      open={open}
      title={t("repay.title", {
        debtor: debtor?.name ?? "",
        creditor: creditor?.name ?? "",
      })}
      onCancel={onClose}
      footer={null}
      width={480}
    >
      <div className="itduty-modal-form">
        <p className="itduty-modal-form__hint">
          {t("repay.hint", {
            debtor: debtor?.name ?? "",
            creditor: creditor?.name ?? "",
          })}
        </p>

        <label className="itduty-modal-form__label">
          {t("repay.pickLeaveLabel")}
          <select
            className="itduty-input"
            value={pairLeaveSwapId ?? ""}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPairLeaveSwapId(Number.isFinite(v) && v > 0 ? v : null);
            }}
            disabled={working}
          >
            {pendingLeaves.map((l) => (
              <option key={l.id} value={l.id}>
                {dayjs(l.coverDate).format("YYYY/MM/DD")}
                {l.note ? ` — ${l.note}` : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="itduty-modal-form__label">
          <span className="itduty-modal-form__label-row">
            <span>{t("repay.coverDateLabel")}</span>
            {suggestedCoverDate ? (
              <span
                className="itduty-modal-form__label-suggest"
                title={t("repay.suggestedHint", {
                  creditor: creditor?.name ?? "",
                })}
              >
                {t("repay.suggestedTag", { date: suggestedCoverDate })}
              </span>
            ) : null}
          </span>
          <DatePicker
            value={coverDate}
            onChange={(d) => setCoverDate(d)}
            disabledDate={(current) =>
              !!current && current.isBefore(today)
            }
            format="YYYY-MM-DD"
            allowClear={false}
            placeholder={t("repay.coverDatePlaceholder")}
            className="itduty-modal-form__datepicker"
            disabled={working}
            style={{ width: "100%" }}
          />
          {dateConflict ? (
            <span className="itduty-modal-form__error">
              {t("repay.dateConflict")}
            </span>
          ) : null}
        </div>

        <label className="itduty-modal-form__label">
          {t("assignModal.note")}
          <textarea
            className="itduty-input itduty-input--textarea"
            rows={2}
            placeholder={t("repay.notePlaceholder")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={working}
            maxLength={200}
          />
        </label>

        <div className="itduty-modal-form__footer">
          <div className="itduty-modal-form__footer-spacer" />
          <button
            type="button"
            className="itduty-btn"
            onClick={onClose}
            disabled={working}
          >
            {t("assignModal.cancel")}
          </button>
          <button
            type="button"
            className="itduty-btn itduty-btn--primary"
            onClick={() => void handleSave()}
            disabled={
              pairLeaveSwapId === null ||
              !coverDateString ||
              dateConflict ||
              working
            }
          >
            {t("repay.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
