import { useEffect, useRef, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";
import {
  createItDutyLeaveSwap,
  deleteItDutyDayNote,
  deleteItDutySwap,
  upsertItDutyDayNote,
  IT_DUTY_NOTE_MAX_LENGTH,
  type ItDutyDayNote,
  type ItDutyDaySwap,
  type ItDutyMember,
} from "../../../api/itDuty";

interface Props {
  open: boolean;
  date: string | null; // YYYY-MM-DD
  baseMember: ItDutyMember | null; // 該天該週原本值班的人
  existingSwap: ItDutyDaySwap | null; // 該天已存在的 swap (若有)
  existingDayNote: ItDutyDayNote | null; // 該天已存在的純備註（跟代班無關）
  members: ItDutyMember[];
  onClose: () => void;
  /** 代班 / 還班 動到 → 全量 reload（swaps + debts 都會變） */
  onSwapSaved: () => void;
  /** 純備註動到 → 只重抓 dayNotes 即可 */
  onDayNoteSaved: () => void;
}

export function ItDutyDayModal({
  open,
  date,
  baseMember,
  existingSwap,
  existingDayNote,
  members,
  onClose,
  onSwapSaved,
  onDayNoteSaved,
}: Props) {
  const { t } = useTranslation("itDuty");
  const [coverMemberId, setCoverMemberId] = useState<number | null>(null);
  const [swapNote, setSwapNote] = useState("");
  const [dayNoteDraft, setDayNoteDraft] = useState("");
  const [working, setWorking] = useState(false);
  const [noteWorking, setNoteWorking] = useState(false);
  const prevOpenRef = useRef(false);

  // 只在 open false→true 那一次重置 form state。
  // 不掛 existingSwap / existingDayNote 在 deps 上 — 否則 parent 在 modal
  // 打開期間 reload data 會讓 prop reference 變動、把使用者打到一半的字洗掉。
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;
    if (justOpened) {
      setCoverMemberId(existingSwap?.coverMemberId ?? null);
      setSwapNote(existingSwap?.note ?? "");
      setDayNoteDraft(existingDayNote?.note ?? "");
    }
  }, [open, existingSwap, existingDayNote]);

  const baseMemberId = baseMember?.id ?? null;

  // 「原本值班」顯示：
  // - 已存在 swap → 用紀錄裡的 originalMemberId（避免 override 改派後 base 變了，
  //   但這筆 swap 是過去的快照，顯示應該忠於紀錄）
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
        note: swapNote.trim() ? swapNote.trim() : null,
      });
      const cover = members.find((m) => m.id === coverMemberId);
      void message.success(
        t("daySwap.saveSuccess", {
          date,
          original: baseMember?.name ?? "",
          cover: cover?.name ?? "",
        })
      );
      onSwapSaved();
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
      onSwapSaved();
      onClose();
    } catch (error) {
      console.error("[itDuty] delete swap failed", error);
      void message.error(t("errors.deleteFailed"));
    } finally {
      setWorking(false);
    }
  }

  async function handleSaveDayNote() {
    if (!date || noteWorking) return;
    const trimmed = dayNoteDraft.trim();
    if (!trimmed) {
      void message.warning(t("dayNote.emptyWarning"));
      return;
    }
    setNoteWorking(true);
    try {
      await upsertItDutyDayNote(date, trimmed);
      void message.success(t("dayNote.saveSuccess", { date }));
      onDayNoteSaved();
      onClose();
    } catch (error) {
      console.error("[itDuty] upsert day note failed", error);
      const errMessage =
        error && typeof error === "object" && "response" in error
          ? ((error as { response?: { data?: { error?: { message?: string } } } })
              .response?.data?.error?.message ?? null)
          : null;
      void message.error(errMessage ?? t("errors.saveFailed"));
    } finally {
      setNoteWorking(false);
    }
  }

  async function handleDeleteDayNote() {
    if (!date || !existingDayNote || noteWorking) return;
    setNoteWorking(true);
    try {
      await deleteItDutyDayNote(date);
      void message.success(t("dayNote.deleteSuccess", { date }));
      setDayNoteDraft("");
      onDayNoteSaved();
      onClose();
    } catch (error) {
      console.error("[itDuty] delete day note failed", error);
      void message.error(t("errors.deleteFailed"));
    } finally {
      setNoteWorking(false);
    }
  }

  const isExisting = !!existingSwap;
  const isPaired = !!existingSwap?.pairedSwapId;
  const dateLabel = date ? dayjs(date).format("YYYY/MM/DD (ddd)") : "";
  const dayNoteChanged =
    dayNoteDraft.trim() !== (existingDayNote?.note ?? "").trim();

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
              value={swapNote}
              onChange={(e) => setSwapNote(e.target.value)}
              disabled={working}
              maxLength={IT_DUTY_NOTE_MAX_LENGTH}
            />
            <span className="itduty-modal-form__char-counter">
              {swapNote.length} / {IT_DUTY_NOTE_MAX_LENGTH}
            </span>
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

        <hr className="itduty-modal-form__divider" />

        <div className="itduty-modal-form__section-title">
          {t("dayNote.sectionTitle")}
        </div>
        <p className="itduty-modal-form__section-hint">
          {t("dayNote.sectionHint")}
        </p>
        <label className="itduty-modal-form__label">
          {t("dayNote.label")}
          <textarea
            className="itduty-input itduty-input--textarea"
            rows={2}
            placeholder={t("dayNote.placeholder")}
            value={dayNoteDraft}
            onChange={(e) => setDayNoteDraft(e.target.value)}
            disabled={noteWorking}
            maxLength={IT_DUTY_NOTE_MAX_LENGTH}
          />
          <span className="itduty-modal-form__char-counter">
            {dayNoteDraft.length} / {IT_DUTY_NOTE_MAX_LENGTH}
          </span>
        </label>
        <div className="itduty-modal-form__footer">
          {existingDayNote ? (
            <button
              type="button"
              className="itduty-btn itduty-btn--danger"
              onClick={() => void handleDeleteDayNote()}
              disabled={noteWorking}
            >
              {t("dayNote.delete")}
            </button>
          ) : null}
          <div className="itduty-modal-form__footer-spacer" />
          <button
            type="button"
            className="itduty-btn itduty-btn--primary"
            onClick={() => void handleSaveDayNote()}
            disabled={
              noteWorking || !dayNoteDraft.trim() || !dayNoteChanged
            }
          >
            {existingDayNote
              ? t("dayNote.update")
              : t("dayNote.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
