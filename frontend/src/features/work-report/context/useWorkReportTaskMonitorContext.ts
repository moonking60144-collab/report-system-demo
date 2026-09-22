import { useContext } from "react";
import { WorkReportTaskMonitorContext } from "./workReportTaskMonitorContext";
import type { WorkReportTaskMonitorContextValue } from "./workReportTaskMonitorContext";

export function useWorkReportTaskMonitorContext(): WorkReportTaskMonitorContextValue {
  const context = useContext(WorkReportTaskMonitorContext);
  if (!context) {
    throw new Error("useWorkReportTaskMonitorContext 必須在 WorkReportTaskMonitorProvider 內使用");
  }
  return context;
}
