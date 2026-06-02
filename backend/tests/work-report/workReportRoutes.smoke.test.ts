import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { errorHandler } from "../../src/middleware/errorHandler";
import { HttpError } from "../../src/utils/httpError";
import {
  createWorkReportRouter,
  type WorkReportRouterDeps,
} from "../../src/routes/workReportRouterFactory";
import { workReportEditingPresenceService } from "../../src/services/workReportEditingPresenceService";

function createDeps(): WorkReportRouterDeps {
  return {
    requestSync: async (_formId, _options) => ({ accepted: true }),
    listTasks: (_options) => [],
    getTaskRecord: (_taskId) => null,
    getSyncStatus: async (_formId) => null,
    getReports: async (_formId, _query) => ({ data: [], count: 0, totalCount: 0, hasMore: false }),
    getFullReports: async (_formId, _options) => ({ data: [], meta: {} }),
    getReportFacets: async (_formId, _fields, _query) => ({}),
    getReportAnalysis: async (_formId, _query) => ({}),
    getFormOptions: async (_formId, _fields) => ({}),
    getRawPreview: async (_formId, _limit) => [],
    getReportByEntryId: async (_formId, _entryId, _options) => null,
    createReport: async (_formId, _entryId, _payload, _options) => ({ rowId: "" }),
    enqueueCreateTask: (_input) => ({
      taskId: "task",
      status: "pending",
      createdAt: "2026-03-09T00:00:00.000Z",
      accepted: true,
    }),
    getCreateTask: (_taskId) => null,
    requestBatchCreate: async (_input) => ({
      taskId: "batch-create-task",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    }),
    requestBatchCreateFinalizeRetry: async (_input) => ({
      taskId: "batch-create-finalize-retry-task",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    }),
    requestBatchDelete: async (_input) => ({
      taskId: "batch-delete-task",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    }),
    updateReport: async (_formId, _entryId, _rowId, _payload, _options) => ({ rowId: "" }),
    updateMainMachine: async (_formId, _entryId, machineCode, _options) => ({ machineCode }),
    manualCloseWorkOrder: async (_formId, _entryId, action, _options) => ({ action }),
    deleteReport: async (_formId, _entryId, _rowId, _options) => ({ rowId: "" }),
    assertEntryNotModified: async (_formId, _entryId, _expectedEntryLastUpdatedAt) => {},
    assertEntryEditableBySession: async (_input) => {},
    assertEntryLockVersion: async (_input) => {},
    upsertEditingPresence: async (_input) => ({
      hasOtherEditors: false,
      otherEditorCount: 0,
      observedAt: "2026-03-19T00:00:00.000Z",
      canEdit: true,
      isCurrentSessionOwner: true,
    }),
    getEditingPresenceSnapshot: async (_input) => ({
      hasOtherEditors: false,
      otherEditorCount: 0,
      observedAt: "2026-03-19T00:00:00.000Z",
      canEdit: true,
      isCurrentSessionOwner: true,
    }),
    requestRagicCallbackRefresh: async (input) => ({
      accepted: true,
      taskId: `callback-${input.formId}-${input.entryId}`,
      status: "pending",
      createdAt: "2026-03-17T00:00:00.000Z",
    }),
    projectSqliteAfterMutation: async (_formId, _entryId, _reason) => {},
  };
}

