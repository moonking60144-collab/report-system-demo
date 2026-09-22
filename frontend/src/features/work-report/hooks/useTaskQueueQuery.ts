import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchWorkReportQueueTasks, type WorkReportQueueTask } from "../../../api/workReport";
import { getTaskQueuePollIntervalMs } from "../taskQueuePresentation";
import { subscribeWorkReportTaskEvents } from "../workReportTaskEvents";

const EMPTY_TASKS: WorkReportQueueTask[] = [];

export function useTaskQueueQuery({
  open,
  formId,
  query,
  refreshToken,
}: {
  open: boolean;
  formId: string | null;
  query: Parameters<typeof fetchWorkReportQueueTasks>[1];
  refreshToken?: number;
}) {
  const queryKey = JSON.stringify([formId, query]);
  const [connected, setConnected] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    tasks: WorkReportQueueTask[] | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const inFlight = useRef<{
    key: string;
    controller: AbortController;
    promise: Promise<void>;
    invalidated: boolean;
  } | null>(null);

  const loadTasks = useCallback((invalidate = false): Promise<void> => {
    if (!open || !formId) return Promise.resolve();
    if (inFlight.current?.key === queryKey) {
      if (invalidate) inFlight.current.invalidated = true;
      return inFlight.current.promise;
    }
    inFlight.current?.controller.abort();
    const request = {
      key: queryKey,
      controller: new AbortController(),
      promise: Promise.resolve(),
      invalidated: false,
    };
    inFlight.current = request;
    setResult((current) => ({
      key: queryKey,
      tasks: current?.key === queryKey ? current.tasks : null,
      loading: true,
      error: null,
    }));
    request.promise = (async () => {
      try {
        const tasks = await fetchWorkReportQueueTasks(formId, query, {
          signal: request.controller.signal,
        });
        if (inFlight.current !== request || request.controller.signal.aborted) return;
        setResult({ key: queryKey, tasks, loading: false, error: null });
      } catch (error) {
        if (inFlight.current !== request || request.controller.signal.aborted) return;
        setResult((current) => ({
          key: queryKey,
          tasks: current?.key === queryKey ? current.tasks : null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        if (inFlight.current === request) {
          inFlight.current = null;
          if (request.invalidated && !request.controller.signal.aborted) void loadTasks();
        }
      }
    })();
    return request.promise;
  }, [formId, open, query, queryKey]);

  const currentLoader = useRef<((invalidate?: boolean) => Promise<void>) | null>(null);
  useLayoutEffect(() => {
    currentLoader.current = loadTasks;
    return () => { currentLoader.current = null; };
  }, [loadTasks]);
  // Retry completion may outlive a scope change or the drawer itself.
  const refresh = useCallback(() => currentLoader.current?.(true) ?? Promise.resolve(), []);
  const current = result?.key === queryKey ? result : null;
  const tasks = current?.tasks ?? EMPTY_TASKS;
  const hasLoaded = current !== null && current.tasks !== null;
  const pollIntervalMs = getTaskQueuePollIntervalMs(connected);

  useEffect(() => {
    if (!open || !formId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; void loadTasks(true); }, 100);
    };
    const unsubscribe = subscribeWorkReportTaskEvents((event) => {
      if (event.formId === formId) schedule();
    }, (value) => { setConnected(value); if (value) schedule(); });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [formId, open, loadTasks]);

  useEffect(() => {
    if (!open || !formId) return;
    void loadTasks();
    return () => {
      if (inFlight.current?.key === queryKey) {
        inFlight.current.controller.abort();
        inFlight.current = null;
      }
    };
  }, [formId, loadTasks, open, queryKey]);

  useEffect(() => {
    if (!open || !formId) return;
    const refreshVisible = () => {
      if (!document.hidden) void loadTasks();
    };
    const timer = window.setInterval(refreshVisible, pollIntervalMs);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [formId, loadTasks, open, pollIntervalMs]);

  useEffect(() => {
    if (refreshToken) void loadTasks(true);
  }, [loadTasks, refreshToken]);

  return {
    tasks,
    hasLoaded,
    loading: Boolean(open && formId && (!current || current.loading)),
    error: current?.error ?? null,
    loadTasks: refresh,
  };
}
