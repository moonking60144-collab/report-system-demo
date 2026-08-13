import test from "node:test";
import assert from "node:assert/strict";
import { env } from "../../../src/config/env";
import { FORM_104_CONFIG } from "../../../src/config/forms/form-104";
import { ragicClient } from "../../../src/ragic/client";
import type { Form16DowntimeRecord } from "../../../src/types/form16Downtime";
import { form16DowntimeService } from "../../../src/services/form16/form16DowntimeService";
import { form16DowntimeSqliteRepository } from "../../../src/storage/sqlite/form16DowntimeSqliteRepository";
import { buildForm16DowntimeRecordSnapshotHash } from "../../../src/storage/sqlite/form16DowntimeSqliteRepository";
import { form16ClientRowKeyRepository } from "../../../src/storage/sqlite/form16ClientRowKeyRepository";
import { form16PlannedIdleSqliteRepository } from "../../../src/storage/sqlite/form16PlannedIdleSqliteRepository";
import {
  WorkReportAutoSyncYieldRequestedError,
  workReportMutationSyncCoordinator,
} from "../../../src/services/work-report-sync/workReportMutationSyncCoordinator";
import { HttpError } from "../../../src/utils/httpError";

test("停機紀錄 snapshot hash 相同時允許 mutation", async (t) => {
  const getHashMock = t.mock.method(
    form16DowntimeSqliteRepository,
    "getRecordSnapshotHash",
    async () => "same-hash"
  );

  await form16DowntimeService.assertRecordSnapshotUnchanged("123", "same-hash");

  assert.equal(getHashMock.mock.callCount(), 1);
});

test("停機紀錄 snapshot hash 不同時擋下 stale mutation", async (t) => {
  t.mock.method(
    form16DowntimeSqliteRepository,
    "getRecordSnapshotHash",
    async () => "current-hash"
  );

  await assert.rejects(
    () => form16DowntimeService.assertRecordSnapshotUnchanged("123", "old-hash"),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "DOWNTIME_RECORD_STALE");
      return true;
    }
  );
});

test("停機紀錄沒有 expected snapshot hash 時維持舊流程", async (t) => {
  const getHashMock = t.mock.method(
    form16DowntimeSqliteRepository,
    "getRecordSnapshotHash",
    async () => "current-hash"
  );

  await form16DowntimeService.assertRecordSnapshotUnchanged("123", null);

  assert.equal(getHashMock.mock.callCount(), 0);
});

test("同一 Form 16 entry 的背景 projection 依排入順序執行，較舊讀取不會最後覆蓋", async (t) => {
  const mutableEnv = env as { SQLITE_ENABLED: boolean };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  mutableEnv.SQLITE_ENABLED = true;
  t.after(() => {
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
  });

  let releaseFirstRead: () => void = () => {
    throw new Error("first projection read has not started");
  };
  let readCallCount = 0;
  t.mock.method(ragicClient, "getEntry", async () => {
    readCallCount += 1;
    if (readCallCount === 1) {
      await new Promise<void>((resolve) => {
        releaseFirstRead = resolve;
      });
      return { remark: "old" };
    }
    return { remark: "new" };
  });

  const service = form16DowntimeService as unknown as {
    mapRowToRecord: (entryId: string, entry: Record<string, unknown>) => {
      id: string;
      snapshotHash: null;
      date: string;
      machineId: string;
      processCode: string;
      operatorId: null;
      operatorName: null;
      reportType: string;
      startTime: string;
      endTime: string;
      breakTime: string;
      plannedIdleMinutes: number;
      remark: string;
      workOrderNo: null;
    };
  };
  t.mock.method(service, "mapRowToRecord", (entryId: string, entry: Record<string, unknown>) => ({
    id: entryId,
    snapshotHash: null,
    date: "2026/08/12",
    machineId: "W23",
    processCode: "TI01",
    operatorId: null,
    operatorName: null,
    reportType: "TI搓牙",
    startTime: "08:00",
    endTime: "17:00",
    breakTime: "1.00",
    plannedIdleMinutes: 480,
    remark: String(entry.remark),
    workOrderNo: null,
  }));
  const projectedRemarks: string[] = [];
  t.mock.method(
    form16DowntimeSqliteRepository,
    "upsertRecord",
    async (record: Form16DowntimeRecord) => {
    projectedRemarks.push(record.remark ?? "");
    }
  );

  const first = form16DowntimeService.refreshEntrySnapshotFromRagic("123490");
  await new Promise((resolve) => setImmediate(resolve));
  const second = form16DowntimeService.refreshEntrySnapshotFromRagic("123490");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(readCallCount, 1);
  releaseFirstRead();
  await Promise.all([first, second]);

  assert.equal(readCallCount, 2);
  assert.deepEqual(projectedRemarks, ["old", "new"]);
});

