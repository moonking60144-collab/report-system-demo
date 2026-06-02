import { BrowserRouter, useLocation } from "react-router-dom";
import { App as AntApp, ConfigProvider } from "antd";
import zhTW from "antd/locale/zh_TW";
import enUS from "antd/locale/en_US";
import { useTranslation } from "react-i18next";
import { AppRouter } from "./AppRouter";
import { useServerBootGuard } from "./hooks/useServerBootGuard";
import { isWorkReportSessionExpiredPath } from "./features/work-report/session/sessionExpiry";
import { useWorkReportAvailabilityGuard } from "./features/work-report/hooks/useWorkReportAvailabilityGuard";
import { isWorkReportSystemUnavailablePath } from "./features/work-report/systemAvailability";

function AppRouterShell() {
  const location = useLocation();
  const guardEnabled =
    !isWorkReportSessionExpiredPath(location.pathname) &&
    !isWorkReportSystemUnavailablePath(location.pathname);
  const sseState = useServerBootGuard(guardEnabled);
  useWorkReportAvailabilityGuard(
    guardEnabled,
    location.pathname + location.search,
    sseState
  );
  return <AppRouter />;
}

export function AppWithLocale() {
  const { i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? i18n.language).toLowerCase();
  const antdLocale = language.startsWith("en") ? enUS : zhTW;

  return (
    <ConfigProvider locale={antdLocale}>
      <AntApp>
        <BrowserRouter>
          <AppRouterShell />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}
