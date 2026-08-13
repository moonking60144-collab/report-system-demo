import test from "node:test";
import assert from "node:assert/strict";
import { realtimeEventBus } from "../../src/events/realtimeEventBus";
import {
  runPostMutationHooks,
  runPostSortOrderMutationHooks,
} from "../../src/routes/workReportMutationRouteHelpers";
import type { WorkReportRouterDeps } from "../../src/routes/workReportRouterTypes";

test("Ragic mutation terminal 不等待背景 entry projection", async () => {
  let releaseProjection!: () => void;
  let applyStarted = false;
  const projectionGate = new Promise<void>((resolve) => {
    releaseProjection = resolve;
  });
  const publishedTypes: string[] = [];
  const deps = {
    enqueueSqliteProjectionAfterMutation: async () => 7,
    applyQueuedSqliteProjectionAfterMutation: async () => {
      applyStarted = true;
      await projectionGate;
      return "applied" as const;
    },
  } as unknown as WorkReportRouterDeps;
  const unsubscribe = realtimeEventBus.subscribe((event) => {
    if (event.formId === "104") {
      publishedTypes.push(event.type);
    }
  });

  try {
    await runPostMutationHooks(deps, "104", "17382", "update");
    assert.equal(applyStarted, true);
    assert.deepEqual(publishedTypes, []);

    releaseProjection();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(publishedTypes, [
      "work-report-entry-updated",
      "work-report-form-updated",
    ]);
  } finally {
    unsubscribe();
  }
});

test("projection enqueue 失敗不改寫已成功的 Ragic mutation", async () => {
  let applyCalled = false;
  const warnPayloads: unknown[] = [];
  const deps = {
    enqueueSqliteProjectionAfterMutation: async () => {
      throw new Error("sqlite busy");
    },
    applyQueuedSqliteProjectionAfterMutation: async () => {
      applyCalled = true;
      return "applied" as const;
    },
  } as unknown as WorkReportRouterDeps;
  const originalWarn = console.warn;
  console.warn = (_message?: unknown, payload?: unknown) => {
    warnPayloads.push(payload);
  };

  try {
    await runPostMutationHooks(deps, "104", "17382", "update");
    assert.equal(applyCalled, false);
    assert.deepEqual(warnPayloads, [
      {
        formId: "104",
        entryId: "17382",
        reason: "update",
        error: "sqlite busy",
      },
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

test("排序 projection deferred 時不發布指向舊 SQLite 快照的事件", async () => {
  const publishedTypes: string[] = [];
  const deps = {
    enqueueSqliteProjectionAfterMutation: async () => 8,
    applyQueuedSortOrderSqliteAfterMutation: async () => "deferred" as const,
  } as unknown as WorkReportRouterDeps;
  const unsubscribe = realtimeEventBus.subscribe((event) => {
    if (event.formId === "104") {
      publishedTypes.push(event.type);
    }
  });

  try {
    await runPostSortOrderMutationHooks(deps, "104", "17382", 4);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(publishedTypes, []);
  } finally {
    unsubscribe();
  }
});
