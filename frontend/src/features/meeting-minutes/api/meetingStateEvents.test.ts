import { afterEach, expect, it, vi } from "vitest";
import { subscribeMeetingStateEvents } from "./meetingStateEvents";

const bus = vi.hoisted(() => ({ source: new EventTarget(), release: vi.fn() }));
vi.mock("../../work-report/workReportRealtimeConnection", () => ({
  acquireWorkReportConnection: () => bus,
  observeWorkReportConnection: (source: EventTarget, opened: () => void, errored: () => void) => {
    source.addEventListener("open", opened); source.addEventListener("error", errored);
    return () => { source.removeEventListener("open", opened); source.removeEventListener("error", errored); };
  },
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("SSE wakes a snapshot read, coalesces bursts, reconnects and disposes; no 3-second polling", () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { EventSource: class {} }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  const refresh = vi.fn();
  const connection = vi.fn();
  const dispose = subscribeMeetingStateEvents(refresh, connection);
  vi.advanceTimersByTime(3_000);
  expect(refresh).not.toHaveBeenCalled();
  bus.source.dispatchEvent(new Event("open"));
  for (let i = 0; i < 4; i++) bus.source.dispatchEvent(new MessageEvent("work-report-event", { data: '{"type":"meeting-state-changed"}' }));
  vi.advanceTimersByTime(100);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(connection).toHaveBeenCalledWith(true);
  bus.source.dispatchEvent(new Event("error"));
  expect(connection).toHaveBeenCalledWith(false);
  bus.source.dispatchEvent(new Event("open"));
  vi.advanceTimersByTime(100);
  expect(refresh).toHaveBeenCalledTimes(2);
  dispose();
  bus.source.dispatchEvent(new Event("open"));
  vi.advanceTimersByTime(60_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(bus.release).toHaveBeenCalledOnce();
});
