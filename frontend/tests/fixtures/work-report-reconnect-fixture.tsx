import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useWorkReportDetailRefreshController } from "../../src/features/work-report/hooks/detail/useWorkReportDetailRefreshController";
import { useWorkReportListRefreshController } from "../../src/features/work-report/hooks/list/useWorkReportListRefreshController";
import { useWorkReportListData } from "../../src/features/work-report/hooks/useWorkReportListData";
import { WorkReportReadCacheProvider } from "../../src/features/work-report/context/WorkReportReadCacheContext";

const noop = () => {};
const translate = (key: string) => key;
const hydrate = async () => [];
const previewQuery = { enabled: true };

class FixtureEventSource extends EventTarget {
  static current: FixtureEventSource;
  readyState = 0;
  constructor() { super(); FixtureEventSource.current = this; }
  close() { this.readyState = 2; }
  emit(type: string) {
    this.readyState = type === "open" ? 1 : 0;
    this.dispatchEvent(new Event(type));
  }
}

export function mountListReconnectFixture(element: HTMLElement) {
  Object.defineProperty(window, "EventSource", { value: FixtureEventSource, configurable: true });
  function Fixture() {
    const [formId, setFormId] = useState<"901" | "902">("901");
    const [loading, setLoading] = useState(true);
    const [reads, setReads] = useState<string[]>([]);
    const block = useRef(false);
    const finish = useRef<() => void>(() => {});
    const loadReports = useCallback(async () => {
      setReads(current => [...current, formId]);
      if (block.current) {
        block.current = false;
        await new Promise<void>(resolve => { finish.current = resolve; });
      }
    }, [formId]);
    useWorkReportListRefreshController({
      currentFormId: formId, loading, isHydratingAllRecords: false, shouldUseFullHydrationForList: false,
      isStandaloneTopView: false, page: 1, setPage: noop, loadReports,
      hydrateAllRecords: hydrate, invalidatePreviewCache: noop, setNotice: noop, t: translate, logListEvent: noop,
    });
    return <>
      <output data-testid="reads">{reads.join(",")}</output>
      <button onClick={() => FixtureEventSource.current.emit("open")}>連線</button>
      <button onClick={() => FixtureEventSource.current.emit("error")}>斷線</button>
      <button onClick={() => setLoading(false)}>完成前景讀取</button>
      <button onClick={() => { block.current = true; }}>延遲下一次讀取</button>
      <button onClick={() => finish.current()}>完成背景讀取</button>
      <button onClick={() => setFormId("902")}>切換表單</button>
    </>;
  }
  createRoot(element).render(<Fixture />);
}

export function mountCachedReconnectFixture(element: HTMLElement) {
  Object.defineProperty(window, "EventSource", { value: FixtureEventSource, configurable: true });
  function Fixture() {
    const data = useWorkReportListData({
      currentFormId: "901", page: 1, pageSize: 10, shouldUseFullHydrationForList: false,
      serverPreviewQuery: previewQuery, bootstrapKeyword: "", setNotice: noop, t: translate,
    });
    useWorkReportListRefreshController({
      currentFormId: "901", loading: data.loading || data.previewRevalidating,
      isHydratingAllRecords: data.isHydratingAllRecords, shouldUseFullHydrationForList: false,
      isStandaloneTopView: false, page: 1, setPage: noop, loadReports: data.loadReports,
      hydrateAllRecords: data.hydrateAllRecords, invalidatePreviewCache: data.invalidatePreviewCache,
      setNotice: noop, t: translate, logListEvent: noop,
    });
    return <>
      <output data-testid="value">{data.records[0]?.workOrderNo}</output>
      <output data-testid="busy">{`${data.loading}:${data.previewRevalidating}`}</output>
      <button onClick={() => void data.loadReports(false)}>前景讀取</button>
      <button onClick={() => void data.loadReports(false, { mode: "background", invalidateCache: true })}>背景補讀</button>
      <button onClick={() => FixtureEventSource.current.emit("open")}>連線</button>
      <button onClick={() => FixtureEventSource.current.emit("error")}>斷線</button>
    </>;
  }
  createRoot(element).render(<WorkReportReadCacheProvider><Fixture /></WorkReportReadCacheProvider>);
}

export function mountReconnectFixture(element: HTMLElement) {
  Object.defineProperty(window, "EventSource", { value: FixtureEventSource, configurable: true });
  function Fixture() {
    const [editing, setEditing] = useState(false);
    const [loads, setLoads] = useState(0);
    useWorkReportDetailRefreshController({
      enabled: true, formId: "901", safeEntryId: "1", modalOpen: false,
      editingRowId: editing ? "42" : null, hasActiveMutationTask: false,
      submitting: false, loading: false, refreshing: false,
      loadEntry: async () => { setLoads(count => count + 1); },
      setNotice: () => {}, logDetailEvent: () => {}, t: key => key,
    });
    return <>
      <output data-testid="loads">{loads}</output>
      <button onClick={() => FixtureEventSource.current.emit("open")}>連線</button>
      <button onClick={() => FixtureEventSource.current.emit("error")}>斷線</button>
      <button onClick={() => setEditing(value => !value)}>{editing ? "結束編輯" : "開始編輯"}</button>
    </>;
  }
  createRoot(element).render(<Fixture />);
}
