import type { Dispatch, RefObject, SetStateAction } from "react";
import type { SystemNoticeLevel } from "../../../../api/systemNotice";
import { SystemNoticeEditorActionButtons } from "./SystemNoticeEditorActionButtons";
import { SystemNoticeEditorBasicFields } from "./SystemNoticeEditorBasicFields";
import { SystemNoticeEditorDateTimeSection } from "./SystemNoticeEditorDateTimeSection";
import { SystemNoticeEditorLinkSection } from "./SystemNoticeEditorLinkSection";
import { SystemNoticeEditorToggleSection } from "./SystemNoticeEditorToggleSection";

interface NoticeDraft {
  enabled: boolean;
  level: SystemNoticeLevel;
  title: string;
  message: string;
  maintenanceDecision: "auto" | "manual-on" | "manual-off";
  startAtInput: string;
  endAtInput: string;
  linkText: string;
  linkUrl: string;
  forceRefreshAfterSave: boolean;
}

interface MaintenanceSuggestion {
  suggested: boolean;
  reasons: string[];
}

interface SystemNoticeEditorFormHandlers {
  setDraft: Dispatch<SetStateAction<NoticeDraft>>;
  openDateTimePicker: (field: "startAtInput" | "endAtInput") => void;
  handleDateTimePickerChange: (
    field: "startAtInput" | "endAtInput",
    rawValue: string
  ) => void;
  normalizeDateTimeInput: (field: "startAtInput" | "endAtInput", rawValue: string) => string;
  resetMaintenanceDecision: () => void;
  setForceRefreshAfterSave: (checked: boolean) => void;
  onSave: () => void;
  onLogout: () => void;
}

interface SystemNoticeEditorFormDateTimeRefs {
  startAtPickerInputRef: RefObject<HTMLInputElement | null>;
  endAtPickerInputRef: RefObject<HTMLInputElement | null>;
}

interface SystemNoticeEditorFormDateTimeState {
  startAtPickerValue: string;
  endAtPickerValue: string;
  dateTimeInputError: string | null;
  saveError: string | null;
  saveNotice: string | null;
  saving: boolean;
}

interface SystemNoticeEditorFormProps {
  draft: NoticeDraft;
  maintenanceSuggestion: MaintenanceSuggestion;
  maintenanceModeChecked: boolean;
  dateTimeState: SystemNoticeEditorFormDateTimeState;
  dateTimeRefs: SystemNoticeEditorFormDateTimeRefs;
  handlers: SystemNoticeEditorFormHandlers;
}

export function SystemNoticeEditorForm({
  draft,
  maintenanceSuggestion,
  maintenanceModeChecked,
  dateTimeState,
  dateTimeRefs,
  handlers,
}: SystemNoticeEditorFormProps) {
  const {
    startAtPickerValue,
    endAtPickerValue,
    dateTimeInputError,
    saveError,
    saveNotice,
    saving,
  } = dateTimeState;
  const { startAtPickerInputRef, endAtPickerInputRef } = dateTimeRefs;
  const {
    setDraft,
    openDateTimePicker,
    handleDateTimePickerChange,
    normalizeDateTimeInput,
    resetMaintenanceDecision,
    setForceRefreshAfterSave,
    onSave,
    onLogout,
  } = handlers;

  return (
    <div className="system-notice-editor">
      <div className="system-notice-edit-form">
        <SystemNoticeEditorToggleSection
          enabled={draft.enabled}
          forceRefreshAfterSave={draft.forceRefreshAfterSave}
          maintenanceModeChecked={maintenanceModeChecked}
          maintenanceDecision={draft.maintenanceDecision}
          maintenanceSuggestion={maintenanceSuggestion}
          onEnabledChange={(checked) =>
            setDraft((prev) => ({ ...prev, enabled: checked }))
          }
          onForceRefreshChange={setForceRefreshAfterSave}
          onMaintenanceModeChange={(checked) =>
            setDraft((prev) => ({
              ...prev,
              maintenanceDecision: checked ? "manual-on" : "manual-off",
            }))
          }
          onMaintenanceReset={() => {
            resetMaintenanceDecision();
          }}
        />

        <SystemNoticeEditorBasicFields
          level={draft.level}
          title={draft.title}
          message={draft.message}
          onLevelChange={(value) => setDraft((prev) => ({ ...prev, level: value }))}
          onTitleChange={(value) => setDraft((prev) => ({ ...prev, title: value }))}
          onMessageChange={(value) =>
            setDraft((prev) => ({ ...prev, message: value }))
          }
        />

        <SystemNoticeEditorDateTimeSection
          startAtInput={draft.startAtInput}
          endAtInput={draft.endAtInput}
          startAtPickerValue={startAtPickerValue}
          endAtPickerValue={endAtPickerValue}
          dateTimeInputError={dateTimeInputError}
          startAtPickerInputRef={startAtPickerInputRef}
          endAtPickerInputRef={endAtPickerInputRef}
          onOpenDateTimePicker={openDateTimePicker}
          onDateTimePickerChange={handleDateTimePickerChange}
          onDateTimeInputChange={(field, value) =>
            setDraft((prev) => ({ ...prev, [field]: value }))
          }
          onDateTimeInputBlur={(field, value) => normalizeDateTimeInput(field, value)}
        />

        <SystemNoticeEditorLinkSection
          linkText={draft.linkText}
          linkUrl={draft.linkUrl}
          onLinkTextChange={(value) =>
            setDraft((prev) => ({ ...prev, linkText: value }))
          }
          onLinkUrlChange={(value) => setDraft((prev) => ({ ...prev, linkUrl: value }))}
        />

        <SystemNoticeEditorActionButtons
          saveError={saveError}
          saveNotice={saveNotice}
          saving={saving}
          onSave={onSave}
          onLogout={onLogout}
        />
      </div>
    </div>
  );
}
