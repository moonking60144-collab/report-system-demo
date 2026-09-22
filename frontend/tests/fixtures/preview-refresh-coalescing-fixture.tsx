import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkReportReadCacheProvider } from "../../src/features/work-report/context/WorkReportReadCacheContext";
import { useWorkReportListData } from "../../src/features/work-report/hooks/useWorkReportListData";
import { useWorkReportListRefreshController } from "../../src/features/work-report/hooks/list/useWorkReportListRefreshController";

const t = (key: string) => key;
const ignore = () => {};
const query = { enabled: true };

class FixtureEventSource extends EventTarget {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private emit = () => this.dispatchEvent(new MessageEvent("work-report-event", {
    data: JSON.stringify({ type: "work-report-form-updated", formId: "901" }),
  }));
  constructor() {
    super();
    window.addEventListener("fixture-sse", this.emit);
    queueMicrotask(() => this.onopen?.());
  }
  close() { window.removeEventListener("fixture-sse", this.emit); }
}
Object.defineProperty(window, "EventSource", { value: FixtureEventSource, configurable: true });

export function Fixture() {
  const [page, setPage] = useState(1);
  const [done, setDone] = useState(0);
  const data = useWorkReportListData({ currentFormId: "901", page, pageSize: 25,
    shouldUseFullHydrationForList: false, serverPreviewQuery: query,
    bootstrapKeyword: "", t, setNotice: ignore });
  const { loadReports } = data;
  useEffect(() => { void loadReports(); }, [loadReports]);
  useWorkReportListRefreshController({ currentFormId: "901", page, setPage,
    shouldUseFullHydrationForList: false, isStandaloneTopView: false,
    loading: data.loading, isHydratingAllRecords: false,
    loadReports: data.loadReports, hydrateAllRecords: data.hydrateAllRecords,
    invalidatePreviewCache: data.invalidatePreviewCache, setNotice: ignore, t, logListEvent: ignore });
  return <>
    <button onClick={() => window.dispatchEvent(new Event("fixture-sse"))}>event</button>
    <button onClick={async () => { await data.loadReports(false, { invalidateCache: true }); setDone(v => v + 1); }}>settlement read</button>
    <button onClick={() => data.invalidatePreviewCache("901")}>invalidate</button>
    <output id="done">{done}</output>
    <output id="loading">{String(data.loading)}</output>
  </>;
}

createRoot(document.getElementById("root")!).render(<WorkReportReadCacheProvider><Fixture /></WorkReportReadCacheProvider>);
