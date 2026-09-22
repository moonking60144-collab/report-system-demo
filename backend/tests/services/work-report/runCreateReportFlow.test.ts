import test from "node:test";
import assert from "node:assert/strict";
import { ragicClient, type RagicRecord } from "../../../src/ragic/client";
import { getFormConfig } from "../../../src/config/forms";
import { env, resolveWritePath } from "../../../src/config/env";
import {
  runCreateReportFlow,
  type CreateReportBatchSharedState,
} from "../../../src/services/work-report/mutation/runCreateReportFlow";
import { createReportFlowDeps } from "../../../src/services/work-report/mutation/createReportFlowDeps";
import { activityLogWriteReverifyService } from "../../../src/services/activityLog/activityLogWriteReverifyService";
import type { ActivityLogWriteReverifyTask } from "../../../src/services/activityLog/activityLogWriteReverifyService";
import { ActivityLogWriteReverifyService } from "../../../src/services/activityLog/activityLogWriteReverifyService";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { initializeReadModelSchema } from "../../../src/storage/sqlite/readModelSchema";
import { batchCreateRowKeyRepository, createBatchCreateRowKeyRepository } from "../../../src/storage/sqlite/batchCreateRowKeyRepository";
import { createRowWithIdempotency } from "../../../src/services/work-report/workReportBatchCreateTaskService";

type RunCreateReportDeps = Parameters<typeof runCreateReportFlow>[0]["deps"];
type EnqueueReverifyInput = Parameters<typeof activityLogWriteReverifyService.enqueue>[0];

