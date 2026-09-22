import { createContext, useContext } from "react";
import {
  PreviewPageCache,
  type PreviewInFlightRequest,
} from "../cache/workReportPreviewCache";

export interface WorkReportReadCacheStore {
  previewPageCacheRef: { current: PreviewPageCache };
  previewFetchInFlightRef: { current: Map<string, PreviewInFlightRequest> };
}

export const WorkReportReadCacheContext =
  createContext<WorkReportReadCacheStore | null>(null);

export function createWorkReportReadCacheStore(): WorkReportReadCacheStore {
  return {
    previewPageCacheRef: { current: new PreviewPageCache() },
    previewFetchInFlightRef: { current: new Map() },
  };
}

export function useWorkReportReadCacheStore(): WorkReportReadCacheStore {
  const store = useContext(WorkReportReadCacheContext);
  if (!store) {
    throw new Error("useWorkReportReadCacheStore must be used inside WorkReportReadCacheProvider");
  }
  return store;
}
