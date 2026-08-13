import { useCallback, useEffect, useState } from "react";
import { DownloadOutlined, HistoryOutlined } from "@ant-design/icons";
import { Modal, message } from "antd";
import { useTranslation } from "react-i18next";
import {
  exportForm16AnalysisXlsx,
  exportForm16DowntimeMonthlyCsv,
  fetchEfficiencyReportHistory,
  downloadEfficiencyReportCsv,
  downloadEfficiencyReportXlsx,
  type EfficiencyReportSnapshot,
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<EfficiencyReportSnapshot[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyDownloadingKey, setHistoryDownloadingKey] = useState<string | null>(null);
  const exportInProgress = csvExporting || analysisExporting;
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
      setHistoryOpen(false);
    }
  }, [open]);

  const handleExportCsv = useCallback(async () => {
    setCsvExporting(true);
    try {
      const download = await exportForm16DowntimeMonthlyCsv();
      // 後端 proxy 可能回 .csv 或 .xlsx，依實際內容型別決定副檔名
      const isXlsx = download.blob.type.includes("sheet") || download.blob.type.includes("excel");
      triggerBlobDownload(
        download.blob,
        download.filename ?? `c1-6-${statsPeriodFileLabel}.${isXlsx ? "xlsx" : "csv"}`
      );
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
    setHistoryOpen(false);
    onClose();
  }, [onClose]);

  const handleExportAnalysis = useCallback(async (attendanceDays?: number) => {
    setAnalysisExporting(true);
    try {
      const download = await exportForm16AnalysisXlsx(attendanceDays);
      triggerBlobDownload(
        download.blob,
        download.filename ?? `c1-6-分析表-${statsPeriodFileLabel}.xlsx`
      );
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

  const loadHistory = useCallback(
    async (reset: boolean) => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const offset = reset ? 0 : historyRecords.length;
        const result = await fetchEfficiencyReportHistory(20, offset);
        setHistoryRecords((current) => (reset ? result.records : [...current, ...result.records]));
        setHistoryHasMore(result.meta.hasMore);
      } catch (error) {
        setHistoryError(getErrorMessage(error));
      } finally {
        setHistoryLoading(false);
      }
    },
    [historyRecords.length]
  );

  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    void loadHistory(true);
  }, [loadHistory]);

  const handleDownloadStoredCsv = useCallback(
    async (snapshot: EfficiencyReportSnapshot) => {
      const key = `csv:${snapshot.id}`;
      setHistoryDownloadingKey(key);
      try {
        const download = await downloadEfficiencyReportCsv(snapshot.id);
        triggerBlobDownload(
          download.blob,
          download.filename ?? `c1-6-${snapshot.periodMonth}-v${snapshot.version}.csv`
        );
      } catch (error) {
        void message.error(
          t("workReport:efficiencyStats.historyDownloadFailed", {
            error: getErrorMessage(error),
          })
        );
      } finally {
        setHistoryDownloadingKey(null);
      }
    },
    [t]
  );

  const handleDownloadStoredXlsx = useCallback(
    async (snapshot: EfficiencyReportSnapshot, artifactId: string, attendanceDays: number | null) => {
      const key = `xlsx:${artifactId}`;
      setHistoryDownloadingKey(key);
      try {
        const download = await downloadEfficiencyReportXlsx(snapshot.id, artifactId);
        const days = attendanceDays === null ? "default" : String(attendanceDays).replace(".", "_");
        triggerBlobDownload(
          download.blob,
          download.filename ??
            `c1-6-analysis-${snapshot.periodMonth}-v${snapshot.version}-days-${days}.xlsx`
        );
      } catch (error) {
        void message.error(
          t("workReport:efficiencyStats.historyDownloadFailed", {
            error: getErrorMessage(error),
          })
        );
      } finally {
        setHistoryDownloadingKey(null);
      }
    },
    [t]
  );

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
        open={open && !analysisDaysOpen && !historyOpen}
        onCancel={handleCloseMenu}
        footer={null}
        width={420}
      >
        <div className="efficiency-stats-menu">
          <button
            type="button"
            className="efficiency-stats-row"
            onClick={() => void handleExportCsv()}
            disabled={exportInProgress}
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
            disabled={exportInProgress}
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
          <button
            type="button"
            className="efficiency-stats-row"
            onClick={openHistory}
            disabled={exportInProgress}
          >
            <HistoryOutlined className="efficiency-stats-history-icon" />
            <span className="efficiency-stats-copy">
              <span className="efficiency-stats-row-label">
                {t("workReport:efficiencyStats.historyButton")}
              </span>
              <span className="efficiency-stats-row-help">
                {t("workReport:efficiencyStats.historyHelp")}
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

      <Modal
        className="efficiency-history-modal"
        title={t("workReport:efficiencyStats.historyTitle")}
        open={open && historyOpen}
        onCancel={() => setHistoryOpen(false)}
        footer={null}
        width={560}
      >
        <div className="efficiency-history-content">
          {historyLoading && historyRecords.length === 0 ? (
            <div className="efficiency-history-state">
              {t("workReport:efficiencyStats.historyLoading")}
            </div>
          ) : null}
          {historyError ? (
            <div className="efficiency-history-error">
              <span>{historyError}</span>
              <button type="button" onClick={() => void loadHistory(true)}>
                {t("workReport:efficiencyStats.historyRetry")}
              </button>
            </div>
          ) : null}
          {!historyLoading && !historyError && historyRecords.length === 0 ? (
            <div className="efficiency-history-state">
              {t("workReport:efficiencyStats.historyEmpty")}
            </div>
          ) : null}
          <div className="efficiency-history-list">
            {historyRecords.map((snapshot) => (
              <section className="efficiency-history-item" key={snapshot.id}>
                <div className="efficiency-history-item-heading">
                  <div>
                    <strong>{snapshot.periodMonth}</strong>
                    <span>v{snapshot.version}</span>
                  </div>
                  <span className="efficiency-history-status">
                    {snapshot.status === "finalized"
                      ? t("workReport:efficiencyStats.historyFinalized")
                      : t("workReport:efficiencyStats.historyArchived")}
                  </span>
                </div>
                <div className="efficiency-history-meta">
                  <span>
                    {t("workReport:efficiencyStats.historyRows", {
                      count: snapshot.sourceRowCount,
                    })}
                  </span>
                  <span>{new Date(snapshot.createdAt).toLocaleString(statsPeriodLocale)}</span>
                </div>
                <div className="efficiency-history-actions">
                  <button
                    type="button"
                    disabled={historyDownloadingKey !== null}
                    onClick={() => void handleDownloadStoredCsv(snapshot)}
                  >
                    <DownloadOutlined />
                    {t("workReport:efficiencyStats.historyCsv")}
                  </button>
                  {snapshot.artifacts.map((artifact) => (
                    <button
                      type="button"
                      key={artifact.id}
                      disabled={historyDownloadingKey !== null}
                      onClick={() =>
                        void handleDownloadStoredXlsx(
                          snapshot,
                          artifact.id,
                          artifact.attendanceDays
                        )
                      }
                    >
                      <DownloadOutlined />
                      {t("workReport:efficiencyStats.historyXlsx", {
                        days: artifact.attendanceDays ?? "—",
                      })}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {historyHasMore ? (
            <button
              type="button"
              className="efficiency-history-more"
              disabled={historyLoading}
              onClick={() => void loadHistory(false)}
            >
              {historyLoading
                ? t("workReport:efficiencyStats.historyLoading")
                : t("workReport:efficiencyStats.historyMore")}
            </button>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
