import { useMemo } from "react";
import { Select } from "antd";
import { useTranslation } from "react-i18next";
import { SearchableSelect } from "../../../components/SearchableSelect";
import { FIXED_FILTER_PRESETS, FIXED_FILTER_PRESET_IDS_BY_FORM } from "../constants";
import type { FixedFilterPresetId, WorkReportLocalPreferences } from "../types";

interface WorkReportLocalSettingsPanelProps {
  value: WorkReportLocalPreferences;
  deviceLabel: string;
  onChange: (next: WorkReportLocalPreferences) => void;
  onDeviceLabelChange: (next: string) => void;
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
  deviceLabel,
  onChange,
  onDeviceLabelChange,
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

  const fixedPresetOptions901 = useMemo(
    () =>
      allFixedPresetOptions.filter((option) =>
        FIXED_FILTER_PRESET_IDS_BY_FORM["901"].includes(option.value as FixedFilterPresetId)
      ),
    [allFixedPresetOptions]
  );

  const fixedPresetOptions902 = useMemo(
    () =>
      allFixedPresetOptions.filter((option) =>
        FIXED_FILTER_PRESET_IDS_BY_FORM["902"].includes(option.value as FixedFilterPresetId)
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

  const hideSortOrder99Options = useMemo(
    () => [
      {
        value: "hide",
        label: t("workReport:localSettings.options.hideSortOrder99Enabled"),
        display: t("workReport:localSettings.options.hideSortOrder99Enabled"),
      },
      {
        value: "show",
        label: t("workReport:localSettings.options.hideSortOrder99Disabled"),
        display: t("workReport:localSettings.options.hideSortOrder99Disabled"),
      },
    ],
    [t]
  );

  const listScrollHintOptions = useMemo(
    () => [
      {
        value: "show",
        label: t("workReport:localSettings.options.showListScrollHintEnabled"),
        display: t("workReport:localSettings.options.showListScrollHintEnabled"),
      },
      {
        value: "hide",
        label: t("workReport:localSettings.options.showListScrollHintDisabled"),
        display: t("workReport:localSettings.options.showListScrollHintDisabled"),
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
            <span>{t("workReport:localSettings.fields.deviceLabel")}</span>
            <input
              type="text"
              value={deviceLabel}
              maxLength={60}
              autoComplete="off"
              placeholder={t("workReport:localSettings.placeholders.deviceLabel")}
              onChange={(event) => onDeviceLabelChange(event.target.value)}
            />
            <small>{t("workReport:localSettings.hints.deviceLabel")}</small>
          </label>

          <label className="local-settings-field">
            <span>{t("workReport:localSettings.fields.defaultLandingPage")}</span>
            <Select
              value={value.defaultLandingPageKey}
              options={[
                {
                  value: "line-a-901",
                  label: t("workReport:page.views.lineA901"),
                },
                {
                  value: "line-b-902",
                  label: t("workReport:page.views.lineB902"),
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
            <span>{t("workReport:localSettings.fields.defaultFixedPreset901")}</span>
            <SearchableSelect
              value={value.defaultFixedPresetId901}
              options={fixedPresetOptions901}
              searchable={false}
              clearable={false}
              labelMode="value-display"
              onChange={(nextValue) =>
                onChange({
                  ...value,
                  defaultFixedPresetId901: nextValue as FixedFilterPresetId,
                })
              }
            />
            <small>{t("workReport:localSettings.hints.fixedPreset901")}</small>
          </label>

          <label className="local-settings-field">
            <span>{t("workReport:localSettings.fields.defaultFixedPreset902")}</span>
            <SearchableSelect
              value={value.defaultFixedPresetId902}
              options={fixedPresetOptions902}
              searchable={false}
              clearable={false}
              labelMode="value-display"
              onChange={(nextValue) =>
                onChange({
                  ...value,
                  defaultFixedPresetId902: nextValue as FixedFilterPresetId,
                })
              }
            />
            <small>{t("workReport:localSettings.hints.fixedPreset902")}</small>
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

          <label className="local-settings-field">
            <span>{t("workReport:localSettings.fields.hideSortOrder99Records")}</span>
            <SearchableSelect
              value={value.hideSortOrder99Records ? "hide" : "show"}
              options={hideSortOrder99Options}
              searchable={false}
              clearable={false}
              labelMode="value-display"
              onChange={(nextValue) =>
                onChange({
                  ...value,
                  hideSortOrder99Records: nextValue === "hide",
                })
              }
            />
            <small>{t("workReport:localSettings.hints.hideSortOrder99Records")}</small>
          </label>

          <label className="local-settings-field">
            <span>{t("workReport:localSettings.fields.showListScrollHintButton")}</span>
            <SearchableSelect
              value={value.showListScrollHintButton ? "show" : "hide"}
              options={listScrollHintOptions}
              searchable={false}
              clearable={false}
              labelMode="value-display"
              onChange={(nextValue) =>
                onChange({
                  ...value,
                  showListScrollHintButton: nextValue === "show",
                })
              }
            />
            <small>{t("workReport:localSettings.hints.showListScrollHintButton")}</small>
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