async function withTestServer(
  deps: ReturnType<typeof createDeps>,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api/forms", createWorkReportRouter(deps));
  app.use(errorHandler);

  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

test("GET /api/forms/105/reports/:entryId?refresh=1 會走 detail refresh 讀取", async (t) => {
  const deps = createDeps();
  deps.getReportByEntryId = async (formId: string, entryId: string, options?: { refresh?: boolean }) => {
      assert.equal(formId, "105");
      assert.equal(entryId, "E-105");
      assert.deepEqual(options, { refresh: true });
      return { id: "E-105", workOrderNo: "WO-105", customerPartNo: null, erpPartNo: null, status: "未結案", reports: [] };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105?refresh=1`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.id, "E-105");
  });
});

test("POST /api/forms/105/sync?async=1 會啟動 105 sync task", async (t) => {
  const deps = createDeps();
  deps.requestSync = async (formId: string, options: { triggeredBy: string; waitForCompletion: boolean }) => {
      assert.equal(formId, "105");
      assert.equal(options.triggeredBy, "toolbar-refresh");
      assert.equal(options.waitForCompletion, false);
      return {
        taskId: "sync-105",
        formId,
        status: "pending",
        accepted: true,
        triggeredBy: options.triggeredBy,
        createdAt: "2026-03-09T00:00:00.000Z",
        updatedAt: "2026-03-09T00:00:00.000Z",
        scannedEntries: 0,
        syncedEntries: 0,
        syncedRows: 0,
      };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/sync?async=1`, {
      method: "POST",
      headers: {
        "x-sync-triggered-by": "toolbar-refresh",
      },
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "sync-105");
    assert.equal(payload.meta.formId, "105");
    assert.equal(payload.meta.async, true);
  });
});

test("GET /api/forms/105/sync/status 會回傳最近 sync 狀態", async (t) => {
  const deps = createDeps();
  deps.getSyncStatus = async (formId: string) => {
      assert.equal(formId, "105");
      return {
        formId,
        status: "success",
        taskId: "sync-105",
        startedAt: "2026-03-09T00:00:00.000Z",
        finishedAt: "2026-03-09T00:01:00.000Z",
        snapshotAt: "2026-03-09T00:01:00.000Z",
        totalEntries: 12,
        totalRows: 34,
        message: "同步完成",
        updatedAt: "2026-03-09T00:01:00.000Z",
      };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/sync/status`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.formId, "105");
    assert.equal(payload.data.status, "success");
  });
});

test("POST /api/forms/105/reports/:entryId 會執行 105 create", async (t) => {
  const deps = createDeps();
  deps.createReport = async (formId: string, entryId: string, _payload, options) => {
      assert.equal(formId, "105");
      assert.equal(entryId, "E-105");
      assert.equal(options?.expectedEntryLastUpdatedAt, "2026-03-19T12:00:00.000Z");
      return { rowId: "R-1" };
    };
  deps.projectSqliteAfterMutation = async (
    formId: string,
    entryId: string,
    reason: "create" | "update" | "delete"
  ) => {
      assert.equal(formId, "105");
      assert.equal(entryId, "E-105");
      assert.equal(reason, "create");
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-19T12:00:00.000Z",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.data.rowId, "R-1");
  });
});

test("GET /api/forms/104/reports/:entryId/editing-presence 會回 presence snapshot", async () => {
  const deps = createDeps();
  deps.getEditingPresenceSnapshot = async (input) => {
    assert.equal(input.formId, "104");
    assert.equal(input.entryId, "E-104");
    assert.equal(input.sessionId, "tab-1");
    return {
      hasOtherEditors: true,
      otherEditorCount: 2,
      observedAt: "2026-03-19T00:00:00.000Z",
      canEdit: false,
      isCurrentSessionOwner: false,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/forms/104/reports/E-104/editing-presence?sessionId=tab-1`
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.hasOtherEditors, true);
    assert.equal(payload.data.otherEditorCount, 2);
  });
});