test("停機紀錄 create payload 必須直寫 Type報工類別（Ragic 必填驗證先於公式，缺了會被 202 拒絕）", async (t) => {
  const service = form16DowntimeService as unknown as {
    assertNoDuplicatePlannedIdle: (...args: unknown[]) => Promise<void>;
    resolveForm16RequiredFields: (
      ...args: unknown[]
    ) => Promise<{ depUnit: string; prodType: string; source: string }>;
    refreshEntrySnapshotFromRagic: (...args: unknown[]) => Promise<void>;
  };
  t.mock.method(service, "assertNoDuplicatePlannedIdle", async () => {});
  t.mock.method(service, "resolveForm16RequiredFields", async () => ({
    depUnit: "C02搓牙組",
    prodType: "TI",
    source: "test",
  }));
  t.mock.method(service, "refreshEntrySnapshotFromRagic", async () => {});
  const bumpRevisionMock = t.mock.method(
    form16PlannedIdleSqliteRepository,
    "bumpProjectionRevision",
    async () => {}
  );

  let createPayload: Record<string, unknown> | null = null;
  t.mock.method(ragicClient, "createEntry", async (
    _path: string,
    payload: Record<string, unknown>
  ) => {
    createPayload = payload;
    return { ragicId: "990001" };
  });
  t.mock.method(ragicClient, "getEntry", async () => ({
    [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID]: "",
    [env.RAGIC_FORM_16_TYPE_FIELD_ID]: "TI搓牙",
  }));
  t.mock.method(ragicClient, "executeActionButton", async () => ({}));
  t.mock.method(ragicClient, "clearFormCache", () => {});

  const result = await form16DowntimeService.createRecord({
    date: "2026/07/06",
    machineId: "A1",
    processCode: "BU01",
  });

  assert.equal(result.entryId, "990001");
  assert.ok(createPayload, "應有呼叫 ragicClient.createEntry");
  const requiredCreateTimeFields = [
    FORM_104_CONFIG.writeConfig.subtableWriteFields.date,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.plannedIdle,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.processCode,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.machineId,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.inputOptions,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.shiftType,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.startTime,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.endTime,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.breakTime,
    FORM_104_CONFIG.writeConfig.subtableWriteFields.plannedIdleMinutes,
    env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID,
    env.RAGIC_FORM_16_TYPE_FIELD_ID,
    env.RAGIC_FORM_16_DEP_FIELD_ID,
    env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID,
  ];
  for (const fieldId of requiredCreateTimeFields) {
    assert.notEqual(
      (createPayload as Record<string, unknown>)[fieldId],
      undefined,
      `create-time required field ${fieldId} 不可從 payload 消失`
    );
  }
  assert.equal(
    (createPayload as Record<string, unknown>)[env.RAGIC_FORM_16_TYPE_FIELD_ID],
    "TI搓牙"
  );
  assert.equal(
    (createPayload as Record<string, unknown>)[env.RAGIC_FORM_16_DEP_FIELD_ID],
    "C02搓牙組"
  );
  assert.equal(
    (createPayload as Record<string, unknown>)[env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID],
    "TI"
  );
  assert.equal(bumpRevisionMock.mock.callCount(), 1);
});