test("批次 enqueue EIO → rollback unknown → 補驗 gone 可解除原空 row reservation", async (t) => {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  t.after(() => db.close());
  await initializeReadModelSchema(db);
  const rowKeyRepo = createBatchCreateRowKeyRepository(async () => db);
  t.mock.method(batchCreateRowKeyRepository, "deleteByReservationIdentity", rowKeyRepo.deleteByReservationIdentity);
  const dir = await fs.mkdtemp(join(tmpdir(), "batch-rollback-recovery-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const serviceOptions = { enabled: true, storeFile: join(dir, "tasks.json"), refreshWorkReportAfterEntryGone: async () => {} };
  const service = new ActivityLogWriteReverifyService(serviceOptions);
  const originalWrite = fs.writeFile;
  let writes = 0;
  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (++writes === 1) throw new Error("temporary snapshot EIO");
    return originalWrite(...args);
  });
  t.mock.method(ragicClient, "createEntry", async () => ({ [CREATED_ROW_ID]: {} }));
  let reads = 0;
  t.mock.method(ragicClient, "observeEntry", async () => {
    if (++reads === 1) return { kind: "found" as const, record: { [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: "WRONG" } };
    if (reads === 2) throw new Error("rollback read timeout");
    return { kind: "gone" as const };
  });
  const remove = t.mock.method(ragicClient, "deleteEntry", async () => {});
  const row = { clientRowKey: "batch-recovery-key", payload: createPayload() };
  const deps = createDeps({ mode: "batch" });
  deps.activityLog.enqueueReverify = service.enqueue.bind(service);
  await assert.rejects(createRowWithIdempotency({ row, formId: FORM_ID, entryId: ENTRY_ID, rowKeyRepo,
    createRow: (payload, reservation) => runCreateReportFlow({ formId: FORM_ID, entryId: ENTRY_ID, payload, deps,
      options: { batchReservation: reservation, mode: { kind: "batch", shared: { latestRows: [], workOrderNo: WORK_ORDER_NO } } } }),
  }), { code: "BATCH_CREATE_ROW_INDETERMINATE" });
  const oldReservation = (await rowKeyRepo.lookup(row.clientRowKey))!;
  assert.equal(oldReservation.status, "indeterminate");
  assert.equal(oldReservation.ragicRowId, "");
  const restarted = new ActivityLogWriteReverifyService(serviceOptions);
  assert.equal((await restarted.listTasks())[0]?.idempotencyReservationToken, oldReservation.reservationToken);
  await restarted.runOnce();
  assert.equal(await rowKeyRepo.lookup(row.clientRowKey), null);
  assert.equal(remove.mock.callCount(), 1);
  const next = await rowKeyRepo.reservePending({ clientRowKey: row.clientRowKey, formId: FORM_ID, entryId: ENTRY_ID });
  assert.notEqual(next.record?.reservationToken, oldReservation.reservationToken);
  assert.equal(await rowKeyRepo.deleteByReservationIdentity({ clientRowKey: row.clientRowKey, formId: FORM_ID,
    entryId: ENTRY_ID, reservationToken: oldReservation.reservationToken!, ragicRowId: CREATED_ROW_ID }), 0);
  await rowKeyRepo.markIndeterminate({ clientRowKey: row.clientRowKey, formId: FORM_ID, entryId: ENTRY_ID,
    reservationToken: oldReservation.reservationToken, errorMessage: "late owner" });
  assert.equal((await rowKeyRepo.lookup(row.clientRowKey))?.status, "pending");
});

test("批次建立遇到真實 enqueue 存檔失敗會改走同步驗證", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "activityLog-batch-persist-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const service = new ActivityLogWriteReverifyService({ enabled: true, storeFile: join(dir, "tasks.json") });
  t.mock.method(fs, "writeFile", async () => { throw new Error("snapshot EIO"); });
  t.mock.method(ragicClient, "createEntry", async () => ({ [CREATED_ROW_ID]: {} }));
  const observe = t.mock.method(ragicClient, "observeEntry", async () => ({ kind: "found" as const,
    record: { [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: WORK_ORDER_NO,
      [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: REPORT_TYPE } }));
  const deps = createDeps({ mode: "batch" });
  deps.activityLog.enqueueReverify = service.enqueue.bind(service);
  const result = await runCreateReportFlow({ formId: FORM_ID, entryId: ENTRY_ID, payload: createPayload(),
    options: { mode: { kind: "batch", shared: { latestRows: [], workOrderNo: WORK_ORDER_NO } } }, deps });
  assert.equal(result.rowId, CREATED_ROW_ID);
  assert.equal(observe.mock.callCount(), 1);
  assert.equal(service.getStats().storeUnavailable, true);
});

const FORM_ID = "901";
const ENTRY_ID = "90002";
const CREATED_ROW_ID = "120001";
const WORK_ORDER_NO = "WO-TEST-1";
const REPORT_TYPE = "PROC-A";

function createPayload(): Record<string, unknown> {
  return {
    date: "2026/06/17",
    processCode: "PA",
    reportType: REPORT_TYPE,
    machineId: "MB50",
    operatorId: "RA004",
    operatorName: "示範帳號",
    startTime: "08:00",
    endTime: "17:00",
    productionQty: 10,
  };
}

function createReverifyTask(input: EnqueueReverifyInput): ActivityLogWriteReverifyTask {
  const now = new Date().toISOString();
  return {
    key: `${input.activityLogPath}::${input.entryId}`,
    source: input.source,
    activityLogPath: input.activityLogPath,
    entryId: input.entryId,
    expected: input.expected,
    status: "pending",
    attempts: 0,
    createdAt: input.occurredAt,
    updatedAt: now,
    lastError: input.errorMessage,
    ...(input.workReportFormId ? { workReportFormId: input.workReportFormId } : {}),
    ...(input.workReportEntryId ? { workReportEntryId: input.workReportEntryId } : {}),
    ...(input.workOrderNo ? { workOrderNo: input.workOrderNo } : {}),
    ...(input.clientRowKey ? { clientRowKey: input.clientRowKey } : {}),
    ...(input.idempotencySource ? { idempotencySource: input.idempotencySource } : {}),
    ...(input.idempotencyReservationToken
      ? { idempotencyReservationToken: input.idempotencyReservationToken }
      : {}),
  };
}

function createDeps(options: {
  mode: "single" | "batch";
  latestRowsAfterCreate?: RagicRecord;
  onAssertEntryNotModified?: (
    formId: string,
    entryId: string,
    expectedEntryLastUpdatedAt?: string
  ) => void;
}): RunCreateReportDeps {
  const config = getFormConfig(FORM_ID);
  let getRawEntryCallCount = 0;
  const beforeEntry: RagicRecord = {
    [config.mainFields.workOrderNo]: WORK_ORDER_NO,
    [config.writeConfig.subtableId]: {},
  };
  const latestEntry: RagicRecord =
    options.latestRowsAfterCreate ??
    {
      [config.mainFields.workOrderNo]: WORK_ORDER_NO,
      [config.writeConfig.subtableId]: {
        [CREATED_ROW_ID]: {
          [config.writeConfig.subtableWriteFields.operatorId]: "RA004",
          [config.writeConfig.subtableWriteFields.operatorName]: "示範帳號",
          [config.writeConfig.subtableWriteFields.totalWorkTime]: 8,
        },
      },
    };

  return createReportFlowDeps({
    entry: {
      assertEntryNotModified: async (formId, entryId, expectedEntryLastUpdatedAt) => {
        options.onAssertEntryNotModified?.(formId, entryId, expectedEntryLastUpdatedAt);
      },
      getRawEntry: async () => {
        if (options.mode === "batch") {
          throw new Error("batch mode should reuse shared rows and skip raw entry reads");
        }
        getRawEntryCallCount += 1;
        return getRawEntryCallCount === 1 ? beforeEntry : latestEntry;
      },
      getFormOptions: async () => ({ machineId: [] }),
    },
    payload: {
      validateReportPayload: () => undefined,
      normalizePayloadForWrite: async (_formId, _config, payload) => payload,
      buildSubtableRowData: (payload, configForBuild) => ({
        [configForBuild.writeConfig.subtableWriteFields.processCode]: payload.processCode,
        [configForBuild.writeConfig.subtableWriteFields.machineId]: payload.machineId,
        [configForBuild.writeConfig.subtableWriteFields.operatorId]: payload.operatorId,
        [configForBuild.writeConfig.subtableWriteFields.operatorName]: payload.operatorName,
        [configForBuild.writeConfig.subtableWriteFields.productionQty]: payload.productionQty,
      }),
    },
    activityLog: {
      resolveActivityLogRequiredFields: async () => ({
        depUnit: "P01加工一組",
        prodType: "PA",
        source: "test",
      }),
      findLikelyCreatedRow: () => null,
      buildCreateRecalculateFlowDeps: () => ({
        sleep: async () => undefined,
        resolveActionTargets: () => [],
        executeSaveActionButton: async () => ({
          status: "SUCCESS",
          code: 0,
          msg: "ok",
          raw: { status: "SUCCESS" },
        }),
        verifyRecalculateCompletion: async () => ({
          completed: true,
          attempts: 1,
          lastCheck: {
            needsRecalculate: false,
            missingFields: [],
            checkedFields: [],
            formulaGaps: [],
          },
        }),
        buildActivityLogFallbackWritePayload: () => ({}),
        simulateActivityLogRowSave: async () => undefined,
        shouldUseComputedTotalWorkTimeFallback: () => false,
        getSubtableRowDataByRowId: async () => null,
        computeTotalWorkTimeHours: () => null,
        writeComputedTotalWorkTime: async () => undefined,
        log: () => undefined,
        warn: () => undefined,
      }),
      throwRagicHttpError: (error, optionsForError): never => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${optionsForError.code}: ${optionsForError.messagePrefix}: ${message}`);
      },
    },
    diagnostics: {
      logCreateOperatorDiagnostics: () => undefined,
      buildOperatorDebugSnapshot: () => ({}),
      logOperatorDebugSnapshot: () => undefined,
      logCreatePerformanceIfSlow: () => undefined,
    },
    cache: {
      markReportFullCacheDirty: () => undefined,
    },
  });
}

test("runCreateReportFlow 批次模式只排背景 ActivityLog reverify，不同步讀 live entry", async (t) => {
  const createEntryMock = t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () => {
    throw new Error("batch should not call live verify");
  });
  const enqueueMock = t.mock.method(
    activityLogWriteReverifyService,
    "enqueue",
    async (input: EnqueueReverifyInput) => createReverifyTask(input)
  );

  const shared: CreateReportBatchSharedState = {
    latestRows: [],
    workOrderNo: WORK_ORDER_NO,
  };

  const result = await runCreateReportFlow({
    formId: FORM_ID,
    entryId: ENTRY_ID,
    payload: createPayload(),
    options: { mode: { kind: "batch", shared } },
    deps: createDeps({ mode: "batch" }),
  });

  assert.equal(result.rowId, CREATED_ROW_ID);
  assert.equal(createEntryMock.mock.callCount(), 1);
  const createPayloadArg = createEntryMock.mock.calls[0]?.arguments[1] as Record<string, unknown>;
  assert.equal(createPayloadArg[env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID], REPORT_TYPE);
  assert.equal(getEntryMock.mock.callCount(), 0);
  assert.equal(enqueueMock.mock.callCount(), 1);
  const enqueuePayload = enqueueMock.mock.calls[0]?.arguments[0];
  assert.match(enqueuePayload.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    { ...enqueuePayload, occurredAt: "<iso-time>" },
    {
    activityLogPath: resolveWritePath("903", env.UPSTREAM_ACTIVITY_LOG_PATH),
    entryId: CREATED_ROW_ID,
    expected: { workOrderNo: WORK_ORDER_NO, type: REPORT_TYPE },
    readPriority: "background",
    timeoutMs: env.ACTIVITY_LOG_WRITE_REVERIFY_TIMEOUT_MS,
    maxRetries: env.ACTIVITY_LOG_WRITE_REVERIFY_MAX_RETRIES,
    errorMessage: "batch-create-deferred-verify",
      occurredAt: "<iso-time>",
    source: "work-report-batch-create",
    workReportFormId: FORM_ID,
    workReportEntryId: ENTRY_ID,
    workOrderNo: WORK_ORDER_NO,
    }
  );
});

test("runCreateReportFlow 批次模式可跳過列內 preflight，避免每列重複 live GET", async (t) => {
  t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  t.mock.method(
    activityLogWriteReverifyService,
    "enqueue",
    async (input: EnqueueReverifyInput) => createReverifyTask(input)
  );

  let preflightCalls = 0;
  const shared: CreateReportBatchSharedState = {
    latestRows: [],
    workOrderNo: WORK_ORDER_NO,
  };

  const result = await runCreateReportFlow({
    formId: FORM_ID,
    entryId: ENTRY_ID,
    payload: createPayload(),
    options: {
      expectedEntryLastUpdatedAt: "2026-07-02T00:00:00.000Z",
      mode: { kind: "batch", shared },
      skipEntryPreflight: true,
    },
    deps: createDeps({
      mode: "batch",
      onAssertEntryNotModified: () => {
        preflightCalls += 1;
      },
    }),
  });

  assert.equal(result.rowId, CREATED_ROW_ID);
  assert.equal(preflightCalls, 0);
});

test("runCreateReportFlow 批次模式排不進 reverify 時退回同步驗證", async (t) => {
  t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () => ({
    kind: "found" as const,
    record: {
      [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: WORK_ORDER_NO,
      [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: REPORT_TYPE,
    },
  }));
  const enqueueMock = t.mock.method(
    activityLogWriteReverifyService,
    "enqueue",
    async () => null
  );

  const shared: CreateReportBatchSharedState = {
    latestRows: [],
    workOrderNo: WORK_ORDER_NO,
  };

  const result = await runCreateReportFlow({
    formId: FORM_ID,
    entryId: ENTRY_ID,
    payload: createPayload(),
    options: { mode: { kind: "batch", shared } },
    deps: createDeps({ mode: "batch" }),
  });

  assert.equal(result.rowId, CREATED_ROW_ID);
  assert.equal(enqueueMock.mock.callCount(), 1);
  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.deepEqual(getEntryMock.mock.calls[0]?.arguments, [
    resolveWritePath("903", env.UPSTREAM_ACTIVITY_LOG_PATH),
    CREATED_ROW_ID,
    {
      priority: "user",
      timeoutMs: env.ACTIVITY_LOG_WRITE_VERIFY_TIMEOUT_MS,
      maxRetries: env.ACTIVITY_LOG_WRITE_VERIFY_MAX_RETRIES,
    },
  ]);
});

test("runCreateReportFlow 單筆模式仍同步讀回 ActivityLog entry 驗證", async (t) => {
  t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  const getEntryMock = t.mock.method(ragicClient, "observeEntry", async () => ({
    kind: "found" as const,
    record: {
      [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: WORK_ORDER_NO,
      [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: REPORT_TYPE,
      [getFormConfig(FORM_ID).writeConfig.subtableWriteFields.operatorId]: "RA004",
      [getFormConfig(FORM_ID).writeConfig.subtableWriteFields.operatorName]: "示範帳號",
      [getFormConfig(FORM_ID).writeConfig.subtableWriteFields.totalWorkTime]: 8,
    },
  }));
  const enqueueMock = t.mock.method(
    activityLogWriteReverifyService,
    "enqueue",
    async (input: EnqueueReverifyInput) => createReverifyTask(input)
  );

  let preflightCalls = 0;
  const deps = createDeps({
    mode: "single",
    onAssertEntryNotModified: (formId, entryId, expectedEntryLastUpdatedAt) => {
      preflightCalls += 1;
      assert.equal(formId, FORM_ID);
      assert.equal(entryId, ENTRY_ID);
      assert.equal(expectedEntryLastUpdatedAt, "2026-07-02T00:00:00.000Z");
    },
  });
  const getRawEntryMock = t.mock.fn(deps.entry.getRawEntry);
  const result = await runCreateReportFlow({
    formId: FORM_ID,
    entryId: ENTRY_ID,
    payload: createPayload(),
    options: { expectedEntryLastUpdatedAt: "2026-07-02T00:00:00.000Z" },
    deps: {
      ...deps,
      entry: { ...deps.entry, getRawEntry: getRawEntryMock },
    },
  });

  assert.equal(result.rowId, CREATED_ROW_ID);
  assert.equal(preflightCalls, 1);
  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.deepEqual(getEntryMock.mock.calls[0]?.arguments, [
    resolveWritePath("903", env.UPSTREAM_ACTIVITY_LOG_PATH),
    CREATED_ROW_ID,
    {
      priority: "user",
      timeoutMs: env.ACTIVITY_LOG_WRITE_VERIFY_TIMEOUT_MS,
      maxRetries: env.ACTIVITY_LOG_WRITE_VERIFY_MAX_RETRIES,
    },
  ]);
  assert.equal(enqueueMock.mock.callCount(), 0);
  assert.equal(getRawEntryMock.mock.callCount(), 1);
});

test("runCreateReportFlow 在建立 context 前才載入狀態 snapshot，且 verified entry 免再輪詢母表", async (t) => {
  const config = getFormConfig(FORM_ID);
  const preconditionEntrySnapshot: RagicRecord = {
    [config.mainFields.workOrderNo]: WORK_ORDER_NO,
    [config.mainFields.status]: "未結案",
    [config.mainFields.machineCode]: "MA33",
    [config.writeConfig.subtableId]: {},
  };
  t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  t.mock.method(ragicClient, "observeEntry", async () => ({
    kind: "found" as const,
    record: {
      [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: WORK_ORDER_NO,
      [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: REPORT_TYPE,
      [config.writeConfig.subtableWriteFields.operatorId]: "RA004",
      [config.writeConfig.subtableWriteFields.operatorName]: "示範帳號",
      [config.writeConfig.subtableWriteFields.totalWorkTime]: 8,
    },
  }));
  const callOrder: string[] = [];
  const baseDeps = createDeps({ mode: "single" });
  const deps: RunCreateReportDeps = {
    ...baseDeps,
    payload: {
      ...baseDeps.payload,
      normalizePayloadForWrite: async (_formId, _config, payload) => {
        callOrder.push("normalize");
        return payload;
      },
    },
    entry: {
      ...baseDeps.entry,
      getFormOptions: async () => {
        callOrder.push("form-options");
        return {
          machineId: [
            {
              value: "MA33",
              label: "MA33 - 滾牙機",
              display: "滾牙機",
              machineDefault: {
                machineCode: "MA33",
                processCode: "A02",
                status: "使用中",
              },
            },
          ],
        };
      },
    },
  };
  const getRawEntryMock = t.mock.fn(async () => {
    throw new Error("precondition snapshot 與 verified entry 命中時不應讀母表");
  });

  const result = await runCreateReportFlow({
    formId: FORM_ID,
    entryId: ENTRY_ID,
    payload: { ...createPayload(), processCode: "" },
    options: {
      skipEntryPreflight: true,
      loadPreconditionEntrySnapshot: async () => {
        callOrder.push("precondition-read");
        return preconditionEntrySnapshot;
      },
    },
    deps: {
      ...deps,
      entry: { ...deps.entry, getRawEntry: getRawEntryMock },
    },
  });

  assert.equal(result.rowId, CREATED_ROW_ID);
  assert.equal(getRawEntryMock.mock.callCount(), 0);
  assert.deepEqual(callOrder, ["form-options", "precondition-read", "normalize"]);
});

test("runCreateReportFlow 單筆讀回狀態未知時保留 idempotency identity 給背景補驗", async (t) => {
  const config = getFormConfig(FORM_ID);
  t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  t.mock.method(ragicClient, "observeEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  const enqueueMock = t.mock.method(
    activityLogWriteReverifyService,
    "enqueue",
    async (input: EnqueueReverifyInput) => createReverifyTask(input)
  );
  const deps = createDeps({ mode: "single" });
  const getRawEntryMock = t.mock.fn(async () => ({
    [config.mainFields.workOrderNo]: WORK_ORDER_NO,
    [config.writeConfig.subtableId]: {
      [CREATED_ROW_ID]: {
        [config.writeConfig.subtableWriteFields.operatorId]: "RA004",
        [config.writeConfig.subtableWriteFields.operatorName]: "示範帳號",
        [config.writeConfig.subtableWriteFields.totalWorkTime]: 8,
      },
    },
  }));

  const result = await runCreateReportFlow({
    formId: FORM_ID,
    entryId: ENTRY_ID,
    payload: createPayload(),
    options: {
      clientMutationId: "mutation-row-1",
      clientMutationFingerprint: "fingerprint-1",
      idempotencyReservationToken: "reservation-1",
      loadPreconditionEntrySnapshot: async () => ({
        [config.mainFields.workOrderNo]: WORK_ORDER_NO,
        [config.writeConfig.subtableId]: {},
      }),
    },
    deps: {
      ...deps,
      entry: { ...deps.entry, getRawEntry: getRawEntryMock },
    },
  });

  assert.equal(result.rowId, CREATED_ROW_ID);
  assert.equal(enqueueMock.mock.callCount(), 1);
  assert.equal(enqueueMock.mock.calls[0]?.arguments[0].source, "work-report-create");
  assert.equal(enqueueMock.mock.calls[0]?.arguments[0].clientRowKey, "mutation-row-1");
  assert.equal(enqueueMock.mock.calls[0]?.arguments[0].idempotencySource, "work-report-901");
  assert.equal(
    enqueueMock.mock.calls[0]?.arguments[0].idempotencyReservationToken,
    "reservation-1"
  );
  assert.equal(getRawEntryMock.mock.callCount(), 1);
});

test("runCreateReportFlow 缺 processCode 時可由機台預設補上", async (t) => {
  t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  t.mock.method(ragicClient, "observeEntry", async () => ({
    kind: "found" as const,
    record: {
      [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: WORK_ORDER_NO,
      [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: REPORT_TYPE,
    },
  }));
  t.mock.method(
    activityLogWriteReverifyService,
    "enqueue",
    async (input: EnqueueReverifyInput) => createReverifyTask(input)
  );
  const config = getFormConfig(FORM_ID);
  const deps = createDeps({ mode: "single" });
  const normalizePayloadMock = t.mock.fn(deps.payload.normalizePayloadForWrite);
  let getRawEntryCallCount = 0;
  const createDepsWithMachineDefaults: RunCreateReportDeps = {
    ...deps,
    payload: {
      ...deps.payload,
      validateReportPayload: (payload, requiredFields) => {
        assert.equal(payload.processCode, "A02");
        for (const requiredField of requiredFields) {
          assert.notEqual(payload[requiredField], "");
        }
      },
      normalizePayloadForWrite: normalizePayloadMock,
    },
    entry: {
      ...deps.entry,
      getRawEntry: async () => {
        getRawEntryCallCount += 1;
        if (getRawEntryCallCount === 1) {
          return {
            [config.mainFields.workOrderNo]: WORK_ORDER_NO,
            [config.mainFields.machineCode]: "MA33",
            [config.mainFields.defaultProcessCode]: "",
            [config.writeConfig.subtableId]: {},
          };
        }
        return {
          [config.mainFields.workOrderNo]: WORK_ORDER_NO,
          [config.writeConfig.subtableId]: {
            [CREATED_ROW_ID]: {
              [config.writeConfig.subtableWriteFields.operatorId]: "RA004",
              [config.writeConfig.subtableWriteFields.operatorName]: "示範帳號",
              [config.writeConfig.subtableWriteFields.totalWorkTime]: 8,
            },
          },
        };
      },
      getFormOptions: async () => ({
        machineId: [
          {
            value: "MA33",
            label: "MA33 - 滾牙機",
            display: "滾牙機",
            machineDefault: {
              machineCode: "MA33",
              processCode: "A02",
              status: "使用中",
            },
          },
        ],
      }),
    },
  };

  const payload = {
    ...createPayload(),
    processCode: "",
    reportType: "",
  };

  await runCreateReportFlow({
    formId: FORM_ID,
    entryId: ENTRY_ID,
    payload,
    deps: createDepsWithMachineDefaults,
  });

  assert.equal(normalizePayloadMock.mock.callCount(), 1);
  assert.equal(normalizePayloadMock.mock.calls[0]?.arguments[2].processCode, "A02");
});
