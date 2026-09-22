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
    if (event.formId === "901") {
      publishedTypes.push(event.type);
    }
  });

  try {
    await runPostMutationHooks(deps, "901", "90002", "update");
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
  let reconciliationCalls = 0;
  const publishedTypes: string[] = [];
  const deps = {
    enqueueSqliteProjectionAfterMutation: async () => {
      throw new Error("sqlite busy");
    },
    applyQueuedSqliteProjectionAfterMutation: async () => {
      applyCalled = true;
      return "applied" as const;
    },
    requestSync: async (_formId: string, options: { triggeredBy: string; waitForCompletion: boolean }) => {
      reconciliationCalls += 1;
      assert.deepEqual(options, {
        triggeredBy: "mutation-reconcile",
        waitForCompletion: false,
        queueIfRunning: true,
      });
      return { accepted: true };
    },
  } as unknown as WorkReportRouterDeps;
  const unsubscribe = realtimeEventBus.subscribe((event) => {
    if (event.formId === "901") publishedTypes.push(event.type);
  });

  try {
    await runPostMutationHooks(deps, "901", "90002", "update");
    assert.equal(applyCalled, false);
    assert.equal(reconciliationCalls, 1);
    assert.deepEqual(publishedTypes, []);
  } finally {
    unsubscribe();
  }
});

test("projection enqueue 遇到 SQLITE_BUSY 會短暫重試後套用", async () => {
  let enqueueCalls = 0;
  let applyCalls = 0;
  const busyError = Object.assign(new Error("sqlite busy"), { code: "SQLITE_BUSY" });
  const deps = {
    enqueueSqliteProjectionAfterMutation: async () => {
      enqueueCalls += 1;
      if (enqueueCalls === 1) throw busyError;
      return 9;
    },
    applyQueuedSqliteProjectionAfterMutation: async () => {
      applyCalls += 1;
      return "applied" as const;
    },
    requestSync: async () => ({ accepted: true }),
  } as unknown as WorkReportRouterDeps;

  await runPostMutationHooks(deps, "901", "90002", "update");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(enqueueCalls, 2);
  assert.equal(applyCalls, 1);
});

test("排序 projection deferred 時不發布指向舊 SQLite 快照的事件", async () => {
  const publishedTypes: string[] = [];
  const deps = {
    enqueueSqliteProjectionAfterMutation: async () => 8,
    applyQueuedSortOrderSqliteAfterMutation: async () => "deferred" as const,
  } as unknown as WorkReportRouterDeps;
  const unsubscribe = realtimeEventBus.subscribe((event) => {
    if (event.formId === "901") {
      publishedTypes.push(event.type);
    }
  });

  try {
    await runPostSortOrderMutationHooks(deps, "901", "90002", 4);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(publishedTypes, []);
  } finally {
    unsubscribe();
  }
});
