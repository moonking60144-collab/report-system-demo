import { useState, type ReactNode } from "react";
import {
  createWorkReportReadCacheStore,
  WorkReportReadCacheContext,
} from "./workReportReadCacheStore";

export function WorkReportReadCacheProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createWorkReportReadCacheStore);
  return (
    <WorkReportReadCacheContext.Provider value={store}>
      {children}
    </WorkReportReadCacheContext.Provider>
  );
}
