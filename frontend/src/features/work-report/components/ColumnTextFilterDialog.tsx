import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import { COLUMN_TEXT_FILTER_MAX_LENGTH } from "../constants";
import type { ColumnTextFilterDialogState, UiLanguage } from "../types";

interface ColumnTextFilterDialogProps {
  uiLanguage: UiLanguage;
  state: ColumnTextFilterDialogState;
  onCancel: () => void;
  onConfirm: () => void;
  onChangeDraft: (value: string) => void;
}

export function ColumnTextFilterDialog({
  uiLanguage,
  state,
  onCancel,
  onConfirm,
  onChangeDraft,
}: ColumnTextFilterDialogProps) {
  void uiLanguage;
  const { t } = useTranslation(["workReport", "common"]);

  return (
    <Modal
      title={t("workReport:textFilter.title")}
      open={state.open}
      zIndex={1600}
      onCancel={onCancel}
      onOk={onConfirm}
      okText={t("common:actions.confirm")}
      cancelText={t("common:actions.cancel")}
      destroyOnHidden
    >
      <div className="column-text-filter-dialog">
        <div className="column-text-filter-dialog-label">
          {state.columnLabel
            ? t("workReport:textFilter.promptWithColumn", { columnLabel: state.columnLabel })
            : t("workReport:textFilter.promptGeneric")}
        </div>
        <input
          className="column-menu-search"
          type="text"
          autoFocus
          maxLength={COLUMN_TEXT_FILTER_MAX_LENGTH}
          value={state.draftValue}
          onChange={(event) => onChangeDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onConfirm();
            }
          }}
          placeholder={t("workReport:textFilter.placeholder")}
        />
        <div className="column-text-filter-dialog-help">
          {t("workReport:textFilter.help", { max: COLUMN_TEXT_FILTER_MAX_LENGTH })}
        </div>
      </div>
    </Modal>
  );
}
