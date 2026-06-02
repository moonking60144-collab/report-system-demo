import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { WorkReportProvidersLayout } from "./features/work-report/layout/WorkReportProvidersLayout";
import { WORK_REPORT_SESSION_EXPIRED_ROUTE } from "./features/work-report/session/sessionExpiry";
import { WORK_REPORT_SYSTEM_UNAVAILABLE_ROUTE } from "./features/work-report/systemAvailability";

// 列表頁是首屏，不 lazy；其他頁面 lazy load 減少首包
import { WorkReportListPage } from "./features/work-report/pages/WorkReportListPage";

const WorkReportDetailPage = lazy(() =>
  import("./features/work-report/pages/WorkReportDetailPage").then((m) => ({
    default: m.WorkReportDetailPage,
  }))
);
const WorkReportDowntimePage = lazy(() =>
  import("./features/work-report/pages/WorkReportDowntimePage").then((m) => ({
    default: m.WorkReportDowntimePage,
  }))
);
const WorkReportSessionExpiredPage = lazy(() =>
  import("./features/work-report/pages/WorkReportSessionExpiredPage").then((m) => ({
    default: m.WorkReportSessionExpiredPage,
  }))
);
const WorkReportSystemUnavailablePage = lazy(() =>
  import("./features/work-report/pages/WorkReportSystemUnavailablePage").then((m) => ({
    default: m.WorkReportSystemUnavailablePage,
  }))
);
const ItDutyPage = lazy(() =>
  import("./features/it-duty/pages/ItDutyPage").then((m) => ({
    default: m.ItDutyPage,
  }))
);

function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ padding: 24, color: "#888", fontSize: 14 }}
    >
      載入中…
    </div>
  );
}

export function AppRouter() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* 報工區：用 layout route 包 Provider，不會牽動 IT 區 */}
        <Route element={<WorkReportProvidersLayout />}>
          <Route path="/" element={<WorkReportListPage />} />
          <Route path="/reports/:formId/:entryId" element={<WorkReportDetailPage />} />
          <Route path="/downtime" element={<WorkReportDowntimePage />} />
          <Route
            path={WORK_REPORT_SESSION_EXPIRED_ROUTE}
            element={<WorkReportSessionExpiredPage />}
          />
          <Route
            path={WORK_REPORT_SYSTEM_UNAVAILABLE_ROUTE}
            element={<WorkReportSystemUnavailablePage />}
          />
        </Route>

        {/* IT 內部區：完全不被 work-report context 包到 */}
        <Route path="/it/duty" element={<ItDutyPage />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
