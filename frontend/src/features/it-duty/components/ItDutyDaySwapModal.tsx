import { useEffect, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";
import {
  createItDutyLeaveSwap,
  deleteItDutySwap,
  type ItDutyDaySwap,
  type ItDutyMember,
} from "../../../api/itDuty";

interface Props {
  open: boolean;
  date: string | null; // YYYY-MM-DD
  baseMember: ItDutyMember | null; // 該天該週原本值班的人
  existingSwap: ItDutyDaySwap | null; // 該天已存在的 swap (若有)
  members: ItDutyMember[];
  onClose: () => void;
  onSaved: () => void;
}

export function ItDutyDaySwapModal({
  open,
  date,
  baseMember,
  existingSwap,
  members,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation("itDuty");
  const [coverMemberId, setCoverMemberId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) {
      setCoverMemberId(existingSwap?.coverMemberId ?? null);
      setNote(existingSwap?.note ?? "");
    }
  }, [open, existingSwap]);

  const baseMemberId = baseMember?.id ?? null;

  // 「原本值班」顯示：
  // - 已存在 swap → 用紀錄裡的 originalMemberId（避免 override 改派後 base 變了，
  //   但這筆 swap 是過去農曆事實的快照，顯示應該忠於紀錄）
  // - 沒 swap (新建情境) → 用當下計算的 baseMember
  const displayOriginalMember = existingSwap
    ? members.find((m) => m.id === existingSwap.originalMemberId) ?? null
    : baseMember;
  const displayCoverMember = existingSwap
    ? members.find((m) => m.id === existingSwap.coverMemberId) ?? null
    : null;

  // 候選代班人：active 的 + 排除 baseMember 自己
  const candidates = members.filter(
    (m) => m.active && m.id !== baseMemberId
  );

  async function handleSave() {
    if (!date || coverMemberId === null || baseMemberId === null || working) {
      return;
    }
    setWorking(true);
    try {
      await createItDutyLeaveSwap({
        coverDate: date,
        originalMemberId: baseMemberId,
        coverMemberId,
        note: note.trim() ? note.trim() : null,
      });
      const cover = members.find((m) => m.id === coverMemberId);
      void message.success(
        t("daySwap.saveSuccess", {
          date,
          original: baseMember?.name ?? "",
          cover: cover?.name ?? "",
        })
      );
      onSaved();
      onClose();
    } catch (error) {
      console.error("[itDuty] create leave swap failed", error);
      const errMessage =
        error && typeof error === "object" && "response" in error
          ? // axios error
            ((error as { response?: { data?: { error?: { message?: string } } } })
              .response?.data?.error?.message ?? null)
          : null;
      void message.error(errMessage ?? t("errors.saveFailed"));
    } finally {
      setWorking(false);
    }
  }

  async function handleDelete() {
    if (!existingSwap || working) return;
    setWorking(true);
    try {
      await deleteItDutySwap(existingSwap.id);
      void message.success(t("daySwap.deleteSuccess", { date: date ?? "" }));
      onSaved();
      onClose();
    } catch (error) {
      console.error("[itDuty] delete swap failed", error);
      void message.error(t("errors.deleteFailed"));
    } finally {
      setWorking(false);
    }
  }

  const isExisting = !!existingSwap;
  const isPaired = !!existingSwap?.pairedSwapId;
  const dateLabel = date ? dayjs(date).format("YYYY/MM/DD (ddd)") : "";

  return (
    <Modal
      open={open && !!date}
      title={
        isExisting
          ? t("daySwap.titleExisting", { date: dateLabel })
          : t("daySwap.titleNew", { date: dateLabel })
      }
      onCancel={onClose}
      footer={null}
      width={460}
    >
      <div className="itduty-modal-form">
        <div className="itduty-modal-form__readonly">
          <span className="itduty-modal-form__readonly-label">
            {t("daySwap.originalLabel")}
          </span>
          <span className="itduty-modal-form__readonly-value">
            {displayOriginalMember?.name ?? "—"}
          </span>
        </div>

        {isExisting && displayCoverMember ? (
          <div className="itduty-modal-form__readonly">
            <span className="itduty-modal-form__readonly-label">
              {t("daySwap.coverLabel")}
            </span>
            <span className="itduty-modal-form__readonly-value">
              {displayCoverMember.name}
            </span>
          </div>
        ) : (
          <label className="itduty-modal-form__label">
            {t("daySwap.coverLabel")}
            <select
              className="itduty-input"
              value={coverMemberId ?? ""}
              onChange={(e) => {
                const v = Number(e.target.value);
                setCoverMemberId(Number.isFinite(v) && v > 0 ? v : null);
              }}
              disabled={working}
            >
              <option value="">{t("daySwap.coverPlaceholder")}</option>
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {isExisting ? (
          existingSwap.note ? (
            <div className="itduty-modal-form__readonly itduty-modal-form__readonly--block">
              <span className="itduty-modal-form__readonly-label">
                {t("assignModal.note")}
              </span>
              <span className="itduty-modal-form__readonly-value">
                {existingSwap.note}
              </span>
            </div>
          ) : null
        ) : (
          <label className="itduty-modal-form__label">
            {t("assignModal.note")}
            <textarea
              className="itduty-input itduty-input--textarea"
              rows={2}
              placeholder={t("daySwap.notePlaceholder")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={working}
              maxLength={200}
            />
          </label>
        )}

        {isExisting && existingSwap.reason === "leave" ? (
          <p className="itduty-modal-form__hint">
            {isPaired
              ? t("daySwap.hintPaired")
              : t("daySwap.hintUnpairedLeave")}
          </p>
        ) : null}
        {isExisting && existingSwap.reason === "repay" ? (
          <p className="itduty-modal-form__hint">
            {t("daySwap.hintRepay")}
          </p>
        ) : null}

        <div className="itduty-modal-form__footer">
          {isExisting ? (
            <button
              type="button"
              className="itduty-btn itduty-btn--danger"
              onClick={() => void handleDelete()}
              disabled={working}
            >
              {isPaired
                ? t("daySwap.deletePaired")
                : t("daySwap.delete")}
            </button>
          ) : null}
          <div className="itduty-modal-form__footer-spacer" />
          <button
            type="button"
            className="itduty-btn"
            onClick={onClose}
            disabled={working}
          >
            {t("assignModal.cancel")}
          </button>
          {!isExisting ? (
            <button
              type="button"
              className="itduty-btn itduty-btn--primary"
              onClick={() => void handleSave()}
              disabled={
                coverMemberId === null || baseMemberId === null || working
              }
            >
              {t("daySwap.saveLeave")}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
