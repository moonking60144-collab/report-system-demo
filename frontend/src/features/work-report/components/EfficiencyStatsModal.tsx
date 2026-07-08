import { useCallback, useEffect, useState } from "react";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import {
  exportForm16AnalysisXlsx,
  exportForm16DowntimeMonthlyCsv,
} from "../../../api/downtime";
import { CsvIcon, XlsxIcon } from "./ExportFileIcons";
import { getErrorMessage } from "../utils/errorUtils";
import { lastMonthInfo, triggerBlobDownload } from "../utils/exportDownload";
import "./EfficiencyStatsModal.css";

interface EfficiencyStatsModalProps {
  open: boolean;
  onClose: () => void;
}

export function EfficiencyStatsModal({ open, onClose }: EfficiencyStatsModalProps) {
  const { t, i18n } = useTranslation(["workReport"]);
  const [csvExporting, setCsvExporting] = useState(false);
  const [analysisExporting, setAnalysisExporting] = useState(false);
  const [analysisDaysOpen, setAnalysisDaysOpen] = useState(false);
  const [analysisDays, setAnalysisDays] = useState("");
  const today = new Date();
  const statsPeriod = lastMonthInfo(today);
  const statsPeriodFileLabel = statsPeriod.label;
  const statsPeriodWeekdays = statsPeriod.weekdays;
  const statsPeriodLocale = (i18n.resolvedLanguage ?? i18n.language).startsWith("en")
    ? "en-US"
    : "zh-TW";
  const statsPeriodLabel = new Intl.DateTimeFormat(statsPeriodLocale, {
    year: "numeric",
    month: "long",
  }).format(new Date(statsPeriod.year, statsPeriod.month - 1, 1));
  const todayLabel = new Intl.DateTimeFormat(statsPeriodLocale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(today);

  useEffect(() => {
    if (!open) {
      setAnalysisDaysOpen(false);
    }
  }, [open]);

  const handleExportCsv = useCallback(async () => {
    setCsvExporting(true);
    try {
      const blob = await exportForm16DowntimeMonthlyCsv();
      // 後端 proxy 可能回 .csv 或 .xlsx，依實際內容型別決定副檔名
      const isXlsx = blob.type.includes("sheet") || blob.type.includes("excel");
      triggerBlobDownload(blob, `c1-6-${statsPeriodFileLabel}.${isXlsx ? "xlsx" : "csv"}`);
      void message.success(t("workReport:downtimePage.messages.csvExported"));
    } catch (error) {
      void message.error(
        t("workReport:downtimePage.messages.csvExportFailed", {
          error: getErrorMessage(error),
        })
      );
    } finally {
      setCsvExporting(false);
    }
  }, [statsPeriodFileLabel, t]);

  const openAnalysisDaysModal = useCallback(() => {
    setAnalysisDays(String(statsPeriodWeekdays));
    setAnalysisDaysOpen(true);
  }, [statsPeriodWeekdays]);

  const handleCloseMenu = useCallback(() => {
    setAnalysisDaysOpen(false);
    onClose();
  }, [onClose]);

  const handleExportAnalysis = useCallback(async (attendanceDays?: number) => {
    setAnalysisExporting(true);
    try {
      const blob = await exportForm16AnalysisXlsx(attendanceDays);
      triggerBlobDownload(blob, `c1-6-分析表-${statsPeriodFileLabel}.xlsx`);
      void message.success(t("workReport:downtimePage.messages.analysisExported"));
    } catch (error) {
      void message.error(
        t("workReport:downtimePage.messages.analysisExportFailed", {
          error: getErrorMessage(error),
        })
      );
    } finally {
      setAnalysisExporting(false);
    }
  }, [statsPeriodFileLabel, t]);

  const handleConfirmAnalysisExport = useCallback(() => {
    setAnalysisDaysOpen(false);
    onClose();

    const parsed = Number(analysisDays.trim());
    void handleExportAnalysis(
      Number.isFinite(parsed) && parsed > 0 && parsed <= 31 ? parsed : undefined
    );
  }, [analysisDays, handleExportAnalysis, onClose]);

  return (
    <>
      <Modal
        className="efficiency-stats-modal"
        title={
          <div className="efficiency-stats-title">
            <span className="efficiency-stats-title-main">
              {t("workReport:efficiencyStats.title", { periodLabel: statsPeriodLabel })}
            </span>
            <span className="efficiency-stats-title-help">
              {t("workReport:efficiencyStats.titleHelp", { todayLabel })}
            </span>
          </div>
        }
        open={open && !analysisDaysOpen}
        onCancel={handleCloseMenu}
        footer={null}
        width={420}
      >
        <div className="efficiency-stats-menu">
          <button
            type="button"
            className="efficiency-stats-row"
            onClick={() => void handleExportCsv()}
            disabled={csvExporting}
          >
            <CsvIcon size="1.7em" />
            <span className="efficiency-stats-copy">
              <span className="efficiency-stats-row-label">
                {csvExporting
                  ? t("workReport:downtimePage.actions.exporting")
                  : t("workReport:efficiencyStats.csvButton")}
              </span>
              <span className="efficiency-stats-row-help">
                {t("workReport:efficiencyStats.csvHelp")}
              </span>
            </span>
          </button>
          <button
            type="button"
            className="efficiency-stats-row"
            onClick={openAnalysisDaysModal}
            disabled={analysisExporting}
          >
            <XlsxIcon size="1.7em" />
            <span className="efficiency-stats-copy">
              <span className="efficiency-stats-row-label">
                {analysisExporting
                  ? t("workReport:downtimePage.actions.exporting")
                  : t("workReport:efficiencyStats.analysisButton")}
              </span>
              <span className="efficiency-stats-row-help">
                {t("workReport:efficiencyStats.analysisHelp")}
              </span>
            </span>
          </button>
        </div>
      </Modal>

      <Modal
        className="efficiency-analysis-days-modal"
        title={t("workReport:downtimePage.analysisModal.title")}
        open={open && analysisDaysOpen}
        okText={t("workReport:downtimePage.analysisModal.ok")}
        cancelText={t("workReport:downtimePage.analysisModal.cancel")}
        onOk={handleConfirmAnalysisExport}
        onCancel={() => setAnalysisDaysOpen(false)}
        confirmLoading={analysisExporting}
      >
        <div className="efficiency-analysis-days-field">
          <label htmlFor="efficiency-analysis-days">
            {t("workReport:downtimePage.analysisModal.daysLabel")}
          </label>
          <input
            id="efficiency-analysis-days"
            type="number"
            min={1}
            max={31}
            step={0.5}
            value={analysisDays}
            onChange={(event) => setAnalysisDays(event.target.value)}
          />
        </div>
      </Modal>
    </>
  );
}
