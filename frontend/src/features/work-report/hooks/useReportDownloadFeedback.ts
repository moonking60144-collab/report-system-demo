import { useCallback, useId, useRef, useState } from "react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "../utils";

export function useReportDownloadFeedback() {
  const { t } = useTranslation("workReport");
  const activeRef = useRef(false);
  const messageId = useId();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const runDownload = useCallback(async (key: string, label: string, download: () => Promise<void>) => {
    if (activeRef.current) return;
    activeRef.current = true;
    setActiveKey(key);
    const messageKey = `report-download-${messageId}`;
    void message.loading({ key: messageKey, duration: 0,
      content: t("efficiencyStats.downloadPreparing", { label }) });
    const timer = window.setTimeout(() => {
      void message.loading({ key: messageKey, duration: 0,
        content: t("efficiencyStats.downloadWaiting", { label }) });
    }, 10000);
    try {
      await download();
      void message.success({ key: messageKey, duration: 6,
        content: t("efficiencyStats.downloadStarted", { label }) });
    } catch (error) {
      void message.error({ key: messageKey, duration: 10,
        content: t("efficiencyStats.downloadFailed", { label, error: getErrorMessage(error) }) });
    } finally {
      window.clearTimeout(timer);
      activeRef.current = false;
      setActiveKey(null);
    }
  }, [t, messageId]);
  return { activeKey, runDownload };
}
