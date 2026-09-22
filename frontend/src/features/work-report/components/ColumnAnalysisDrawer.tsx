import { Drawer } from "antd";
import { useTranslation } from "react-i18next";
import type {
  ColumnAnalysisState,
  ColumnAnalysisSummary,
  ColumnDataType,
  UiLanguage,
} from "../types";

interface ColumnAnalysisDrawerProps {
  uiLanguage: UiLanguage;
  state: ColumnAnalysisState;
  label: string;
  targetColumnType: ColumnDataType | null;
  shouldUseFullHydrationForList: boolean;
  hasHydratedAllRecords: boolean;
  isHydratingAllRecords: boolean;
  summary: ColumnAnalysisSummary | null;
  onClose: () => void;
}

export function ColumnAnalysisDrawer({
  uiLanguage,
  state,
  label,
  targetColumnType,
  shouldUseFullHydrationForList,
  hasHydratedAllRecords,
  isHydratingAllRecords,
  summary,
  onClose,
}: ColumnAnalysisDrawerProps) {
  void uiLanguage;
  const { t, i18n } = useTranslation(["workReport", "common"]);
  const numberLocale = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith("en")
    ? "en-US"
    : "zh-TW";

  return (
    <Drawer
      title={t("workReport:analysis.title", { label: label || "-" })}
      placement="right"
      width={420}
      zIndex={1500}
      open={state.open}
      onClose={onClose}
      className="column-analysis-drawer"
    >
      <div className="column-analysis-panel">
        {!state.columnKey && (
          <p className="state">{t("workReport:analysis.openFromColumnMenu")}</p>
        )}

        {state.columnKey && shouldUseFullHydrationForList && !hasHydratedAllRecords && isHydratingAllRecords && (
          <p className="state">{t("workReport:analysis.preparing")}</p>
        )}

        {state.columnKey && (!shouldUseFullHydrationForList || hasHydratedAllRecords) && summary && (
          <>
            <div className="column-analysis-meta">
              <div>
                <span>{t("workReport:analysis.columnType")}</span>
                <strong>
                  {targetColumnType === "number"
                    ? t("workReport:analysis.typeNumber")
                    : targetColumnType === "date"
                      ? t("workReport:analysis.typeDate")
                      : targetColumnType === "boolean"
                        ? t("workReport:analysis.typeBoolean")
                        : t("workReport:analysis.typeText")}
                </strong>
              </div>
              <div>
                <span>{t("workReport:analysis.totalRows")}</span>
                <strong>{summary.totalCount}</strong>
              </div>
              <div>
                <span>{t("workReport:analysis.nonEmpty")}</span>
                <strong>{summary.nonEmptyCount}</strong>
              </div>
              <div>
                <span>{t("workReport:analysis.blankRows")}</span>
                <strong>{summary.blankCount}</strong>
              </div>
              <div>
                <span>{t("workReport:analysis.distinct")}</span>
                <strong>{summary.distinctCount}</strong>
              </div>
            </div>

            {summary.numberStats && (
              <section className="column-analysis-block">
                <h3>{t("workReport:analysis.numericStats")}</h3>
                <div className="column-analysis-kv">
                  <div><span>{t("workReport:analysis.count")}</span><strong>{summary.numberStats.count}</strong></div>
                  <div><span>{t("workReport:analysis.sum")}</span><strong>{summary.numberStats.sum.toLocaleString(numberLocale)}</strong></div>
                  <div>
                    <span>{t("workReport:analysis.average")}</span>
                    <strong>{summary.numberStats.avg.toLocaleString(numberLocale, { maximumFractionDigits: 2 })}</strong>
                  </div>
                  <div><span>{t("workReport:analysis.min")}</span><strong>{summary.numberStats.min.toLocaleString(numberLocale)}</strong></div>
                  <div><span>{t("workReport:analysis.max")}</span><strong>{summary.numberStats.max.toLocaleString(numberLocale)}</strong></div>
                </div>
              </section>
            )}

            {summary.dateStats && (
              <section className="column-analysis-block">
                <h3>{t("workReport:analysis.dateStats")}</h3>
                <div className="column-analysis-kv">
                  <div><span>{t("workReport:analysis.count")}</span><strong>{summary.dateStats.count}</strong></div>
                  <div><span>{t("workReport:analysis.earliest")}</span><strong>{summary.dateStats.earliest ?? "-"}</strong></div>
                  <div><span>{t("workReport:analysis.latest")}</span><strong>{summary.dateStats.latest ?? "-"}</strong></div>
                </div>
              </section>
            )}

            {summary.booleanStats && (
              <section className="column-analysis-block">
                <h3>{t("workReport:analysis.booleanStats")}</h3>
                <div className="column-analysis-kv">
                  <div><span>{t("common:yesNo.yes")}</span><strong>{summary.booleanStats.yes}</strong></div>
                  <div><span>{t("common:yesNo.no")}</span><strong>{summary.booleanStats.no}</strong></div>
                  <div><span>{t("common:yesNo.blank")}</span><strong>{summary.booleanStats.blank}</strong></div>
                </div>
              </section>
            )}

            {summary.topValues && summary.topValues.length > 0 && (
              <section className="column-analysis-block">
                <h3>{t("workReport:analysis.topValues")}</h3>
                <ul className="column-analysis-list">
                  {summary.topValues.map((item) => (
                    <li key={`${item.label}-${item.count}`}>
                      <span>{item.label}</span>
                      <strong>{item.count}</strong>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}
