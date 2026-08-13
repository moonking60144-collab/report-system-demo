import test from "node:test";
import assert from "node:assert/strict";
import { ragicClient, type RagicRecord } from "../../../src/ragic/client";
import { getFormConfig } from "../../../src/config/forms";
import { env, resolveWritePath } from "../../../src/config/env";
import {
  runCreateReportFlow,
  type CreateReportBatchSharedState,
} from "../../../src/services/work-report/mutation/runCreateReportFlow";
import { form16WriteReverifyService } from "../../../src/services/form16/form16WriteReverifyService";
import type { Form16WriteReverifyTask } from "../../../src/services/form16/form16WriteReverifyService";

type RunCreateReportDeps = Parameters<typeof runCreateReportFlow>[0]["deps"];
type EnqueueReverifyInput = Parameters<typeof form16WriteReverifyService.enqueue>[0];

const FORM_ID = "104";
const ENTRY_ID = "17382";
const CREATED_ROW_ID = "120001";
const WORK_ORDER_NO = "WO-TEST-1";
const REPORT_TYPE = "TI搓牙";

function createPayload(): Record<string, unknown> {
  return {
    date: "2026/06/17",
    processCode: "TI",
    reportType: REPORT_TYPE,
    machineId: "P10",
    operatorId: "RA004",
    operatorName: "羅智加",
    startTime: "08:00",
    endTime: "17:00",
    productionQty: 10,
  };
}

