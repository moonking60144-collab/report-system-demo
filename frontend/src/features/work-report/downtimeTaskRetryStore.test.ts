import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteRetryableDowntimeCreateRecordChain,
  getRetryableDowntimeCreateRecord,
  replaceRetryableDowntimeCreateRecord,
  saveRetryableDowntimeCreateRecord,
} from "./downtimeTaskRetryStore";

const STORE_KEY = "work-report:retryable-downtime-create-store:v1";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

function createWindowStub(): { localStorage: MemoryStorage } {
  return { localStorage: new MemoryStorage() };
}

function createPayload() {
  return {
    date: "2026-07-06",
    machineId: "W1",
    processCode: "TI01",
    plannedIdleMinutes: 480,
    remark: "保養",
    clientRowKey: "client-row-key-1",
  };
}

describe("downtimeTaskRetryStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T00:00:00.000Z"));
    vi.stubGlobal("window", createWindowStub());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("saves and reads a retryable downtime create payload with actorClientId", () => {
    saveRetryableDowntimeCreateRecord({
      taskId: "task-1",
      retryRootTaskId: "task-1",
      payload: createPayload(),
      createdAt: "2026-07-06T00:00:00.000Z",
    });

    const record = getRetryableDowntimeCreateRecord("task-1");

    expect(record?.taskId).toBe("task-1");
    expect(record?.retryRootTaskId).toBe("task-1");
    expect(record?.payload.clientRowKey).toBe("client-row-key-1");
    expect(record?.actorClientId).toMatch(/^client-/);
  });

  it("replaces a failed task with a retry task while keeping the same clientRowKey", () => {
    saveRetryableDowntimeCreateRecord({
      taskId: "task-1",
      retryRootTaskId: "task-1",
      payload: createPayload(),
      createdAt: "2026-07-06T00:00:00.000Z",
    });

    replaceRetryableDowntimeCreateRecord("task-1", {
      taskId: "task-2",
      retryRootTaskId: "task-1",
      retriedFromTaskId: "task-1",
      payload: createPayload(),
      createdAt: "2026-07-06T00:01:00.000Z",
    });

    const previous = getRetryableDowntimeCreateRecord("task-1");
    const retry = getRetryableDowntimeCreateRecord("task-2");

    expect(previous?.latestRetryTaskId).toBe("task-2");
    expect(retry?.retriedFromTaskId).toBe("task-1");
    expect(retry?.payload.clientRowKey).toBe("client-row-key-1");
  });

  it("deletes the whole retry chain after terminal success", () => {
    saveRetryableDowntimeCreateRecord({
      taskId: "task-1",
      retryRootTaskId: "task-1",
      payload: createPayload(),
      createdAt: "2026-07-06T00:00:00.000Z",
    });
    replaceRetryableDowntimeCreateRecord("task-1", {
      taskId: "task-2",
      retryRootTaskId: "task-1",
      retriedFromTaskId: "task-1",
      payload: createPayload(),
      createdAt: "2026-07-06T00:01:00.000Z",
    });

    deleteRetryableDowntimeCreateRecordChain("task-2");

    expect(getRetryableDowntimeCreateRecord("task-1")).toBeNull();
    expect(getRetryableDowntimeCreateRecord("task-2")).toBeNull();
  });

  it("ignores malformed records without clientRowKey", () => {
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        "task-1": {
          taskId: "task-1",
          retryRootTaskId: "task-1",
          payload: {
            date: "2026-07-06",
            machineId: "W1",
            processCode: "TI01",
          },
          actorClientId: "client-1",
          createdAt: "2026-07-06T00:00:00.000Z",
        },
      })
    );

    expect(getRetryableDowntimeCreateRecord("task-1")).toBeNull();
  });

  it("keeps records within seven days and drops expired records", () => {
    saveRetryableDowntimeCreateRecord({
      taskId: "task-fresh",
      retryRootTaskId: "task-fresh",
      payload: createPayload(),
      createdAt: "2026-06-30T00:00:01.000Z",
    });
    saveRetryableDowntimeCreateRecord({
      taskId: "task-expired",
      retryRootTaskId: "task-expired",
      payload: createPayload(),
      createdAt: "2026-06-29T23:59:59.000Z",
    });

    expect(getRetryableDowntimeCreateRecord("task-fresh")?.taskId).toBe("task-fresh");
    expect(getRetryableDowntimeCreateRecord("task-expired")).toBeNull();
  });
});
