import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageLoadingBoundary } from "./components/PageLoadingBoundary";
import { WorkReportProvidersLayout } from "./features/work-report/layout/WorkReportProvidersLayout";
import { WORK_REPORT_SESSION_EXPIRED_ROUTE } from "./features/work-report/session/sessionExpiry";
import { WORK_REPORT_SYSTEM_UNAVAILABLE_ROUTE } from "./features/work-report/systemAvailability";

// 列表頁是首屏，不 lazy；其他頁面 lazy load 減少首包
import { WorkReportListPage } from "./features/work-report/pages/WorkReportListPage";
// DevLayout 不 lazy：進 /dev 直接渲染黑底外殼，避免白底 RouteFallback 一閃；view 用 layout 內的深色 Suspense
import { DevLayout } from "./features/dev/layout/DevLayout";
import {
  MEETING_AUDIO_CHECK_ROUTE,
  MEETING_LIBRARY_ROUTE,
} from "./features/meeting-minutes/routes";
import { loadWorkReportDetailPage } from "./features/work-report/routes/workReportRouteLoaders";

const WorkReportDetailPage = lazy(() =>
  loadWorkReportDetailPage().then((m) => ({
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
const DevDefinitionsView = lazy(() =>
  import("./features/dev/pages/views/DevDefinitionsView").then((m) => ({
    default: m.DevDefinitionsView,
  }))
);
const DevSettingsView = lazy(() =>
  import("./features/dev/pages/views/DevSettingsView").then((m) => ({ default: m.DevSettingsView }))
);
const DevAiView = lazy(() =>
  import("./features/dev/pages/views/DevAiView").then((m) => ({ default: m.DevAiView }))
);
const DevKnowledgeView = lazy(() =>
  import("./features/dev/pages/views/DevKnowledgeView").then((m) => ({
    default: m.DevKnowledgeView,
  }))
);
const DevMeetingLibrariesView = lazy(() =>
  import("./features/dev/pages/views/DevMeetingLibrariesView").then((m) => ({
    default: m.DevMeetingLibrariesView,
  }))
);
const MeetingAudioCheckPage = lazy(() =>
  import("./features/meeting-minutes/pages/MeetingAudioCheckPage").then((m) => ({
    default: m.MeetingAudioCheckPage,
  }))
);
const MeetingLibraryPage = lazy(() =>
  import("./features/meeting-minutes/pages/MeetingLibraryPage").then((m) => ({
    default: m.MeetingLibraryPage,
  }))
);

function RouteFallback() {
  const { t } = useTranslation("common");
  return (
    <PageLoadingBoundary
      variant="page"
      state={{ kind: "pending", message: t("states.loadingPage") }}
    />
  );
}

function WorkReportDetailRoute() {
  const { formId, entryId } = useParams<{
    formId: string;
    entryId: string;
  }>();
  return <WorkReportDetailPage key={`${formId ?? ""}:${entryId ?? ""}`} />;
}

export function AppRouter() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* 報工區：用 layout route 包 Provider，不會牽動 IT 區 */}
        <Route element={<WorkReportProvidersLayout />}>
          <Route path="/" element={<WorkReportListPage />} />
          <Route path="/reports/:formId/:entryId" element={<WorkReportDetailRoute />} />
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

        {/* 會議紀錄子系統：獨立 route，不依賴 work-report provider 或 Dev AI */}
        <Route path={MEETING_AUDIO_CHECK_ROUTE} element={<MeetingAudioCheckPage />} />
        <Route path={MEETING_LIBRARY_ROUTE} element={<MeetingLibraryPage />} />

        {/* 開發者模式：hub + 各工具獨立 view（一次一個工具，捲動互不打架），整頁獨立不被 work-report context 包到 */}
        <Route path="/dev" element={<DevLayout />}>
          <Route index element={<DevHubPage />} />
          <Route path="search" element={<DevSearchView />} />
          <Route path="definitions" element={<DevDefinitionsView />} />
          <Route path="ai" element={<DevAiView />} />
          <Route path="ai/threads/:threadId" element={<DevAiView />} />
          <Route path="knowledge" element={<DevKnowledgeView />} />
          <Route path="meeting-libraries" element={<DevMeetingLibrariesView />} />
          <Route path="settings" element={<DevSettingsView />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