test("停機紀錄 confirmed durable mapping 會在 duplicate guard 前回收 persisted 與 legacy fingerprint", async (t) => {
  const mutableEnv = env as { SQLITE_ENABLED: boolean };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  mutableEnv.SQLITE_ENABLED = true;
  t.after(() => {
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
  });

  const service = form16DowntimeService as unknown as {
    assertNoDuplicatePlannedIdle: (...args: unknown[]) => Promise<void>;
    resolveForm16RequiredFields: (
      ...args: unknown[]
    ) => Promise<{ depUnit: string; prodType: string; source: string }>;
  };
  const duplicateMock = t.mock.method(service, "assertNoDuplicatePlannedIdle", async () => {
    throw new HttpError(409, "existing row", "DUPLICATE_PLANNED_IDLE");
  });
  const resolverMock = t.mock.method(service, "resolveForm16RequiredFields", async () => {
    throw new Error("confirmed mapping 不應依賴 live required-field resolver");
  });
  const lookupMock = t.mock.method(
    form16ClientRowKeyRepository,
    "lookup",
    async (clientRowKey: string) => ({
      clientRowKey,
      entryId: clientRowKey.endsWith("legacy") ? "990002" : "990001",
      source: "downtime",
      ...(clientRowKey.endsWith("legacy")
        ? {}
        : { operationFingerprint: "persisted-final-payload-fingerprint" }),
      status: "confirmed" as const,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    })
  );
  t.mock.method(form16DowntimeSqliteRepository, "listRecords", async () =>
    ["990001", "990002"].map((id) => ({
      id,
      snapshotHash: null,
      date: "2026/07/20",
      machineId: "P10",
      processCode: "TI01",
      operatorId: null,
      operatorName: null,
      reportType: "TI搓牙",
      startTime: "08:00",
      endTime: "17:00",
      breakTime: "1.00",
      plannedIdleMinutes: 480,
      remark: null,
      workOrderNo: null,
    }))
  );
  const reserveMock = t.mock.method(form16ClientRowKeyRepository, "reservePending", async () => {
    throw new Error("confirmed mapping 不應重新 reserve");
  });
  const createMock = t.mock.method(ragicClient, "createEntry", async () => {
    throw new Error("confirmed mapping 不應再次寫入 Ragic");
  });
  const bumpRevisionMock = t.mock.method(
    form16PlannedIdleSqliteRepository,
    "bumpProjectionRevision",
    async () => {}
  );

  const persisted = await form16DowntimeService.createRecord({
    date: "2026/07/20",
    machineId: "P10",
    processCode: "TI01",
    clientRowKey: "confirmed-persisted",
  });
  const legacy = await form16DowntimeService.createRecord({
    date: "2026/07/20",
    machineId: "P10",
    processCode: "TI01",
    clientRowKey: "confirmed-legacy",
  });

  assert.equal(persisted.entryId, "990001");
  assert.equal(legacy.entryId, "990002");
  assert.equal(lookupMock.mock.callCount(), 2);
  assert.equal(resolverMock.mock.callCount(), 0);
  assert.equal(reserveMock.mock.callCount(), 0);
  assert.equal(duplicateMock.mock.callCount(), 0);
  assert.equal(createMock.mock.callCount(), 0);
  assert.equal(bumpRevisionMock.mock.callCount(), 2);
});

test("停機紀錄 update 變更 processCode 時必須同步寫回 Type報工類別與 lookup 欄位", async (t) => {
  const service = form16DowntimeService as unknown as {
    assertRecordSnapshotUnchanged: (...args: unknown[]) => Promise<void>;
    resolveForm16RequiredFields: (
      ...args: unknown[]
    ) => Promise<{ depUnit: string; prodType: string; source: string }>;
    refreshEntrySnapshotFromRagic: (...args: unknown[]) => Promise<void>;
  };
  t.mock.method(service, "assertRecordSnapshotUnchanged", async () => {});
  t.mock.method(service, "resolveForm16RequiredFields", async () => ({
    depUnit: "C02搓牙組",
    prodType: "TI",
    source: "test",
  }));
  t.mock.method(service, "refreshEntrySnapshotFromRagic", async () => {});
  const bumpRevisionMock = t.mock.method(
    form16PlannedIdleSqliteRepository,
    "bumpProjectionRevision",
    async () => {}
  );
  t.mock.method(ragicClient, "getEntry", async () => ({
    [FORM_104_CONFIG.writeConfig.subtableWriteFields.date]: "2026/07/20",
    [FORM_104_CONFIG.writeConfig.subtableWriteFields.machineId]: "P10",
    [FORM_104_CONFIG.writeConfig.subtableWriteFields.processCode]: "BU01",
    [FORM_104_CONFIG.writeConfig.subtableWriteFields.plannedIdle]: "Yes",
  }));

  let updatePayload: Record<string, unknown> | null = null;
  t.mock.method(ragicClient, "updateEntry", async (
    _path: string,
    _entryId: string,
    payload: Record<string, unknown>
  ) => {
    updatePayload = payload;
    return {};
  });

  const result = await form16DowntimeService.updateRecord("990001", {
    processCode: "BU01",
  });

  assert.equal(result.id, "990001");
  assert.ok(updatePayload, "應有呼叫 ragicClient.updateEntry");
  assert.equal(
    (updatePayload as Record<string, unknown>)[
      FORM_104_CONFIG.writeConfig.subtableWriteFields.processCode
    ],
    "BU01"
  );
  assert.equal(
    (updatePayload as Record<string, unknown>)[env.RAGIC_FORM_16_TYPE_FIELD_ID],
    "TI搓牙"
  );
  assert.equal(
    (updatePayload as Record<string, unknown>)[env.RAGIC_FORM_16_DEP_FIELD_ID],
    "C02搓牙組"
  );
  assert.equal(
    (updatePayload as Record<string, unknown>)[env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID],
    "TI"
  );
  assert.equal(bumpRevisionMock.mock.callCount(), 1);
});