test("PUT /api/forms/104/reports/:entryId/editing-presence 會更新 presence", async () => {
  const deps = createDeps();
  deps.upsertEditingPresence = async (input) => {
    assert.equal(input.formId, "104");
    assert.equal(input.entryId, "E-104");
    assert.equal(input.sessionId, "tab-1");
    assert.equal(input.active, true);
    assert.equal(input.state, "editing");
    return {
      hasOtherEditors: false,
      otherEditorCount: 0,
      observedAt: "2026-03-19T00:00:00.000Z",
      canEdit: true,
      isCurrentSessionOwner: true,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/E-104/editing-presence`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: "tab-1",
        active: true,
        state: "editing",
      }),
    });
    assert.equal(response.status, 200);
  });
});

test("POST /api/forms/105/reports/:entryId/batch-delete 會受理批次刪除任務", async () => {
  const deps = createDeps();
  deps.requestBatchDelete = async (input) => {
    assert.equal(input.formId, "105");
    assert.equal(input.entryId, "E-105");
    assert.deepEqual(input.rowIds, ["1001", "1002"]);
    return {
      taskId: "batch-delete-105",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/batch-delete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ rowIds: ["1001", "1002"] }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "batch-delete-105");
    assert.equal(payload.meta.requestedCount, 2);
  });
});

test("POST /api/forms/105/reports/:entryId/batch-create 會受理批次新增任務", async () => {
  const deps = createDeps();
  deps.requestBatchCreate = async (input) => {
    assert.equal(input.formId, "105");
    assert.equal(input.entryId, "E-105");
    assert.equal(input.rows.length, 2);
    return {
      taskId: "batch-create-105",
      status: "pending",
      createdAt: "2026-03-30T00:00:00.000Z",
      requestedCount: 2,
    };
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/batch-create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        rows: [{ machineId: "P10" }, { machineId: "P11" }],
      }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.data.taskId, "batch-create-105");
    assert.equal(payload.meta.accepted, true);
  });
});

test("同一列 rowId 只能被一個 session 取得編輯鎖", async () => {
  const entryId = "E-104-row-lock";
  const rowId = "112708";

  const first = workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId,
    sessionId: "tab-A",
    active: true,
    state: "editing",
  });
  assert.equal(first.canEdit, true);
  assert.equal(first.isCurrentSessionOwner, true);

  const second = workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId,
    sessionId: "tab-B",
    active: true,
    state: "editing",
  });
  assert.equal(second.canEdit, false);
  assert.equal(second.isCurrentSessionOwner, false);
  assert.equal(second.hasOtherEditors, true);
  assert.equal(second.otherEditorCount, 1);

  workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId,
    sessionId: "tab-A",
    active: false,
  });
});

test("GET editing-presence 不帶 rowId 時會回工令層級的編輯摘要", async () => {
  const entryId = "E-104-summary";

  workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId: "112708",
    sessionId: "tab-A",
    active: true,
    state: "editing",
  });

  const summary = workReportEditingPresenceService.getSnapshot({
    formId: "104",
    entryId,
    sessionId: "tab-B",
  });
  assert.equal(summary.hasOtherEditors, true);
  assert.equal(summary.otherEditorCount, 1);
  assert.equal(summary.canEdit, true);

  workReportEditingPresenceService.upsertPresence({
    formId: "104",
    entryId,
    rowId: "112708",
    sessionId: "tab-A",
    active: false,
  });
});

test("POST /api/forms/105/reports/:entryId conflict 會回 409", async () => {
  const deps = createDeps();
  deps.assertEntryNotModified = async () => {
    throw new HttpError(
      409,
      "這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。",
      "ENTRY_CONFLICT"
    );
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-entry-last-updated-at": "2026-03-19T12:00:00.000Z",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, "ENTRY_CONFLICT");
  });
});

test("POST /api/forms/105/reports/:entryId lock version 不符會回 409", async () => {
  const deps = createDeps();
  deps.assertEntryLockVersion = async () => {
    throw new HttpError(
      409,
      "你已失去這筆工令的編輯權，請重新整理或稍後再試。",
      "ENTRY_EDIT_LOCKED"
    );
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-edit-session-id": "tab-1",
        "x-edit-lock-version": "3",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, "ENTRY_EDIT_LOCKED");
  });
});

test("POST /api/forms/104/ragic-callback 帶 token 與 entryId 可接受 callback", async () => {
  const deps = createDeps();
  deps.requestRagicCallbackRefresh = async (input) => {
    assert.equal(input.formId, "104");
    assert.equal(input.entryId, "E-104");
    assert.equal(input.eventType, "row-updated");
    assert.equal(input.rowId, "R-99");
    assert.equal(input.source, "ragic");
    return {
      accepted: true,
      taskId: "callback-104",
      status: "pending",
      createdAt: "2026-03-17T00:00:00.000Z",
    };
  };

  const originalToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "callback-secret";

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/104/ragic-callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ragic-callback-token": "callback-secret",
        },
        body: JSON.stringify({
          entryId: "E-104",
          eventType: "row-updated",
          rowId: "R-99",
          source: "ragic",
        }),
      });
      assert.equal(response.status, 202);
      const payload = await response.json();
      assert.equal(payload.data.accepted, true);
      assert.equal(payload.data.formId, "104");
      assert.equal(payload.data.entryId, "E-104");
      assert.equal(payload.data.eventType, "row-updated");
    });
  } finally {
    process.env.RAGIC_CALLBACK_TOKEN = originalToken;
  }
});

test("POST /api/forms/104/ragic-callback token 錯誤會回 403", async () => {
  const deps = createDeps();
  const originalToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "callback-secret";

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/104/ragic-callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ragic-callback-token": "wrong-token",
        },
        body: JSON.stringify({
          entryId: "E-104",
          eventType: "entry-updated",
        }),
      });
      assert.equal(response.status, 403);
    });
  } finally {
    process.env.RAGIC_CALLBACK_TOKEN = originalToken;
  }
});

test("POST /api/forms/104/ragic-callback 缺 entryId 會回 400", async () => {
  const deps = createDeps();
  const originalToken = process.env.RAGIC_CALLBACK_TOKEN;
  process.env.RAGIC_CALLBACK_TOKEN = "callback-secret";

  try {
    await withTestServer(deps, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/forms/104/ragic-callback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ragic-callback-token": "callback-secret",
        },
        body: JSON.stringify({
          eventType: "entry-updated",
        }),
      });
      assert.equal(response.status, 400);
    });
  } finally {
    process.env.RAGIC_CALLBACK_TOKEN = originalToken;
  }
});

test("PUT /api/forms/104/reports/:entryId/main-machine 會更新主表機台", async () => {
  const deps = createDeps();
  let projectionCalled = false;
  deps.updateMainMachine = async (formId, entryId, machineCode) => {
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    assert.equal(machineCode, "P11");
    return { machineCode };
  };
  deps.projectSqliteAfterMutation = async (formId, entryId, reason) => {
    assert.equal(formId, "104");
    assert.equal(entryId, "E-104");
    assert.equal(reason, "update");
    projectionCalled = true;
  };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/104/reports/E-104/main-machine`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        machineCode: "P11",
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.machineCode, "P11");
    assert.equal(payload.meta.formId, "104");
    assert.equal(projectionCalled, true);
  });
});

