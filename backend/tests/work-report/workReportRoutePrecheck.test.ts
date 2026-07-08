import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../src/utils/httpError";
import {
  tryRouteMutationEntryPrecheck,
  type MutationRequestContext,
} from "../../src/routes/workReportMutationRouteHelpers";
import type { WorkReportRouterDeps } from "../../src/routes/workReportRouterTypes";

test("route 預檢遇到 ENTRY_CONFLICT 會 deferred 給 worker 最終判斷", async () => {
  const calls: unknown[][] = [];
  const warnPayloads: unknown[] = [];
  const deps = {
    assertEntryNotModified: async (...args: unknown[]) => {
      calls.push(args);
      throw new HttpError(
        409,
        "這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。",
        "ENTRY_CONFLICT"
      );
    },
  } as unknown as WorkReportRouterDeps;
  const ctx: MutationRequestContext = {
    formId: "104",
    entryId: "17382",
    expectedEntryLastUpdatedAt: "2026/07/02 10:43:00",
    actor: {
      actorClientId: null,
      actorTabId: null,
      actorIp: null,
      actorLabel: null,
      workOrderNo: null,
    },
  };
  const originalWarn = console.warn;
  console.warn = (_message?: unknown, payload?: unknown) => {
    warnPayloads.push(payload);
  };

  try {
    const result = await tryRouteMutationEntryPrecheck(deps, ctx);
    assert.equal(result, "deferred");
    assert.equal(calls.length, 1);
    assert.equal(warnPayloads.length, 1);
    const payload = warnPayloads[0] as {
      scheduler?: { mutationActive?: number; backgroundActive?: number };
    };
    assert.equal(typeof payload.scheduler?.mutationActive, "number");
    assert.equal(typeof payload.scheduler?.backgroundActive, "number");
  } finally {
    console.warn = originalWarn;
  }
});

test("route 預檢 timeout deferred log 會帶 scheduler snapshot", async () => {
  const warnPayloads: unknown[] = [];
  const deps = {
    assertEntryNotModified: async () => {
      throw new Error("timeout of 1500ms exceeded");
    },
  } as unknown as WorkReportRouterDeps;
  const ctx: MutationRequestContext = {
    formId: "104",
    entryId: "17382",
    expectedEntryLastUpdatedAt: "2026/07/02 10:43:00",
    actor: {
      actorClientId: null,
      actorTabId: null,
      actorIp: null,
      actorLabel: null,
      workOrderNo: null,
    },
  };
  const originalWarn = console.warn;
  console.warn = (_message?: unknown, payload?: unknown) => {
    warnPayloads.push(payload);
  };

  try {
    const result = await tryRouteMutationEntryPrecheck(deps, ctx);
    assert.equal(result, "deferred");
    assert.equal(warnPayloads.length, 1);
    const payload = warnPayloads[0] as {
      error?: string;
      scheduler?: { mutationPending?: number; backgroundPending?: number };
    };
    assert.equal(payload.error, "timeout of 1500ms exceeded");
    assert.equal(typeof payload.scheduler?.mutationPending, "number");
    assert.equal(typeof payload.scheduler?.backgroundPending, "number");
  } finally {
    console.warn = originalWarn;
  }
});
