import type { ReactNode } from "react";
import { WorkReportTaskMonitorContext } from "./workReportTaskMonitorContext";
import { useTaskMonitor } from "../hooks/useTaskMonitor";

export function WorkReportTaskMonitorProvider({ children }: { children: ReactNode }) {
  const taskMonitorState = useTaskMonitor();
  return (
    <WorkReportTaskMonitorContext.Provider value={taskMonitorState}>
      {children}
    </WorkReportTaskMonitorContext.Provider>
  );
}
