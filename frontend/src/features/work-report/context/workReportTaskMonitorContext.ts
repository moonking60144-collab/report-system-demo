import { createContext } from "react";
import { useTaskMonitor } from "../hooks/useTaskMonitor";

export type WorkReportTaskMonitorContextValue = ReturnType<typeof useTaskMonitor>;

export const WorkReportTaskMonitorContext =
  createContext<WorkReportTaskMonitorContextValue | null>(null);
