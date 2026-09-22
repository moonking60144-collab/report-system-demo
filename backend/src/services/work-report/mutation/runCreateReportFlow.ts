import { env } from "../../../config/env";
import { getFormConfig } from "../../../config/forms";
import type { RagicRecord } from "../../../ragic/client";
import type { FormConfig } from "../../../types/formConfig";
import type { ReportWritePayload } from "../../../types/workReport";
import { HttpError } from "../../../utils/httpError";
import type {
  VerifyNewlyCreatedActivityLogEntryInput,
} from "../../activityLog/activityLogWriteVerifier";
import type {
  EnqueueActivityLogWriteReverifyInput,
  ActivityLogWriteReverifyTask,
} from "../../activityLog/activityLogWriteReverifyService";
import {
  resolveActivityLogReportType as resolveActivityLogReportTypeRule,
} from "../create/activityLogReportTypeRules";
import { evaluatePostCreateRecalculateNeed } from "../create/recalculateInspection";
import { pollCreatedSubtableRow } from "../create/createdRowPolling";
import { prepareCreateReportContext } from "../create/prepareCreateReportContext";
import { resolveCreatePayloadProcessCodeDefault } from "./processCodeDefaults";
import {
  runCreateRecalculateFlow,
  type CreateRecalculateFlowDeps,
} from "../create/recalculateOrchestration";
import type {
  CreateTimingMap,
  CreateTimingStage,
} from "../create/types";
import {
  collectSubtableRows,
  getFirstFieldValue,
  type SubtableRow,
} from "../shared/subtableUtils";
import { isEmptyValue } from "../shared/valueUtils";
import { isObject } from "../shared/ragicRowUtils";
import type { FormOptionMap } from "../workReportOptionsReadService";

export interface CreateReportBatchSharedState {
  latestRows?: SubtableRow[];
  workOrderNo?: string;
  processCodeDefault?: string;
}

export type CreateReportMode =
  | { kind: "single" }
  | { kind: "batch"; shared: CreateReportBatchSharedState };

export interface CreateReportFlowOptions {
  expectedEntryLastUpdatedAt?: string;
  editSessionId?: string;
  editLockVersion?: number;
  mode?: CreateReportMode;
  /**
   * 背景新增是 additive，不用用工令 lastUpdatedAt 漂移擋下；
   * worker 仍保留工令狀態檢查，批次列內也避免每列多打一個 Ragic GET。
   */
  skipEntryPreflight?: boolean;
  /** async worker 延後到建立寫入 context 前才執行 live 狀態檢查，並重用該 raw entry。 */
  loadPreconditionEntrySnapshot?: () => Promise<RagicRecord>;
  /** 本次背景 task attempt 的 UUID；舊 caller 也會 fallback 當 durable create key。 */
  clientMutationId?: string;
  /** 跨 task retry 保持不變，命中 SQLite mapping 時跳過第二次 Ragic create。 */
  createIdempotencyKey?: string;
  /** 與 durable create idempotency key 綁定的 operation/target/payload fingerprint。 */
  clientMutationFingerprint?: string;
  /** 本次 durable idempotency reservation 的唯一 token。 */
  idempotencyReservationToken?: string;
  batchReservation?: { clientRowKey: string; reservationToken?: string };
}

function extractCreatedActivityLogRowId(value: unknown): string | null {
  const pickId = (candidate: unknown): string | null => {
    const normalized = String(candidate ?? "").trim();
    return /^\d+$/.test(normalized) ? normalized : null;
  };

  if (!isObject(value)) {
    return null;
  }

  const directId =
    pickId(value._ragicId) ??
    pickId(value._ragic_id) ??
    pickId(value.id) ??
    pickId(value.entryId) ??
    pickId(value.nodeId);
  if (directId) {
    return directId;
  }

  const data = isObject(value.data) ? value.data : null;
  const nestedId =
    (data
      ? pickId(data._ragicId) ??
        pickId(data._ragic_id) ??
        pickId(data.id) ??
        pickId(data.entryId) ??
        pickId(data.nodeId)
      : null);
  if (nestedId) {
    return nestedId;
  }

  const numericKeys = Object.keys(value).filter((key) => /^\d+$/.test(key));
  if (numericKeys.length === 1) {
    return numericKeys[0];
  }

  return null;
}