function createReverifyTask(input: EnqueueReverifyInput): Form16WriteReverifyTask {
  const now = new Date().toISOString();
  return {
    key: `${input.form16Path}::${input.entryId}`,
    source: input.source,
    form16Path: input.form16Path,
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
          [config.writeConfig.subtableWriteFields.operatorName]: "羅智加",
          [config.writeConfig.subtableWriteFields.totalWorkTime]: 8,
        },
      },
    };

  return {
    assertEntryNotModified: async (formId, entryId, expectedEntryLastUpdatedAt) => {
      options.onAssertEntryNotModified?.(formId, entryId, expectedEntryLastUpdatedAt);
    },
    validateReportPayload: () => undefined,
    normalizePayloadForWrite: async (_formId, _config, payload) => payload,
    getRawEntry: async () => {
      if (options.mode === "batch") {
        throw new Error("batch mode should reuse shared rows and skip raw entry reads");
      }
      getRawEntryCallCount += 1;
      return getRawEntryCallCount === 1 ? beforeEntry : latestEntry;
    },
    getFormOptions: async () => ({
      machineId: [],
    }),
    buildSubtableRowData: (payload, configForBuild) => ({
      [configForBuild.writeConfig.subtableWriteFields.processCode]: payload.processCode,
      [configForBuild.writeConfig.subtableWriteFields.machineId]: payload.machineId,
      [configForBuild.writeConfig.subtableWriteFields.operatorId]: payload.operatorId,
      [configForBuild.writeConfig.subtableWriteFields.operatorName]: payload.operatorName,
      [configForBuild.writeConfig.subtableWriteFields.productionQty]: payload.productionQty,
    }),
    resolveForm16RequiredFields: async () => ({
      depUnit: "C02搓牙組",
      prodType: "TI",
      source: "test",
    }),
    logCreateOperatorDiagnostics: () => undefined,
    buildOperatorDebugSnapshot: () => ({}),
    logOperatorDebugSnapshot: () => undefined,
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
      buildForm16FallbackWritePayload: () => ({}),
      simulateForm16RowSave: async () => undefined,
      shouldUseComputedTotalWorkTimeFallback: () => false,
      getSubtableRowDataByRowId: async () => null,
      computeTotalWorkTimeHours: () => null,
      writeComputedTotalWorkTime: async () => undefined,
      log: () => undefined,
      warn: () => undefined,
    }),
    logCreatePerformanceIfSlow: () => undefined,
    markReportFullCacheDirty: () => undefined,
    throwRagicHttpError: (error, optionsForError): never => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${optionsForError.code}: ${optionsForError.messagePrefix}: ${message}`);
    },
  };
}

test("runCreateReportFlow 批次模式只排背景 Form16 reverify，不同步讀 live entry", async (t) => {
  const createEntryMock = t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () => {
    throw new Error("batch should not call live verify");
  });
  const enqueueMock = t.mock.method(
    form16WriteReverifyService,
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
  assert.equal(createPayloadArg[env.RAGIC_FORM_16_TYPE_FIELD_ID], REPORT_TYPE);
  assert.equal(getEntryMock.mock.callCount(), 0);
  assert.equal(enqueueMock.mock.callCount(), 1);
  const enqueuePayload = enqueueMock.mock.calls[0]?.arguments[0];
  assert.match(enqueuePayload.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    { ...enqueuePayload, occurredAt: "<iso-time>" },
    {
    form16Path: resolveWritePath("16", env.RAGIC_FORM_16_PATH),
    entryId: CREATED_ROW_ID,
    expected: { workOrderNo: WORK_ORDER_NO, type: REPORT_TYPE },
    readPriority: "background",
    timeoutMs: env.FORM16_WRITE_REVERIFY_TIMEOUT_MS,
    maxRetries: env.FORM16_WRITE_REVERIFY_MAX_RETRIES,
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
    form16WriteReverifyService,
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
  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () => ({
    [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID]: WORK_ORDER_NO,
    [env.RAGIC_FORM_16_TYPE_FIELD_ID]: REPORT_TYPE,
  }));
  const enqueueMock = t.mock.method(
    form16WriteReverifyService,
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
    resolveWritePath("16", env.RAGIC_FORM_16_PATH),
    CREATED_ROW_ID,
    false,
    {
      priority: "user",
      timeoutMs: env.FORM16_WRITE_VERIFY_TIMEOUT_MS,
      maxRetries: env.FORM16_WRITE_VERIFY_MAX_RETRIES,
    },
  ]);
});

test("runCreateReportFlow 單筆模式仍同步讀回 Form16 entry 驗證", async (t) => {
  t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  const getEntryMock = t.mock.method(ragicClient, "getEntry", async () => ({
    [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID]: WORK_ORDER_NO,
    [env.RAGIC_FORM_16_TYPE_FIELD_ID]: REPORT_TYPE,
    [getFormConfig(FORM_ID).writeConfig.subtableWriteFields.operatorId]: "RA004",
    [getFormConfig(FORM_ID).writeConfig.subtableWriteFields.operatorName]: "羅智加",
    [getFormConfig(FORM_ID).writeConfig.subtableWriteFields.totalWorkTime]: 8,
  }));
  const enqueueMock = t.mock.method(
    form16WriteReverifyService,
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
  const getRawEntryMock = t.mock.fn(deps.getRawEntry);
  const result = await runCreateReportFlow({
    formId: FORM_ID,
    entryId: ENTRY_ID,
    payload: createPayload(),
    options: { expectedEntryLastUpdatedAt: "2026-07-02T00:00:00.000Z" },
    deps: { ...deps, getRawEntry: getRawEntryMock },
  });

  assert.equal(result.rowId, CREATED_ROW_ID);
  assert.equal(preflightCalls, 1);
  assert.equal(getEntryMock.mock.callCount(), 1);
  assert.deepEqual(getEntryMock.mock.calls[0]?.arguments, [
    resolveWritePath("16", env.RAGIC_FORM_16_PATH),
    CREATED_ROW_ID,
    false,
    {
      priority: "user",
      timeoutMs: env.FORM16_WRITE_VERIFY_TIMEOUT_MS,
      maxRetries: env.FORM16_WRITE_VERIFY_MAX_RETRIES,
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
    [config.mainFields.machineCode]: "R3",
    [config.writeConfig.subtableId]: {},
  };
  t.mock.method(ragicClient, "createEntry", async () => ({
    [CREATED_ROW_ID]: {},
  }));
  t.mock.method(ragicClient, "getEntry", async () => ({
    [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID]: WORK_ORDER_NO,
    [env.RAGIC_FORM_16_TYPE_FIELD_ID]: REPORT_TYPE,
    [config.writeConfig.subtableWriteFields.operatorId]: "RA004",
    [config.writeConfig.subtableWriteFields.operatorName]: "羅智加",
    [config.writeConfig.subtableWriteFields.totalWorkTime]: 8,
  }));
  const callOrder: string[] = [];
  const deps: RunCreateReportDeps = {
    ...createDeps({ mode: "single" }),
    normalizePayloadForWrite: async (_formId, _config, payload) => {
      callOrder.push("normalize");
      return payload;
    },
    getFormOptions: async () => {
      callOrder.push("form-options");
      return {
        machineId: [
          {
            value: "R3",
            label: "R3 - 滾牙機",
            display: "滾牙機",
            machineDefault: {
              machineCode: "R3",
              processCode: "TI02",
              status: "使用中",
            },
          },
        ],
      };
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
    deps: { ...deps, getRawEntry: getRawEntryMock },
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
  t.mock.method(ragicClient, "getEntry", async () => {
    throw new Error("ECONNABORTED");
  });
  const enqueueMock = t.mock.method(
    form16WriteReverifyService,
    "enqueue",
    async (input: EnqueueReverifyInput) => createReverifyTask(input)
  );
  const deps = createDeps({ mode: "single" });
  const getRawEntryMock = t.mock.fn(async () => ({
    [config.mainFields.workOrderNo]: WORK_ORDER_NO,
    [config.writeConfig.subtableId]: {
      [CREATED_ROW_ID]: {
        [config.writeConfig.subtableWriteFields.operatorId]: "RA004",
        [config.writeConfig.subtableWriteFields.operatorName]: "羅智加",
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
    deps: { ...deps, getRawEntry: getRawEntryMock },
  });

  assert.equal(result.rowId, CREATED_ROW_ID);
  assert.equal(enqueueMock.mock.callCount(), 1);
  assert.equal(enqueueMock.mock.calls[0]?.arguments[0].source, "work-report-create");
  assert.equal(enqueueMock.mock.calls[0]?.arguments[0].clientRowKey, "mutation-row-1");
  assert.equal(enqueueMock.mock.calls[0]?.arguments[0].idempotencySource, "work-report-104");
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
  t.mock.method(ragicClient, "getEntry", async () => ({
    [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID]: WORK_ORDER_NO,
    [env.RAGIC_FORM_16_TYPE_FIELD_ID]: REPORT_TYPE,
  }));
  t.mock.method(
    form16WriteReverifyService,
    "enqueue",
    async (input: EnqueueReverifyInput) => createReverifyTask(input)
  );
  const config = getFormConfig(FORM_ID);
  const deps = createDeps({ mode: "single" });
  const normalizePayloadMock = t.mock.fn(deps.normalizePayloadForWrite);
  let getRawEntryCallCount = 0;
  const createDepsWithMachineDefaults: RunCreateReportDeps = {
    ...deps,
    validateReportPayload: (payload, requiredFields) => {
      assert.equal(payload.processCode, "TI02");
      for (const requiredField of requiredFields) {
        assert.notEqual(payload[requiredField], "");
      }
    },
    normalizePayloadForWrite: normalizePayloadMock,
    getRawEntry: async () => {
      getRawEntryCallCount += 1;
      if (getRawEntryCallCount === 1) {
        return {
          [config.mainFields.workOrderNo]: WORK_ORDER_NO,
          [config.mainFields.machineCode]: "R3",
          [config.mainFields.defaultProcessCode]: "",
          [config.writeConfig.subtableId]: {},
        };
      }
      return {
        [config.mainFields.workOrderNo]: WORK_ORDER_NO,
        [config.writeConfig.subtableId]: {
          [CREATED_ROW_ID]: {
            [config.writeConfig.subtableWriteFields.operatorId]: "RA004",
            [config.writeConfig.subtableWriteFields.operatorName]: "羅智加",
            [config.writeConfig.subtableWriteFields.totalWorkTime]: 8,
          },
        },
      };
    },
    getFormOptions: async () => ({
      machineId: [
        {
          value: "R3",
          label: "R3 - 滾牙機",
          display: "滾牙機",
          machineDefault: {
            machineCode: "R3",
            processCode: "TI02",
            status: "使用中",
          },
        },
      ],
    }),
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
  assert.equal(normalizePayloadMock.mock.calls[0]?.arguments[2].processCode, "TI02");
});