test("停機紀錄 update 日期或機台時排除自己，不會把原紀錄判成重複", async (t) => {
  const service = form16DowntimeService as unknown as {
    assertRecordSnapshotUnchanged: (...args: unknown[]) => Promise<void>;
    refreshEntrySnapshotFromRagic: (...args: unknown[]) => Promise<void>;
  };
  const writeFields = FORM_104_CONFIG.writeConfig.subtableWriteFields;
  const currentRow = {
    [writeFields.date]: "2026/07/20",
    [writeFields.machineId]: "P10",
    [writeFields.processCode]: "TI01",
    [writeFields.plannedIdle]: "Yes",
  };
  t.mock.method(service, "assertRecordSnapshotUnchanged", async () => {});
  t.mock.method(service, "refreshEntrySnapshotFromRagic", async () => {});
  t.mock.method(form16PlannedIdleSqliteRepository, "bumpProjectionRevision", async () => {});
  t.mock.method(ragicClient, "getEntry", async () => currentRow);
  t.mock.method(ragicClient, "getFormPage", async () => ({ "990001": currentRow }));
  const updateMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));

  const result = await form16DowntimeService.updateRecord("990001", {
    machineId: "P10",
  });

  assert.equal(result.id, "990001");
  assert.equal(updateMock.mock.callCount(), 1);
});

test("停機紀錄 update 的部分 patch 會用現況補齊日期，並擋下其他 entry 的同日同機台", async (t) => {
  const service = form16DowntimeService as unknown as {
    assertRecordSnapshotUnchanged: (...args: unknown[]) => Promise<void>;
    refreshEntrySnapshotFromRagic: (...args: unknown[]) => Promise<void>;
  };
  const writeFields = FORM_104_CONFIG.writeConfig.subtableWriteFields;
  const currentRow = {
    [writeFields.date]: "2026/07/20",
    [writeFields.machineId]: "P10",
    [writeFields.processCode]: "TI01",
    [writeFields.plannedIdle]: "Yes",
  };
  const duplicateRow = {
    ...currentRow,
    [writeFields.machineId]: "P11",
  };
  let duplicateWhere: string[] = [];
  t.mock.method(service, "assertRecordSnapshotUnchanged", async () => {});
  t.mock.method(service, "refreshEntrySnapshotFromRagic", async () => {});
  t.mock.method(form16PlannedIdleSqliteRepository, "bumpProjectionRevision", async () => {});
  t.mock.method(ragicClient, "getEntry", async () => currentRow);
  t.mock.method(ragicClient, "getFormPage", async (
    _path: string,
    query: { where?: string[] }
  ) => {
    duplicateWhere = query.where ?? [];
    return { "990001": currentRow, "990002": duplicateRow };
  });
  const updateMock = t.mock.method(ragicClient, "updateEntry", async () => ({}));

  await assert.rejects(
    () => form16DowntimeService.updateRecord("990001", { machineId: "P11" }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "DUPLICATE_PLANNED_IDLE");
      return true;
    }
  );

  assert.ok(duplicateWhere.includes("1002190,eq,2026/07/20"));
  assert.equal(updateMock.mock.callCount(), 0);
});