export interface CreateReportFlowEntryPort {
  assertEntryNotModified: (
    formId: string,
    entryId: string,
    expectedEntryLastUpdatedAt?: string
  ) => Promise<void>;
  getRawEntry: (
    config: FormConfig,
    entryId: string,
    useCache?: boolean
  ) => Promise<RagicRecord>;
  getFormOptions: (
    formId: string,
    fields?: string[]
  ) => Promise<FormOptionMap>;
}

export interface CreateReportFlowPayloadPort {
  validateReportPayload: (
    payload: ReportWritePayload,
    requiredFields: string[]
  ) => void;
  normalizePayloadForWrite: (
    formId: string,
    config: FormConfig,
    payload: ReportWritePayload
  ) => Promise<ReportWritePayload>;
  buildSubtableRowData: (
    payload: ReportWritePayload,
    config: FormConfig
  ) => RagicRecord;
}

export interface CreateReportFlowActivityLogPort {
  createEntry: (
    formPath: string,
    payload: RagicRecord,
    doWorkflow?: boolean
  ) => Promise<unknown>;
  verifyNewlyCreatedEntry: (
    input: VerifyNewlyCreatedActivityLogEntryInput
  ) => Promise<RagicRecord | null>;
  enqueueReverify: (
    input: EnqueueActivityLogWriteReverifyInput
  ) => Promise<ActivityLogWriteReverifyTask | null>;
  resolveActivityLogRequiredFields: (
    activityLogPath: string,
    workOrderNo: string,
    processCode: string,
    reportType: string
  ) => Promise<{ depUnit: string; prodType: string; source: string }>;
  findLikelyCreatedRow: (
    latestRows: SubtableRow[],
    beforeRowIds: ReadonlySet<string>,
    normalizedPayload: ReportWritePayload,
    config: FormConfig
  ) => SubtableRow | null;
  buildCreateRecalculateFlowDeps: () => CreateRecalculateFlowDeps;
  throwRagicHttpError: (
    error: unknown,
    options: {
      code: "RAGIC_WRITE_FAILED" | "RAGIC_ACTION_BUTTON_FAILED";
      messagePrefix: string;
    }
  ) => never;
}

export interface CreateReportFlowDiagnosticsPort {
  logCreateOperatorDiagnostics: (stage: string, payload: Record<string, unknown>) => void;
  buildOperatorDebugSnapshot: (
    config: FormConfig,
    rowId: string,
    rowData: RagicRecord | null
  ) => Record<string, unknown>;
  logOperatorDebugSnapshot: (
    stage: string,
    payload: Record<string, unknown>
  ) => void;
  logCreatePerformanceIfSlow: (payload: {
    entryId: string;
    rowId: string;
    maxRetry: number;
    retryDelayMs: number;
    didPatch: boolean;
    didActionButton: boolean;
    actionButtonStatus?: string;
    recalculateCompleted?: boolean;
    timings: CreateTimingMap;
    totalMs: number;
  }) => void;
}

export interface CreateReportFlowCachePort {
  markReportFullCacheDirty: (formId: string) => void;
}

export interface CreateReportFlowDeps {
  entry: CreateReportFlowEntryPort;
  payload: CreateReportFlowPayloadPort;
  activityLog: CreateReportFlowActivityLogPort;
  diagnostics: CreateReportFlowDiagnosticsPort;
  cache: CreateReportFlowCachePort;
}