test("PUT /api/forms/105/reports/:entryId/:rowId 會執行 105 update", async (t) => {
  const deps = createDeps();
  deps.assertEntryEditableBySession = async (input) => {
      assert.equal(input.formId, "105");
      assert.equal(input.entryId, "E-105");
      assert.equal(input.rowId, "12");
    };
  deps.assertEntryLockVersion = async (input) => {
      assert.equal(input.formId, "105");
      assert.equal(input.entryId, "E-105");
      assert.equal(input.rowId, "12");
    };
  deps.updateReport = async (formId: string, entryId: string, rowId: string) => {
      assert.equal(formId, "105");
      assert.equal(entryId, "E-105");
      assert.equal(rowId, "12");
      return { rowId };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/12`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ operatorId: "A001" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.rowId, "12");
  });
});

test("DELETE /api/forms/105/reports/:entryId/:rowId 會執行 105 delete", async (t) => {
  const deps = createDeps();
  deps.assertEntryEditableBySession = async (input) => {
      assert.equal(input.formId, "105");
      assert.equal(input.entryId, "E-105");
      assert.equal(input.rowId, "12");
    };
  deps.assertEntryLockVersion = async (input) => {
      assert.equal(input.formId, "105");
      assert.equal(input.entryId, "E-105");
      assert.equal(input.rowId, "12");
    };
  deps.deleteReport = async (formId: string, entryId: string, rowId: string) => {
      assert.equal(formId, "105");
      assert.equal(entryId, "E-105");
      assert.equal(rowId, "12");
      return { rowId };
    };

  await withTestServer(deps, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/forms/105/reports/E-105/12`, {
      method: "DELETE",
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.rowId, "12");
  });
});