test("停機紀錄同一個舊 snapshot hash 只能成功使用一次", async (t) => {
  const service = form16DowntimeService as unknown as {
    refreshEntrySnapshotFromRagic: (...args: unknown[]) => Promise<void>;
  };
  const writeFields = FORM_104_CONFIG.writeConfig.subtableWriteFields;
  let currentRemark = "before";
  const buildCurrentRow = () => ({
    [writeFields.date]: "2026/07/20",
    [writeFields.machineId]: "P10",
    [writeFields.processCode]: "TI01",
    [writeFields.plannedIdle]: "Yes",
    [env.RAGIC_FORM_16_REMARK_FIELD_ID]: currentRemark,
  });
  const oldSnapshotHash = buildForm16DowntimeRecordSnapshotHash({
    id: "990001",
    snapshotHash: null,
    date: "2026/07/20",
    machineId: "P10",
    processCode: "TI01",
    operatorId: null,
    operatorName: null,
    reportType: null,
    startTime: null,
    endTime: null,
    breakTime: null,
    plannedIdleMinutes: null,
    remark: "before",
    workOrderNo: null,
  });
  t.mock.method(service, "refreshEntrySnapshotFromRagic", async () => {});
  t.mock.method(form16PlannedIdleSqliteRepository, "bumpProjectionRevision", async () => {});
  t.mock.method(ragicClient, "getEntry", async () => buildCurrentRow());
  const updateMock = t.mock.method(ragicClient, "updateEntry", async () => {
    currentRemark = "after";
    return {};
  });

  await form16DowntimeService.updateRecord(
    "990001",
    { remark: "after" },
    { expectedSnapshotHash: oldSnapshotHash }
  );
  await assert.rejects(
    () =>
      form16DowntimeService.updateRecord(
        "990001",
        { remark: "second" },
        { expectedSnapshotHash: oldSnapshotHash }
      ),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "DOWNTIME_RECORD_STALE");
      return true;
    }
  );

  assert.equal(updateMock.mock.callCount(), 1);
});

test("停機紀錄 delete 成功後會 bump 計畫停機 projection revision", async (t) => {
  const mutableEnv = env as { SQLITE_ENABLED: boolean };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  mutableEnv.SQLITE_ENABLED = true;
  t.after(() => {
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
  });

  const writeFields = FORM_104_CONFIG.writeConfig.subtableWriteFields;
  t.mock.method(ragicClient, "getEntry", async () => ({
    [writeFields.date]: "2026/07/20",
    [writeFields.machineId]: "P10",
    [writeFields.processCode]: "TI01",
    [writeFields.plannedIdle]: "Yes",
  }));
  const deleteMock = t.mock.method(ragicClient, "deleteEntry", async () => ({}));
  const bumpRevisionMock = t.mock.method(
    form16PlannedIdleSqliteRepository,
    "bumpProjectionRevision",
    async () => {}
  );
  const deleteSnapshotMock = t.mock.method(
    form16DowntimeSqliteRepository,
    "deleteRecord",
    async () => {}
  );

  const result = await form16DowntimeService.deleteRecord("990001");

  assert.equal(result.deleted, true);
  assert.equal(result.beforeSnapshot.id, "990001");
  assert.equal(deleteMock.mock.callCount(), 1);
  assert.equal(bumpRevisionMock.mock.callCount(), 1);
  assert.equal(deleteSnapshotMock.mock.callCount(), 1);
});

