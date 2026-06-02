import { useEffect, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import {
  deleteItDutyOverride,
  upsertItDutyOverride,
  type ItDutyMember,
  type ItDutyOverride,
} from "../../../api/itDuty";

interface Props {
  open: boolean;
  isoWeek: string | null;
  members: ItDutyMember[];
  currentOverride: ItDutyOverride | null;
  defaultMemberId: number | null;
  onClose: () => void;
  onSaved: () => void;
}

export function ItDutyAssignWeekModal({
  open,
  isoWeek,
  members,
  currentOverride,
  defaultMemberId,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation("itDuty");
  const [selectedMemberId, setSelectedMemberId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [propagateForward, setPropagateForward] = useState(true);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedMemberId(currentOverride?.memberId ?? defaultMemberId ?? null);
      setNote(currentOverride?.note ?? "");
      // 既有 override 維持原值；新建 override 預設 propagate=true
      setPropagateForward(currentOverride?.propagateForward ?? true);
    }
  }, [open, currentOverride, defaultMemberId]);

  async function handleSave() {
    if (!isoWeek || selectedMemberId === null || working) return;
    setWorking(true);
    try {
      await upsertItDutyOverride(isoWeek, {
        memberId: selectedMemberId,
        note: note.trim() ? note.trim() : null,
        propagateForward,
      });
      const member = members.find((m) => m.id === selectedMemberId);
      void message.success(
        t("assignModal.saveSuccess", { isoWeek, name: member?.name ?? "" })
      );
      onSaved();
      onClose();
    } catch (error) {
      console.error("[itDuty] save override failed", error);
      void message.error(t("errors.saveFailed"));
    } finally {
      setWorking(false);
    }
  }

  async function handleClearOverride() {
    if (!isoWeek || !currentOverride || working) return;
    setWorking(true);
    try {
      await deleteItDutyOverride(isoWeek);
      void message.success(t("assignModal.clearSuccess", { isoWeek }));
      onSaved();
      onClose();
    } catch (error) {
      console.error("[itDuty] clear override failed", error);
      void message.error(t("errors.deleteFailed"));
    } finally {
      setWorking(false);
    }
  }

  const activeMembers = members.filter(
    (m) => m.active || m.id === currentOverride?.memberId
  );

  return (
    <Modal
      open={open && !!isoWeek}
      title={t("assignModal.title", { isoWeek: isoWeek ?? "" })}
      onCancel={onClose}
      footer={null}
      width={460}
    >
      <div className="itduty-modal-form">
        <label className="itduty-modal-form__label">
          {t("assignModal.member")}
          <select
            className="itduty-input"
            value={selectedMemberId ?? ""}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSelectedMemberId(Number.isFinite(v) && v > 0 ? v : null);
            }}
            disabled={working}
          >
            {activeMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {!m.active ? ` (${t("memberManager.inactiveTag")})` : ""}
              </option>
            ))}
          </select>
        </label>

        <fieldset
          className="itduty-modal-form__scope"
          disabled={working}
        >
          <legend className="itduty-modal-form__scope-legend">
            {t("assignModal.scopeLabel")}
          </legend>
          <label className="itduty-modal-form__scope-option">
            <input
              type="radio"
              name="itduty-scope"
              checked={propagateForward}
              onChange={() => setPropagateForward(true)}
            />
            <span className="itduty-modal-form__scope-text">
              <span className="itduty-modal-form__scope-title">
                {t("assignModal.scopePropagateLabel")}
              </span>
              <span className="itduty-modal-form__scope-hint">
                {t("assignModal.scopePropagateHint")}
              </span>
            </span>
          </label>
          <label className="itduty-modal-form__scope-option">
            <input
              type="radio"
              name="itduty-scope"
              checked={!propagateForward}
              onChange={() => setPropagateForward(false)}
            />
            <span className="itduty-modal-form__scope-text">
              <span className="itduty-modal-form__scope-title">
                {t("assignModal.scopePatchLabel")}
              </span>
              <span className="itduty-modal-form__scope-hint">
                {t("assignModal.scopePatchHint")}
              </span>
            </span>
          </label>
        </fieldset>

        <label className="itduty-modal-form__label">
          {t("assignModal.note")}
          <textarea
            className="itduty-input itduty-input--textarea"
            rows={2}
            placeholder={t("assignModal.notePlaceholder")}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={working}
            maxLength={200}
          />
        </label>

        <div className="itduty-modal-form__footer">
          {currentOverride ? (
            <button
              type="button"
              className="itduty-btn itduty-btn--ghost"
              onClick={() => void handleClearOverride()}
              disabled={working}
            >
              {t("assignModal.clearOverride")}
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
          <button
            type="button"
            className="itduty-btn itduty-btn--primary"
            onClick={() => void handleSave()}
            disabled={selectedMemberId === null || working}
          >
            {t("assignModal.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
