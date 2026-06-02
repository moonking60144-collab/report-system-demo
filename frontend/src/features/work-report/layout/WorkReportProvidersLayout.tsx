import { Outlet } from "react-router-dom";
import { WorkReportTaskMonitorProvider } from "../context/WorkReportTaskMonitorProvider";

// 把工令報工專屬的 context provider 集中到 layout route，
// 讓 IT 內部頁面 (/it/duty 等) 不會被 SSE/polling 包到。
export function WorkReportProvidersLayout() {
  return (
    <WorkReportTaskMonitorProvider>
      <Outlet />
    </WorkReportTaskMonitorProvider>
  );
}