test("計畫停機 refresh=1 立即回舊 aggregate，背景 singleflight commit 後可讀到新快照", async (t) => {
  const service = form16DowntimeService as unknown as {
    fetchPlannedIdleRowsFromRagic: (...args: unknown[]) => Promise<
      Array<{
        entryId: string;
        date: string;
        monthKey: string;
        machineId: string;
        prodType: string;
        plannedMinutes: number;
      }>
    >;
  };
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let committed = false;
  const fetchMock = t.mock.method(service, "fetchPlannedIdleRowsFromRagic", async () => {
    await fetchGate;
    return [
      {
        entryId: "991001",
        date: "2026/07/20",
        monthKey: "2026/07",
        machineId: "P10",
        prodType: "TI",
        plannedMinutes: 480,
      },
    ];
  });
  t.mock.method(form16PlannedIdleSqliteRepository, "getState", async () => ({
    syncedAt: "2026-07-20T00:00:00.000Z",
    oldestMonth: "2026/01",
    totalRecords: 1,
    fullRevision: 1,
    projectionRevision: 1,
  }));
  t.mock.method(form16PlannedIdleSqliteRepository, "getRefreshBarrier", async () => ({
    fullRevision: 1,
    projectionRevision: 1,
    monthRevision: 1,
  }));
  t.mock.method(form16PlannedIdleSqliteRepository, "getMonthSyncedAt", async () =>
    committed ? "2026-07-20T00:10:00.000Z" : "2026-07-20T00:00:00.000Z"
  );
  const replaceMock = t.mock.method(
    form16PlannedIdleSqliteRepository,
    "replaceMonth",
    async () => {
      committed = true;
      return "applied" as const;
    }
  );
  t.mock.method(form16PlannedIdleSqliteRepository, "aggregateByMonth", async () =>
    committed
      ? [{ machineId: "P10", prodType: "TI", totalMinutes: 480, count: 1 }]
      : [{ machineId: "P10", prodType: "TI", totalMinutes: 60, count: 1 }]
  );

  const first = form16DowntimeService.summarizePlannedIdleByMachine("2026/07", true);
  const second = form16DowntimeService.summarizePlannedIdleByMachine("2026/07", true);
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(firstResult.refreshed, false);
  assert.equal(firstResult.refreshTriggered, true);
  assert.equal(firstResult.snapshotAt, "2026-07-20T00:00:00.000Z");
  assert.deepEqual(firstResult.machines, [
    {
      machineId: "P10",
      prodType: "TI",
      totalMinutes: 60,
      totalDays: 0.13,
      count: 1,
    },
  ]);
  assert.deepEqual(secondResult, firstResult);

  releaseFetch();
  for (let attempt = 0; attempt < 20 && !committed; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(committed, true);

  assert.equal(replaceMock.mock.callCount(), 1);
  const committedResult = await form16DowntimeService.summarizePlannedIdleByMachine(
    "2026/07",
    false
  );
  assert.equal(committedResult.refreshTriggered, false);
  assert.equal(committedResult.snapshotAt, "2026-07-20T00:10:00.000Z");
  assert.deepEqual(committedResult.machines, [
    {
      machineId: "P10",
      prodType: "TI",
      totalMinutes: 480,
      totalDays: 1,
      count: 1,
    },
  ]);
});

test("計畫停機首次即時撈取若被較新 revision 取代，回傳已提交的 SQLite aggregate", async (t) => {
  const service = form16DowntimeService as unknown as {
    fetchPlannedIdleRowsFromRagic: (...args: unknown[]) => Promise<
      Array<{
        entryId: string;
        date: string;
        monthKey: string;
        machineId: string;
        prodType: string;
        plannedMinutes: number;
      }>
    >;
  };
  t.mock.method(form16PlannedIdleSqliteRepository, "getState", async () => null);
  t.mock.method(form16PlannedIdleSqliteRepository, "getRefreshBarrier", async () => ({
    fullRevision: 1,
    projectionRevision: 2,
    monthRevision: 1,
  }));
  t.mock.method(service, "fetchPlannedIdleRowsFromRagic", async () => [
    {
      entryId: "old",
      date: "2026/07/01",
      monthKey: "2026/07",
      machineId: "P10",
      prodType: "OLD",
      plannedMinutes: 60,
    },
  ]);
  t.mock.method(form16PlannedIdleSqliteRepository, "replaceMonth", async () =>
    "stale" as const
  );
  t.mock.method(form16PlannedIdleSqliteRepository, "aggregateByMonth", async () => [
    { machineId: "P20", prodType: "TI", totalMinutes: 480, count: 1 },
  ]);
  t.mock.method(form16PlannedIdleSqliteRepository, "getMonthSyncedAt", async () =>
    "2026-07-20T00:30:00.000Z"
  );

  const result = await form16DowntimeService.summarizePlannedIdleByMachine("2026/07", false);

  assert.equal(result.source, "sqlite");
  assert.equal(result.refreshed, true);
  assert.equal(result.refreshTriggered, false);
  assert.equal(result.snapshotAt, "2026-07-20T00:30:00.000Z");
  assert.deepEqual(result.machines, [
    {
      machineId: "P20",
      prodType: "TI",
      totalMinutes: 480,
      totalDays: 1,
      count: 1,
    },
  ]);
});

test("停機全量同步遇到 stale revision 會重抓並只在 applied 後完成", async (t) => {
  const service = form16DowntimeService as unknown as {
    fetchRecordsFromRagic: () => Promise<[]>;
  };
  const fetchMock = t.mock.method(service, "fetchRecordsFromRagic", async () => []);
  let revision = 10;
  t.mock.method(form16DowntimeSqliteRepository, "getSnapshotState", async () => ({
    snapshotAt: "2026-07-20T00:00:00.000Z",
    totalRecords: 0,
    revision: revision++,
  }));
  let syncAttempt = 0;
  const syncMock = t.mock.method(
    form16DowntimeSqliteRepository,
    "syncSnapshot",
    async () => (++syncAttempt === 1 ? "stale" as const : "applied" as const)
  );

  await form16DowntimeService.refreshSqliteSnapshotFromRagic();

  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(syncMock.mock.callCount(), 2);
});

test("背景停機全量同步在報工寫入等待時會讓位，且重抓後才套用 snapshot", async (t) => {
  let resolveFirstFetch!: () => void;
  const firstFetchStarted = new Promise<void>((resolve) => {
    resolveFirstFetch = resolve;
  });
  let continueFirstFetch!: () => void;
  const firstFetchCanFinish = new Promise<void>((resolve) => {
    continueFirstFetch = resolve;
  });
  const service = form16DowntimeService as unknown as {
    fetchRecordsFromRagic: (
      shouldYieldToMutation?: () => boolean
    ) => Promise<[]>;
  };
  let fetchCallCount = 0;
  const fetchMock = t.mock.method(
    service,
    "fetchRecordsFromRagic",
    async (shouldYieldToMutation?: () => boolean) => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        resolveFirstFetch();
        await firstFetchCanFinish;
        if (shouldYieldToMutation?.()) {
          throw new WorkReportAutoSyncYieldRequestedError();
        }
      }
      return [];
    }
  );
  t.mock.method(form16DowntimeSqliteRepository, "getSnapshotState", async () => ({
    snapshotAt: "2026-07-20T00:00:00.000Z",
    totalRecords: 0,
    revision: 10,
  }));
  const syncMock = t.mock.method(
    form16DowntimeSqliteRepository,
    "syncSnapshot",
    async () => "applied" as const
  );

  const refreshPromise = form16DowntimeService.refreshSqliteSnapshotFromRagic({
    yieldToMutation: true,
  });
  await firstFetchStarted;
  const mutationSlotPromise = workReportMutationSyncCoordinator.acquireMutationSlot();
  await new Promise<void>((resolve) => setImmediate(resolve));
  continueFirstFetch();
  const releaseMutation = await mutationSlotPromise;
  const syncCountWhileMutationOwnsSlot = syncMock.mock.callCount();
  releaseMutation();

  await refreshPromise;
  assert.equal(syncCountWhileMutationOwnsSlot, 0);
  assert.equal(fetchCallCount, 2);
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(syncMock.mock.callCount(), 1);
});