export async function runCreateReportFlow(args: {
  formId: string;
  entryId: string;
  payload: ReportWritePayload;
  options?: CreateReportFlowOptions;
  deps: CreateReportFlowDeps;
}): Promise<{ rowId: string }> {
  const { formId, entryId, payload, options = {}, deps } = args;
  const startedAt = Date.now();
  const createTimings: CreateTimingMap = {
    preflight: 0,
    normalize: 0,
    beforeRead: 0,
    contextRead: 0,
    write: 0,
    verifyWrite: 0,
    polling: 0,
    patch: 0,
    actionButton: 0,
    recalculateVerify: 0,
    fallback: 0,
  };
  const measureStage = async <T>(
    stage: CreateTimingStage,
    task: () => Promise<T>
  ): Promise<T> => {
    const stageStartedAt = Date.now();
    try {
      return await task();
    } finally {
      createTimings[stage] += Date.now() - stageStartedAt;
    }
  };

  const config = getFormConfig(formId);
  if (!options.skipEntryPreflight) {
    await measureStage("preflight", () =>
      deps.entry.assertEntryNotModified(formId, entryId, options.expectedEntryLastUpdatedAt)
    );
  }
  const operatorIdField = config.writeConfig.subtableWriteFields.operatorId;
  const operatorNameField = config.writeConfig.subtableWriteFields.operatorName;
  const operatorIdLabelField = config.subtableFields.operatorId;
  const operatorNameLabelField = config.subtableFields.operatorName;

  const isBatchMode = options.mode?.kind === "batch";
  const batchSharedState =
    options.mode?.kind === "batch" ? options.mode.shared : undefined;
  let beforeEntry: RagicRecord | undefined;
  const loadBeforeEntry = async (): Promise<RagicRecord> => {
    if (beforeEntry) {
      return beforeEntry;
    }
    beforeEntry = await measureStage("beforeRead", () =>
      options.loadPreconditionEntrySnapshot
        ? options.loadPreconditionEntrySnapshot()
        : deps.entry.getRawEntry(config, entryId, false)
    );
    return beforeEntry;
  };
  let beforeRowsFromBatch = batchSharedState?.latestRows;
  let workOrderNoFromBatch = batchSharedState?.workOrderNo;
  let payloadForWrite = payload;
  if (isEmptyValue(payloadForWrite.processCode)) {
    let processCodeDefault =
      batchSharedState && Object.prototype.hasOwnProperty.call(batchSharedState, "processCodeDefault")
        ? batchSharedState.processCodeDefault
        : undefined;
    if (processCodeDefault === undefined) {
      const formOptions = await deps.entry.getFormOptions(formId, ["machineId"]);
      beforeEntry = await loadBeforeEntry();
      processCodeDefault = resolveCreatePayloadProcessCodeDefault(
        config,
        beforeEntry,
        formOptions.machineId ?? []
      );
      if (batchSharedState) {
        batchSharedState.processCodeDefault = processCodeDefault;
      }
    }
    if (!isEmptyValue(processCodeDefault)) {
      payloadForWrite = {
        ...payloadForWrite,
        processCode: processCodeDefault,
      };
    }
  }

  deps.payload.validateReportPayload(payloadForWrite, config.writeConfig.requiredFields);

  const normalizedPayload = await measureStage("normalize", () =>
    deps.payload.normalizePayloadForWrite(formId, config, payloadForWrite)
  );

  if (!beforeRowsFromBatch || !workOrderNoFromBatch) {
    beforeEntry = await loadBeforeEntry();
  }

  const subtableRowData = deps.payload.buildSubtableRowData(normalizedPayload, config);
  subtableRowData[operatorIdField] = normalizedPayload.operatorId;
  subtableRowData[operatorNameField] = normalizedPayload.operatorName;
  if (Object.keys(subtableRowData).length === 0) {
    throw new HttpError(400, "沒有可寫入的欄位", "INVALID_PAYLOAD");
  }

  const {
    beforeRows,
    beforeRowIds,
    workOrderNo,
    activityLogWritePath,
    processCodeForType,
    resolvedReportType,
    resolvedRequiredFields,
    activityLogCreateBody,
  } = await measureStage("contextRead", () =>
    prepareCreateReportContext({
      config,
      entryId,
      beforeEntry,
      beforeRows: beforeRowsFromBatch,
      workOrderNo: workOrderNoFromBatch,
      normalizedPayload,
      subtableRowData,
      resolveActivityLogReportType: async (
        workOrderNoValue,
        processCode,
        requestedReportType
      ) => resolveActivityLogReportTypeRule(workOrderNoValue, processCode, requestedReportType),
      resolveActivityLogRequiredFields: (activityLogPath, workOrderNoValue, processCode, reportType) =>
        deps.activityLog.resolveActivityLogRequiredFields(
          activityLogPath,
          workOrderNoValue,
          processCode,
          reportType
        ),
    })
  );

  deps.diagnostics.logCreateOperatorDiagnostics("before-write", {
    entryId,
    operatorId: normalizedPayload.operatorId,
    operatorName: normalizedPayload.operatorName,
    workOrderNo,
    processCode: processCodeForType,
    reportType: resolvedReportType.type,
    reportTypeSource: resolvedReportType.source,
    depUnit: resolvedRequiredFields.depUnit,
    prodType: resolvedRequiredFields.prodType,
    requiredFieldSource: resolvedRequiredFields.source,
    writePath: activityLogWritePath,
  });

  let createdActivityLogRowId: string | null = null;
  await measureStage("write", async () => {
    try {
      const createResult = await deps.activityLog.createEntry(
        activityLogWritePath,
        activityLogCreateBody,
        true
      );
      createdActivityLogRowId = extractCreatedActivityLogRowId(createResult);
    } catch (error) {
      deps.activityLog.throwRagicHttpError(error, {
        code: "RAGIC_WRITE_FAILED",
        messagePrefix: `建立 Ragic 紀錄失敗（path=${activityLogWritePath}）`,
      });
    }
  });

  // Post-write verify：Ragic 偶爾會回成功但 workOrderNo 沒真的存進去（觀察到的 orphan 來源）
  // 單筆互動立刻讀回來比對；對不起來會自己 DELETE + throw。
  // 批次模式則先排背景 reverify，避免每列都同步等 live Ragic GET；若排不進佇列才退回同步 verify。
  // 只驗 workOrderNo 跟 type；depUnit/prodType 是 Ragic 推算欄位、會被 workflow 轉換，
  // 不適合嚴格比對（會誤殺合法 entry）
  let verifiedActivityLogEntry: RagicRecord | null = null;
  if (createdActivityLogRowId) {
    const activityLogRowId = createdActivityLogRowId;
    const expectedActivityLogEntry = {
      workOrderNo,
      type: resolvedReportType.type,
    };
    const durableCreateKey = options.createIdempotencyKey ?? options.clientMutationId;
    const reverifyIdempotencyIdentity = options.batchReservation
      ? { clientRowKey: options.batchReservation.clientRowKey,
          idempotencyReservationToken: options.batchReservation.reservationToken }
      : durableCreateKey
      ? {
          clientRowKey: durableCreateKey,
          idempotencySource: `work-report-${formId}`,
          ...(options.idempotencyReservationToken
            ? { idempotencyReservationToken: options.idempotencyReservationToken }
            : {}),
        }
      : {};
    const enqueueReverify = async (errorMessage: string) =>
      deps.activityLog.enqueueReverify({
        activityLogPath: activityLogWritePath,
        entryId: activityLogRowId,
        expected: expectedActivityLogEntry,
        readPriority: isBatchMode ? "background" : "user",
        timeoutMs: isBatchMode
          ? env.ACTIVITY_LOG_WRITE_REVERIFY_TIMEOUT_MS
          : env.ACTIVITY_LOG_WRITE_VERIFY_TIMEOUT_MS,
        maxRetries: isBatchMode
          ? env.ACTIVITY_LOG_WRITE_REVERIFY_MAX_RETRIES
          : env.ACTIVITY_LOG_WRITE_VERIFY_MAX_RETRIES,
        errorMessage,
        occurredAt: new Date().toISOString(),
        source: isBatchMode ? "work-report-batch-create" : "work-report-create",
        workReportFormId: formId,
        workReportEntryId: entryId,
        workOrderNo,
        ...reverifyIdempotencyIdentity,
      });

    await measureStage("verifyWrite", async () => {
      if (isBatchMode) {
        const queued = await enqueueReverify("batch-create-deferred-verify").catch((error) => {
          deps.diagnostics.logCreateOperatorDiagnostics("verify-enqueue-failed", {
            entryId,
            rowId: activityLogRowId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        if (queued) {
          deps.diagnostics.logCreateOperatorDiagnostics("verify-deferred", {
            entryId,
            rowId: activityLogRowId,
            source: queued.source,
          });
          return;
        }
      }

      verifiedActivityLogEntry = await deps.activityLog.verifyNewlyCreatedEntry({
        activityLogPath: activityLogWritePath,
        entryId: activityLogRowId,
        expected: expectedActivityLogEntry,
        createOperationId:
          options.idempotencyReservationToken ??
          options.clientMutationId ??
          options.createIdempotencyKey ??
          `work-report-create:${formId}:${entryId}:${activityLogRowId}`,
        options: {
          readPriority: "user",
          timeoutMs: env.ACTIVITY_LOG_WRITE_VERIFY_TIMEOUT_MS,
          maxRetries: env.ACTIVITY_LOG_WRITE_VERIFY_MAX_RETRIES,
          continueOnReadError: true,
          onReadIndeterminate: async (payload) => {
            await deps.activityLog.enqueueReverify({
              ...payload,
              source: isBatchMode ? "work-report-batch-create" : "work-report-create",
              workReportFormId: formId,
              workReportEntryId: entryId,
              workOrderNo,
              ...reverifyIdempotencyIdentity,
            });
          },
        },
      });
    });
  }

  const maxRetry = env.CREATE_POLL_MAX_RETRY;
  const retryDelayMs = env.CREATE_POLL_DELAY_MS;
  const createRecalculateFlowDeps = deps.activityLog.buildCreateRecalculateFlowDeps();
  let latestRows: SubtableRow[] = beforeRows;
  let confirmedTargetRow: SubtableRow | null = null;
  if (isBatchMode && createdActivityLogRowId) {
    confirmedTargetRow = {
      rowId: createdActivityLogRowId,
      rowData: {},
    };
    latestRows = [
      confirmedTargetRow,
      ...beforeRows.filter((row) => row.rowId !== createdActivityLogRowId),
    ];
  } else if (createdActivityLogRowId && verifiedActivityLogEntry) {
    confirmedTargetRow = {
      rowId: createdActivityLogRowId,
      rowData: verifiedActivityLogEntry,
    };
    latestRows = [
      confirmedTargetRow,
      ...beforeRows.filter((row) => row.rowId !== createdActivityLogRowId),
    ];
  } else {
    const { targetRow, latestRows: nextLatestRows, elapsedMs: pollingElapsedMs } = await pollCreatedSubtableRow({
      beforeRowIds,
      beforeRowsCount: beforeRows.length,
      maxRetry,
      retryDelayMs,
      fetchLatestRows: async () => {
        const latestEntry = await deps.entry.getRawEntry(config, entryId, false);
        return collectSubtableRows(latestEntry[config.writeConfig.subtableId]);
      },
      sleep: createRecalculateFlowDeps.sleep,
    });
    createTimings.polling += pollingElapsedMs;
    latestRows = nextLatestRows;
    confirmedTargetRow =
      targetRow ??
      deps.activityLog.findLikelyCreatedRow(
        latestRows,
        beforeRowIds,
        normalizedPayload,
        config
      );
  }

  if (batchSharedState) {
    batchSharedState.latestRows = latestRows;
    batchSharedState.workOrderNo = workOrderNo;
  }

  if (!confirmedTargetRow) {
    throw new HttpError(502, "新增成功但讀不到新明細列", "RAGIC_WRITE_FAILED");
  }

  const operatorIdValue = getFirstFieldValue(confirmedTargetRow.rowData, [
    operatorIdField,
    operatorIdLabelField,
  ]);
  const operatorNameValue = getFirstFieldValue(confirmedTargetRow.rowData, [
    operatorNameField,
    operatorNameLabelField,
  ]);

  deps.diagnostics.logCreateOperatorDiagnostics("after-write", {
    entryId,
    rowId: confirmedTargetRow.rowId,
    operatorId: operatorIdValue,
    operatorName: operatorNameValue,
  });

  if (isEmptyValue(operatorIdValue)) {
    deps.diagnostics.logOperatorDebugSnapshot("after-write-empty-snapshot", {
      entryId,
      ...deps.diagnostics.buildOperatorDebugSnapshot(
        config,
        confirmedTargetRow.rowId,
        confirmedTargetRow.rowData
      ),
    });
  }

  const actualRecalculateCheck = evaluatePostCreateRecalculateNeed(
    confirmedTargetRow.rowData,
    config
  );

  if (isBatchMode) {
    deps.diagnostics.logCreateOperatorDiagnostics("recalculate-skipped", {
      entryId,
      rowId: confirmedTargetRow.rowId,
      reason: "batch-mode",
      missingFields: actualRecalculateCheck.missingFields,
      formulaGaps: actualRecalculateCheck.formulaGaps,
    });
    deps.diagnostics.logCreatePerformanceIfSlow({
      entryId,
      rowId: confirmedTargetRow.rowId,
      maxRetry,
      retryDelayMs,
      didPatch: false,
      didActionButton: false,
      actionButtonStatus: "skipped-batch-row",
      recalculateCompleted: false,
      timings: createTimings,
      totalMs: Date.now() - startedAt,
    });
    deps.cache.markReportFullCacheDirty(formId);
    return { rowId: confirmedTargetRow.rowId };
  }

  deps.diagnostics.logCreateOperatorDiagnostics("recalculate-check", {
    entryId,
    rowId: confirmedTargetRow.rowId,
    ...actualRecalculateCheck,
    forceRecalculate: true,
  });
  const {
    didActionButton,
    actionButtonStatus,
    recalculateCompleted,
  } = await runCreateRecalculateFlow({
    formId,
    entryId,
    rowId: confirmedTargetRow.rowId,
    activityLogWritePath,
    workOrderNo,
    config,
    normalizedPayload,
    resolvedReportType: resolvedReportType.type,
    resolvedRequiredFields,
    recalculateCheck: {
      ...actualRecalculateCheck,
      needsRecalculate: true,
    },
    strictMode: env.CREATE_RECALC_STRICT,
    actionRetry: env.CREATE_RECALC_ACTION_RETRY,
    verifyDelayMs: env.CREATE_RECALC_VERIFY_DELAY_MS,
    totalWorkTimeFieldId: config.writeConfig.subtableWriteFields.totalWorkTime,
    measureStage,
    deps: createRecalculateFlowDeps,
  });

  deps.diagnostics.logCreatePerformanceIfSlow({
    entryId,
    rowId: confirmedTargetRow.rowId,
    maxRetry,
    retryDelayMs,
    didPatch: false,
    didActionButton,
    actionButtonStatus,
    recalculateCompleted,
    timings: createTimings,
    totalMs: Date.now() - startedAt,
  });

  deps.cache.markReportFullCacheDirty(formId);
  return { rowId: confirmedTargetRow.rowId };
}
