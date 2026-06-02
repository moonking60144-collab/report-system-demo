import { useMemo } from "react";
import { Select } from "antd";
import { useTranslation } from "react-i18next";
import { SearchableSelect } from "../../../components/SearchableSelect";
import { FIXED_FILTER_PRESETS, FIXED_FILTER_PRESET_IDS_BY_FORM } from "../constants";
import type { FixedFilterPresetId, WorkReportLocalPreferences } from "../types";

interface WorkReportLocalSettingsPanelProps {
  value: WorkReportLocalPreferences;
  onChange: (next: WorkReportLocalPreferences) => void;
  onSave: () => void;
  onBackToReport: () => void;
}

function getPresetI18nKey(presetId: FixedFilterPresetId): string {
  switch (presetId) {
    case "all-data":
      return "allData";
    case "unfinished-runnable":
      return "unfinishedRunnable";
    case "unfinished-orders":
      return "unfinishedOrders";
    case "finished-orders":
      return "finishedOrders";
    default:
      return "allData";
  }
}

export function WorkReportLocalSettingsPanel({
  value,
  onChange,
  onSave,
  onBackToReport,
}: WorkReportLocalSettingsPanelProps) {
  const { t } = useTranslation(["workReport", "common"]);

  const allFixedPresetOptions = useMemo(
    () =>
      FIXED_FILTER_PRESETS.map((preset) => {
        const key = getPresetI18nKey(preset.id);
        return {
          value: preset.id,
          label: t(`workReport:sidebar.presets.${key}.label`),
          display: t(`workReport:sidebar.presets.${key}.description`),
        };
      }),
    [t]
  );

  const fixedPresetOptions104 = useMemo(
    () =>
      allFixedPresetOptions.filter((option) =>
        FIXED_FILTER_PRESET_IDS_BY_FORM["104"].includes(option.value as FixedFilterPresetId)
      ),
    [allFixedPresetOptions]
  );

  const fixedPresetOptions105 = useMemo(
    () =>
      allFixedPresetOptions.filter((option) =>
        FIXED_FILTER_PRESET_IDS_BY_FORM["105"].includes(option.value as FixedFilterPresetId)
      ),
    [allFixedPresetOptions]
  );

  const hideTestCustomerPartOptions = useMemo(
    () => [
      {
        value: "hide",
        label: t("workReport:localSettings.options.hideTestCustomerPartEnabled"),
        display: t("workReport:localSettings.options.hideTestCustomerPartEnabled"),
      },
      {
        value: "show",
        label: t("workReport:localSettings.options.hideTestCustomerPartDisabled"),
        display: t("workReport:localSettings.options.hideTestCustomerPartDisabled"),
      },
    ],
    [t]
  );

  return (
    <section className="local-settings-panel" aria-labelledby="local-settings-title">
      <div className="local-settings-panel-header">
        <div>
          <h2 id="local-settings-title">{t("workReport:localSettings.title")}</h2>
          <p>{t("workReport:localSettings.subtitle")}</p>
        </div>
        <button type="button" className="toolbar-btn toolbar-btn--secondary" onClick={onBackToReport}>
          {t("workReport:localSettings.backToReport")}
        </button>
      </div>

      <div className="local-settings-card">
        <div className="local-settings-grid">
          <label className="local-settings-field">
            <span>{t("workReport:localSettings.fields.defaultLandingPage")}</span>
            <Select
              value={value.defaultLandingPageKey}
              options={[
                {
                  value: "thread-rolling-104",
                  label: t("workReport:page.views.threadRolling104"),
                },
                {
                  value: "heading-105",
                  label: t("workReport:page.views.heading105"),
                },
              ]}
              onChange={(nextValue) =>
                onChange({
                  ...value,
                  defaultLandingPageKey: String(nextValue) as WorkReportLocalPreferences["defaultLandingPageKey"],
                })
              }
            />
            <small>{t("workReport:localSettings.hints.landingPage")}</small>
          </label>

          <label className="local-settings-field">
            <span>{t("workReport:localSettings.fields.defaultFixedPreset104")}</span>
            <SearchableSelect
              value={value.defaultFixedPresetId104}
              options={fixedPresetOptions104}
              searchable={false}
              clearable={false}
              labelMode="value-display"
              onChange={(nextValue) =>
                onChange({
                  ...value,
                  defaultFixedPresetId104: nextValue as FixedFilterPresetId,
                })
              }
            />
            <small>{t("workReport:localSettings.hints.fixedPreset104")}</small>
          </label>

          <label className="local-settings-field">
            <span>{t("workReport:localSettings.fields.defaultFixedPreset105")}</span>
            <SearchableSelect
              value={value.defaultFixedPresetId105}
              options={fixedPresetOptions105}
              searchable={false}
              clearable={false}
              labelMode="value-display"
              onChange={(nextValue) =>
                onChange({
                  ...value,
                  defaultFixedPresetId105: nextValue as FixedFilterPresetId,
                })
              }
            />
            <small>{t("workReport:localSettings.hints.fixedPreset105")}</small>
          </label>

          <label className="local-settings-field">
            <span>{t("workReport:localSettings.fields.hideTestCustomerPartRecords")}</span>
            <SearchableSelect
              value={value.hideTestCustomerPartRecords ? "hide" : "show"}
              options={hideTestCustomerPartOptions}
              searchable={false}
              clearable={false}
              labelMode="value-display"
              onChange={(nextValue) =>
                onChange({
                  ...value,
                  hideTestCustomerPartRecords: nextValue === "hide",
                })
              }
            />
            <small>{t("workReport:localSettings.hints.hideTestCustomerPartRecords")}</small>
          </label>
        </div>

        <div className="local-settings-note">
          <strong>{t("workReport:localSettings.noteTitle")}</strong>
          <p>{t("workReport:localSettings.noteBody")}</p>
        </div>

        <div className="local-settings-actions">
          <button type="button" className="toolbar-btn toolbar-btn--secondary" onClick={onBackToReport}>
            {t("common:actions.cancel")}
          </button>
          <button type="button" className="toolbar-btn toolbar-btn--primary" onClick={onSave}>
            {t("common:actions.save")}
          </button>
        </div>
      </div>
    </section>
  );
}
