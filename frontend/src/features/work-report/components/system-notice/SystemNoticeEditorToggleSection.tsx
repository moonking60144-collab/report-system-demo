import { useTranslation } from "react-i18next";

interface SystemNoticeEditorToggleSectionProps {
  enabled: boolean;
  forceRefreshAfterSave: boolean;
  maintenanceModeChecked: boolean;
  maintenanceDecision: "auto" | "manual-on" | "manual-off";
  maintenanceSuggestion: { suggested: boolean; reasons: string[] };
  onEnabledChange: (value: boolean) => void;
  onForceRefreshChange: (value: boolean) => void;
  onMaintenanceModeChange: (value: boolean) => void;
  onMaintenanceReset: () => void;
}

export function SystemNoticeEditorToggleSection({
  enabled,
  forceRefreshAfterSave,
  maintenanceModeChecked,
  maintenanceDecision,
  maintenanceSuggestion,
  onEnabledChange,
  onForceRefreshChange,
  onMaintenanceModeChange,
  onMaintenanceReset,
}: SystemNoticeEditorToggleSectionProps) {
  const { t } = useTranslation("workReport");

  return (
    <>
      <label className="system-notice-checkbox">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
        <span>{t("systemNotice.fields.enabled")}</span>
      </label>

      <label className="system-notice-checkbox">
        <input
          type="checkbox"
          checked={forceRefreshAfterSave}
          onChange={(event) => onForceRefreshChange(event.target.checked)}
        />
        <span>{t("systemNotice.fields.forceRefreshAfterSave")}</span>
      </label>

      <label className="system-notice-checkbox">
        <input
          type="checkbox"
          checked={maintenanceModeChecked}
          onChange={(event) => onMaintenanceModeChange(event.target.checked)}
        />
        <span>{t("systemNotice.fields.maintenanceMode")}</span>
      </label>
      <div
        className={`system-notice-maintenance-hint is-${
          maintenanceDecision === "auto"
            ? maintenanceSuggestion.suggested
              ? "suggested"
              : "neutral"
            : maintenanceModeChecked
              ? "manual-on"
              : "manual-off"
        }`}
      >
        <strong>
          {maintenanceDecision === "auto"
            ? maintenanceSuggestion.suggested
              ? t("systemNotice.maintenance.autoDetected")
              : t("systemNotice.maintenance.autoNotDetected")
            : maintenanceModeChecked
              ? t("systemNotice.maintenance.manualEnabled")
              : t("systemNotice.maintenance.manualDisabled")}
        </strong>
        <span>
          {maintenanceDecision === "auto"
            ? maintenanceSuggestion.suggested
              ? t("systemNotice.maintenance.autoDetectedDetail", {
                  reasons: maintenanceSuggestion.reasons.join(" / "),
                })
              : t("systemNotice.maintenance.autoNotDetectedDetail")
            : t("systemNotice.maintenance.manualOverrideDetail")}
        </span>
        {maintenanceDecision !== "auto" ? (
          <button
            type="button"
            className="system-notice-maintenance-reset-btn"
            onClick={() => onMaintenanceReset()}
          >
            {t("systemNotice.maintenance.resetToAuto")}
          </button>
        ) : null}
      </div>
    </>
  );
}
