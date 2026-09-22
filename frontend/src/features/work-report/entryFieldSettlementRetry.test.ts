import { AxiosError } from "axios";
import { describe, expect, it, vi } from "vitest";
import { createEntryFieldSettlementReader, EntryFieldSettlementRetry, settlementReadRequiresManualRetry, settlementRetryAfterMs } from "./entryFieldSettlementRetry";
import type { CreateTaskMonitor } from "./types";
import type { WorkReportRecord } from "../../api/workReport";

const monitor = (taskId: string, extra: Partial<CreateTaskMonitor> = {}): CreateTaskMonitor => ({
  taskId, kind: "update", formId: "901", entryId: taskId, workOrderNo: taskId,
  status: "success", message: "saved", updatedAt: "2026-09-17T00:00:00Z", ...extra,
});
const circuitError = () => new AxiosError("unavailable", undefined, undefined, undefined, {
  status: 503, headers: { "retry-after": "30" }, data: { error: { code: "RAGIC_CIRCUIT_OPEN", retryAfterMs: 29000 } },
} as never);

describe("confirmation retry admission", () => {
  it.each([20, 50])("recovery of %i tasks admits at most two and makes progress after every completion", count => {
    const retry = new EntryFieldSettlementRetry(() => 0);
    const pending = Array.from({ length: count }, (_, i) => monitor(String(i)));
    const completed = new Set<string>();
    while (completed.size < count) {
      const admitted = pending.filter(task => !completed.has(task.taskId) && retry.begin(task));
      expect(admitted, "SETTLEMENT_CONCURRENCY_LIMIT").toHaveLength(2);
      expect(retry.begin(monitor("extra")), "SETTLEMENT_CONCURRENCY_LIMIT").toBe(false);
      for (const task of admitted) {
        completed.add(task.taskId);
        retry.settled(task.taskId);
        retry.finish(task.taskId);
      }
    }
    expect(completed.size).toBe(count);
  });

  it("pruning bounds task IDs while preserving monitors, polling and unfinished reads", () => {
    const retry = new EntryFieldSettlementRetry(() => 0);
    const ids = new Set(Array.from({ length: 1000 }, (_, i) => String(i)));
    retry.begin(monitor("1"));
    retry.pause("3");
    retry.defer(monitor("3"), new Error("timeout"));
    retry.retainTaskIds(ids, [monitor("0")], new Set(["2"]));
    expect([...ids], "TASK_IDS_BOUNDED_BY_LIVE_OWNERS").toEqual(["0", "1", "2"]);
    expect(retry.retryAt(monitor("3"))).toBe(0);
    expect(retry.begin(monitor("3")), "REMOVED_PAUSE_CANNOT_BLOCK_REUSED_ID").toBe(true);
    retry.finish("1");
    retry.finish("3");
    retry.retainTaskIds(ids, [monitor("0")], new Set());
    expect([...ids]).toEqual(["0"]);
  });

  it("same-pass reads share only identical in-flight requests and release successes and failures", async () => {
    let resolve!: (value: WorkReportRecord) => void;
    const request = new Promise<WorkReportRecord>(done => { resolve = done; });
    const fetchEntry = vi.fn().mockReturnValue(request);
    const read = createEntryFieldSettlementReader(fetchEntry);
    const a = read("901", "1", true, { strictRefresh: true });
    expect(read("901", "1", true, { strictRefresh: true })).toBe(a);
    read("902", "1", true, { strictRefresh: true });
    read("901", "1", true, { strictRefresh: false });
    expect(fetchEntry, "SINGLE_FLIGHT_ISOLATES_FORM_AND_AUTHORITY").toHaveBeenCalledTimes(3);
    resolve({ id: "1", workOrderNo: "WO-1", status: "未結案", customerPartNo: "", erpPartNo: "", reports: [] });
    await a;
    read("901", "1", true, { strictRefresh: true });
    expect(fetchEntry, "SUCCESS_IS_NOT_A_CACHED_OBSERVATION").toHaveBeenCalledTimes(4);
    const failedFetch = vi.fn().mockRejectedValue(new Error("unavailable"));
    const failedRead = createEntryFieldSettlementReader(failedFetch);
    await expect(failedRead("901", "1", true, { strictRefresh: true })).rejects.toThrow("unavailable");
    await expect(failedRead("901", "1", true, { strictRefresh: true })).rejects.toThrow("unavailable");
    expect(failedFetch).toHaveBeenCalledTimes(2);
  });

  it("only typed missing work orders pause confirmation; manual admission still honors cooldown", () => {
    const error = (status: number, code: string) => new AxiosError("read failed", undefined, undefined, undefined, {
      status, data: { error: { code } }, headers: {},
    } as never);
    expect(settlementReadRequiresManualRetry(error(404, "REPORT_NOT_FOUND"))).toBe(true);
    expect(settlementReadRequiresManualRetry(error(404, "TASK_NOT_FOUND"))).toBe(false);
    expect(settlementReadRequiresManualRetry(error(503, "REPORT_NOT_FOUND"))).toBe(false);
    let now = 0;
    const retry = new EntryFieldSettlementRetry(() => now);
    retry.defer(monitor("a"), circuitError());
    const paused = monitor("b", { entryFieldSettlementErrorCode: "REPORT_NOT_FOUND" });
    expect(retry.begin(paused)).toBe(false);
    expect(retry.begin({ ...paused, entryFieldSettlementErrorCode: undefined })).toBe(false);
    now = 30000;
    expect(retry.begin(paused)).toBe(false);
    retry.pause("b");
    expect(retry.begin(monitor("b")), "STALE_RENDER_CANNOT_RESUME_PAUSED_CONFIRMATION").toBe(false);
    retry.resume("b");
    expect(retry.begin({ ...paused, entryFieldSettlementErrorCode: undefined })).toBe(true);
  });

  it("server deadline gates every task, stale monitor, and restored owner", () => {
    let now = 1000;
    const retry = new EntryFieldSettlementRetry(() => now);
    const a = monitor("a");
    expect(retry.begin(a)).toBe(true);
    expect(retry.begin(a)).toBe(false);
    const failure = retry.defer(a, circuitError());
    retry.finish("a");
    expect(failure.retryAt).toBe(31000);
    now = 30999;
    expect(retry.begin(a), "DEADLINE_MUST_GATE_STALE_MONITOR").toBe(false);
    expect(retry.begin(monitor("b")), "COOLDOWN_MUST_GATE_OTHER_TASKS").toBe(false);
    const restored = new EntryFieldSettlementRetry(() => now, [monitor("a", { entryFieldSettlementRetryAt: failure.retryAt })]);
    expect(restored.begin(monitor("b"))).toBe(false);
    now = 31000;
    expect(retry.begin(a)).toBe(true);
    expect(restored.begin(monitor("b"))).toBe(true);
  });

  it("five failures notify once and successful recovery allows the next incident", () => {
    const retry = new EntryFieldSettlementRetry(() => 0);
    const results = Array.from({ length: 5 }, (_, i) => retry.defer(monitor(String(i)), circuitError()));
    expect(results.filter(x => x.notify), "ONE_NOTICE_PER_INCIDENT").toHaveLength(1);
    retry.recovered();
    expect(retry.defer(monitor("next"), circuitError()).notify).toBe(true);
  });

  it("bounded fallback increases only confirmation retries and honors longer server hints", () => {
    const retry = new EntryFieldSettlementRetry(() => 0);
    expect([0, 1, 2, 20].map(attempts => retry.defer(monitor(String(attempts), {
      entryFieldSettlementAttempts: attempts,
    }), new Error("timeout")).retryAt)).toEqual([5000, 10000, 20000, 30000]);
    expect(settlementRetryAfterMs(new AxiosError("wait", undefined, undefined, undefined, {
      headers: { "retry-after": "120" }, data: {},
    } as never))).toBe(120000);
  });
});
