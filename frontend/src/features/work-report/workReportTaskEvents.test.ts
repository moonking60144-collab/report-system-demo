import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskEventWakeup, parseWorkReportTaskEvent, subscribeWorkReportTaskEvents } from "./workReportTaskEvents";
import { acquireWorkReportConnection } from "./workReportRealtimeConnection";
import { pollCreateTaskMonitor, settleTerminalEntryFieldTask } from "./hooks/useTaskMonitor";
import type { CreateTaskMonitor } from "./types";
import { enqueueRetryPoll, getActiveRetryPollCount } from "./batchRetryPollManager";
import * as workReportApi from "../../api/workReport";
import * as retryStore from "./taskBatchRetryStore";

vi.mock("../../utils/clientIdentity", () => ({
  getOrCreateClientBootId: () => "boot", getOrCreateClientId: () => "client", getOrCreateTabId: () => "tab",
}));

class FakeSource extends EventTarget {
  static instances: FakeSource[] = [];
  readyState = 0;
  close = vi.fn();
  constructor() { super(); FakeSource.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(id: string, taskId = "task", formId = "901") {
    this.dispatchEvent(new MessageEvent("work-report-event", { data: JSON.stringify({
      id, occurredAt: "now", type: "work-report-task-updated", formId,
      workReportTask: { taskId, taskType: "update-report", status: "success", updatedAt: "now" },
    }) }));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.instances = [];
  vi.stubGlobal("window", Object.assign(new EventTarget(), { EventSource: FakeSource }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("shared task event connection", () => {
  it("batch retry consumes SSE through its independent owner and only cleans up after GET success", async () => {
    const task = { taskId: "task", formId: "901", status: "running" } as workReportApi.WorkReportQueueTask;
    const fetch = vi.spyOn(workReportApi, "fetchWorkReportQueueTask").mockResolvedValue(task);
    const remove = vi.spyOn(retryStore, "deleteRetryableBatchCreateRecordChain").mockImplementation(() => {});
    enqueueRetryPoll("901", "task");
    await vi.advanceTimersByTimeAsync(0);
    const source = FakeSource.instances[0];
    source.open(); source.send("still-running");
    await vi.advanceTimersByTimeAsync(100);
    expect(remove).not.toHaveBeenCalled();
    fetch.mockResolvedValue({ ...task, status: "success" });
    source.send("done");
    await vi.advanceTimersByTimeAsync(100);
    expect(remove).toHaveBeenCalledExactlyOnceWith("task");
    expect(getActiveRetryPollCount()).toBe(0);
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("SSE wakes the real task poller; only GET and successful LIVE settlement publish completion", async () => {
    let terminal = false;
    let queries = 0;
    const updates: CreateTaskMonitor[] = [];
    const order: string[] = [];
    const fetchEntry = vi.fn().mockRejectedValueOnce(new Error("LIVE unavailable"))
      .mockResolvedValue({ id: "entry", reports: [] });
    const polling = pollCreateTaskMonitor({
      seedMonitor: { taskId: "task", kind: "update", formId: "901", entryId: "entry", workOrderNo: "WO", status: "running", message: "running", updatedAt: "now", entryFieldOperation: "work-report-sort-order" },
      fetchTask: async () => {
        queries += 1;
        return { taskId: "task", formId: "901", entryId: "entry", queueKey: "901:entry", status: terminal ? "success" : "running", createdAt: "now", updatedAt: "now" };
      },
      buildMonitorFromTaskResult: (base, task) => ({ ...base, status: task.status }),
      upsertTaskMonitorState: (monitor) => updates.push(monitor),
      onSuccess: async (monitor) => {
        try {
          await settleTerminalEntryFieldTask({ monitor, fetchEntry, getRetryMutation: () => null,
            consumer: { getCurrentRecord: () => null, applySettlement: () => order.push("record") },
            upsertMonitor: (next) => { order.push("terminal"); updates.push(next); },
            successMessage: "done", supersededMessage: "superseded",
          });
          return true;
        } catch { return "retry"; }
      },
      onFailed: vi.fn(),
      buildPollingRetryMessage: () => "retry", buildPollingUnavailableMessage: () => "unavailable",
      buildTaskNotFoundMessage: () => "unknown", buildTimedOutMessage: () => "timeout",
    });
    await vi.advanceTimersByTimeAsync(0);
    const source = FakeSource.instances[0];
    source.open(); source.send("hint-only");
    await vi.advanceTimersByTimeAsync(100);
    expect(queries).toBe(2);
    expect(updates.every((monitor) => monitor.status === "running")).toBe(true);
    terminal = true;
    source.send("completed");
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchEntry).toHaveBeenCalledTimes(1);
    source.send("duplicate-terminal");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchEntry).toHaveBeenCalledTimes(1);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await polling;
    expect(order).toEqual(["record", "terminal"]);
    expect(updates.at(-1)?.entryFieldSettlementOutcome).toBe("settled");
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("shares one connection with existing realtime consumers and closes on final unsubscribe", () => {
    const existing = acquireWorkReportConnection();
    const onTask = vi.fn();
    const dispose = subscribeWorkReportTaskEvents(onTask);
    const source = FakeSource.instances[0];
    source.send("1"); source.send("1");
    expect(onTask).toHaveBeenCalledTimes(1);
    expect(FakeSource.instances).toHaveLength(1);
    existing.release();
    expect(source.close).not.toHaveBeenCalled();
    dispose();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("preserves invalidation during GET and coalesces a burst before the next query", async () => {
    const wakeup = createTaskEventWakeup("901", "task");
    const source = FakeSource.instances[0];
    source.send("1"); source.send("2");
    const done = vi.fn();
    const waiting = wakeup.wait(30_000).then(done);
    await vi.advanceTimersByTimeAsync(99);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toHaveBeenCalledOnce();
    wakeup.dispose();
  });

  it("only matching tasks wake polling; LIVE retry retains its cooldown", async () => {
    const wakeup = createTaskEventWakeup("901", "task");
    const source = FakeSource.instances[0];
    const done = vi.fn();
    const waiting = wakeup.wait(5_000, false).then(done);
    source.send("1");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await waiting;
    const next = vi.fn();
    const nextWait = wakeup.wait(30_000).then(next);
    source.send("2", "other"); source.send("3", "task", "902");
    await vi.advanceTimersByTimeAsync(100);
    expect(next).not.toHaveBeenCalled();
    source.send("4");
    await vi.advanceTimersByTimeAsync(100); await nextWait;
    expect(next).toHaveBeenCalledOnce();
    wakeup.dispose();
  });

  it("reconnect and foreground wake recovery, disposal removes listeners", async () => {
    const wakeup = createTaskEventWakeup("903", "task");
    const source = FakeSource.instances[0];
    const waiting = wakeup.wait(30_000);
    source.open();
    expect(wakeup.connected()).toBe(true);
    await vi.advanceTimersByTimeAsync(100); await waiting;
    const next = wakeup.wait(30_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(100); await next;
    wakeup.dispose();
    expect(source.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid event payloads", () => {
    expect(parseWorkReportTaskEvent("null")).toBeNull();
    expect(parseWorkReportTaskEvent('{"type":"work-report-task-updated"}')).toBeNull();
  });
});