test("停機全量同步連續 stale revision 會回 typed conflict，不會假報成功", async (t) => {
  const service = form16DowntimeService as unknown as {
    fetchRecordsFromRagic: () => Promise<[]>;
  };
  t.mock.method(service, "fetchRecordsFromRagic", async () => []);
  t.mock.method(form16DowntimeSqliteRepository, "getSnapshotState", async () => ({
    snapshotAt: "2026-07-20T00:00:00.000Z",
    totalRecords: 0,
    revision: 10,
  }));
  t.mock.method(form16DowntimeSqliteRepository, "syncSnapshot", async () => "stale" as const);

  await assert.rejects(
    () => form16DowntimeService.refreshSqliteSnapshotFromRagic(),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, "FORM16_DOWNTIME_SNAPSHOT_CONFLICT");
      return true;
    }
  );
});

test("半年計畫停機同步遇到 stale revision 會重抓並只在 applied 後完成", async (t) => {
  const service = form16DowntimeService as unknown as {
    fetchPlannedIdleRowsFromRagic: () => Promise<[]>;
  };
  const fetchMock = t.mock.method(service, "fetchPlannedIdleRowsFromRagic", async () => []);
  t.mock.method(form16PlannedIdleSqliteRepository, "getProjectionRevision", async () => 3);
  let replaceAttempt = 0;
  const replaceMock = t.mock.method(
    form16PlannedIdleSqliteRepository,
    "replaceAll",
    async () => (++replaceAttempt === 1 ? "stale" as const : "applied" as const)
  );

  const result = await form16DowntimeService.syncPlannedIdleHalfYear();

  assert.deepEqual(result, { total: 0 });
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(replaceMock.mock.callCount(), 2);
});
