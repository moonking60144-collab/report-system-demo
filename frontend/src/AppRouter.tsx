import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { WorkReportProvidersLayout } from "./features/work-report/layout/WorkReportProvidersLayout";
import { WORK_REPORT_SESSION_EXPIRED_ROUTE } from "./features/work-report/session/sessionExpiry";
import { WORK_REPORT_SYSTEM_UNAVAILABLE_ROUTE } from "./features/work-report/systemAvailability";

// 列表頁是首屏，不 lazy；其他頁面 lazy load 減少首包
import { WorkReportListPage } from "./features/work-report/pages/WorkReportListPage";
// DevLayout 不 lazy：進 /dev 直接渲染黑底外殼，避免白底 RouteFallback 一閃；view 用 layout 內的深色 Suspense
import { DevLayout } from "./features/dev/layout/DevLayout";

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
const ItSopPage = lazy(() =>
  import("./features/it-sop/pages/ItSopPage").then((m) => ({
    default: m.ItSopPage,
  }))
);
const DevHubPage = lazy(() =>
  import("./features/dev/pages/DevHubPage").then((m) => ({ default: m.DevHubPage }))
);
const DevSearchView = lazy(() =>
  import("./features/dev/pages/views/DevSearchView").then((m) => ({ default: m.DevSearchView }))
);
const DevDepsView = lazy(() =>
  import("./features/dev/pages/views/DevDepsView").then((m) => ({ default: m.DevDepsView }))
);
const DevWorkflowView = lazy(() =>
  import("./features/dev/pages/views/DevWorkflowView").then((m) => ({ default: m.DevWorkflowView }))
);
const DevDefinitionsView = lazy(() =>
  import("./features/dev/pages/views/DevDefinitionsView").then((m) => ({
    default: m.DevDefinitionsView,
  }))
);
const DevEntitiesView = lazy(() =>
  import("./features/dev/pages/views/DevEntitiesView").then((m) => ({ default: m.DevEntitiesView }))
);
const DevMatrixView = lazy(() =>
  import("./features/dev/pages/views/DevMatrixView").then((m) => ({ default: m.DevMatrixView }))
);
const DevNormalizeView = lazy(() =>
  import("./features/dev/pages/views/DevNormalizeView").then((m) => ({
    default: m.DevNormalizeView,
  }))
);
const DevSettingsView = lazy(() =>
  import("./features/dev/pages/views/DevSettingsView").then((m) => ({ default: m.DevSettingsView }))
);
const DevAiView = lazy(() =>
  import("./features/dev/pages/views/DevAiView").then((m) => ({ default: m.DevAiView }))
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
        <Route path="/it/sop" element={<ItSopPage />} />
        <Route path="/it/sop/:documentId" element={<ItSopPage />} />

        {/* 開發者模式：hub + 各工具獨立 view（一次一個工具，捲動互不打架），整頁獨立不被 work-report context 包到 */}
        <Route path="/dev" element={<DevLayout />}>
          <Route index element={<DevHubPage />} />
          <Route path="search" element={<DevSearchView />} />
          <Route path="deps" element={<DevDepsView />} />
          <Route path="workflow" element={<DevWorkflowView />} />
          <Route path="definitions" element={<DevDefinitionsView />} />
          <Route path="entities" element={<DevEntitiesView />} />
          <Route path="matrix" element={<DevMatrixView />} />
          <Route path="normalize" element={<DevNormalizeView />} />
          <Route path="ai" element={<DevAiView />} />
          <Route path="ai/threads/:threadId" element={<DevAiView />} />
          <Route path="settings" element={<DevSettingsView />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
