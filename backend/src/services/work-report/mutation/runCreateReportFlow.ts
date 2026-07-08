import { env } from "../../../config/env";
import { getFormConfig } from "../../../config/forms";
import {
  ragicClient,
  type RagicRecord,
} from "../../../ragic/client";
import type { FormConfig } from "../../../types/formConfig";
import type { ReportWritePayload } from "../../../types/workReport";
import { HttpError } from "../../../utils/httpError";
import { assertForm16EntryStored } from "../../form16/form16WriteVerifier";
import { form16WriteReverifyService } from "../../form16/form16WriteReverifyService";
import {
  resolveForm16ReportType as resolveForm16ReportTypeRule,
} from "../create/form16ReportTypeRules";
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
  /**
   * 客戶端送出時產的 UUID（通常跟 `x-client-mutation-id` header 來的 value 一致）。
   * workReportService.createReport 會拿這個去 SQLite 查既有的 Form 16 寫入映射，
   * 命中就跳過 runCreateReportFlow 直接回舊 rowId，擋 backend restart 後 retry
   * 造成的重複 Ragic 寫入。
   */
  clientMutationId?: string;
}

function extractCreatedForm16RowId(value: unknown): string | null {
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

interface CreateReportFlowDeps {
  assertEntryNotModified: (
    formId: string,
    entryId: string,
    expectedEntryLastUpdatedAt?: string
  ) => Promise<void>;
  validateReportPayload: (
    payload: ReportWritePayload,
    requiredFields: string[]
  ) => void;
  normalizePayloadForWrite: (
    formId: string,
    config: FormConfig,
    payload: ReportWritePayload
  ) => Promise<ReportWritePayload>;
  getRawEntry: (
    config: FormConfig,
    entryId: string,
    useCache?: boolean
  ) => Promise<RagicRecord>;
  getFormOptions: (
    formId: string,
    fields?: string[]
  ) => Promise<FormOptionMap>;
  buildSubtableRowData: (
    payload: ReportWritePayload,
    config: FormConfig
  ) => RagicRecord;
  resolveForm16RequiredFields: (
    form16Path: string,
    workOrderNo: string,
    processCode: string,
    reportType: string
  ) => Promise<{ depUnit: string; prodType: string; source: string }>;
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
  findLikelyCreatedRow: (
    latestRows: SubtableRow[],
    beforeRowIds: ReadonlySet<string>,
    normalizedPayload: ReportWritePayload,
    config: FormConfig
  ) => SubtableRow | null;
  buildCreateRecalculateFlowDeps: () => CreateRecalculateFlowDeps;
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
  markReportFullCacheDirty: (formId: string) => void;
  throwRagicHttpError: (
    error: unknown,
    options: {
      code: "RAGIC_WRITE_FAILED" | "RAGIC_ACTION_BUTTON_FAILED";
      messagePrefix: string;
    }
  ) => never;
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
      deps.assertEntryNotModified(formId, entryId, options.expectedEntryLastUpdatedAt)
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
  let beforeRowsFromBatch = batchSharedState?.latestRows;
  let workOrderNoFromBatch = batchSharedState?.workOrderNo;
  let payloadForWrite = payload;
  if (isEmptyValue(payloadForWrite.processCode)) {
    let processCodeDefault =
      batchSharedState && Object.prototype.hasOwnProperty.call(batchSharedState, "processCodeDefault")
        ? batchSharedState.processCodeDefault
        : undefined;
    if (processCodeDefault === undefined) {
      beforeEntry = await measureStage("beforeRead", () =>
        deps.getRawEntry(config, entryId, false)
      );
      const options = await deps.getFormOptions(formId, ["machineId"]);
      processCodeDefault = resolveCreatePayloadProcessCodeDefault(
        config,
        beforeEntry,
        options.machineId ?? []
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

  deps.validateReportPayload(payloadForWrite, config.writeConfig.requiredFields);

  const normalizedPayload = await measureStage("normalize", () =>
    deps.normalizePayloadForWrite(formId, config, payloadForWrite)
  );

  if (!beforeRowsFromBatch || !workOrderNoFromBatch) {
    beforeEntry =
      beforeEntry ??
      (await measureStage("beforeRead", () =>
        deps.getRawEntry(config, entryId, false)
      ));
  }

  const subtableRowData = deps.buildSubtableRowData(normalizedPayload, config);
  subtableRowData[operatorIdField] = normalizedPayload.operatorId;
  subtableRowData[operatorNameField] = normalizedPayload.operatorName;
  if (Object.keys(subtableRowData).length === 0) {
    throw new HttpError(400, "沒有可寫入的欄位", "INVALID_PAYLOAD");
  }

  const {
    beforeRows,
    beforeRowIds,
    workOrderNo,
    form16WritePath,
    processCodeForType,
    resolvedReportType,
    resolvedRequiredFields,
    form16CreateBody,
  } = await measureStage("contextRead", () =>
    prepareCreateReportContext({
      config,
      entryId,
      beforeEntry,
      beforeRows: beforeRowsFromBatch,
      workOrderNo: workOrderNoFromBatch,
      normalizedPayload,
      subtableRowData,
      resolveForm16ReportType: async (
        workOrderNoValue,
        processCode,
        requestedReportType
      ) => resolveForm16ReportTypeRule(workOrderNoValue, processCode, requestedReportType),
      resolveForm16RequiredFields: (form16Path, workOrderNoValue, processCode, reportType) =>
        deps.resolveForm16RequiredFields(form16Path, workOrderNoValue, processCode, reportType),
    })
  );

  deps.logCreateOperatorDiagnostics("before-write", {
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
    writePath: form16WritePath,
  });

  let createdForm16RowId: string | null = null;
  await measureStage("write", async () => {
    try {
      const createResult = await ragicClient.createEntry(form16WritePath, form16CreateBody, true);
      createdForm16RowId = extractCreatedForm16RowId(createResult);
    } catch (error) {
      deps.throwRagicHttpError(error, {
        code: "RAGIC_WRITE_FAILED",
        messagePrefix: `建立 Ragic 紀錄失敗（path=${form16WritePath}）`,
      });
    }
  });

  // Post-write verify：Ragic 偶爾會回成功但 workOrderNo 沒真的存進去（觀察到的 orphan 來源）
  // 單筆互動立刻讀回來比對；對不起來會自己 DELETE + throw。
  // 批次模式則先排背景 reverify，避免每列都同步等 live Ragic GET；若排不進佇列才退回同步 verify。
  // 只驗 workOrderNo 跟 type；depUnit/prodType 是 Ragic 推算欄位、會被 workflow 轉換，
  // 不適合嚴格比對（會誤殺合法 entry）
  if (createdForm16RowId) {
    const form16RowId = createdForm16RowId;
    const expectedForm16Entry = {
      workOrderNo,
      type: resolvedReportType.type,
    };
    const enqueueReverify = async (errorMessage: string) =>
      form16WriteReverifyService.enqueue({
        form16Path: form16WritePath,
        entryId: form16RowId,
        expected: expectedForm16Entry,
        readPriority: isBatchMode ? "background" : "user",
        timeoutMs: isBatchMode
          ? env.FORM16_WRITE_REVERIFY_TIMEOUT_MS
          : env.FORM16_WRITE_VERIFY_TIMEOUT_MS,
        maxRetries: isBatchMode
          ? env.FORM16_WRITE_REVERIFY_MAX_RETRIES
          : env.FORM16_WRITE_VERIFY_MAX_RETRIES,
        errorMessage,
        occurredAt: new Date().toISOString(),
        source: isBatchMode ? "work-report-batch-create" : "work-report-create",
        workReportFormId: formId,
        workReportEntryId: entryId,
        workOrderNo,
      });

    await measureStage("verifyWrite", async () => {
      if (isBatchMode) {
        const queued = await enqueueReverify("batch-create-deferred-verify").catch((error) => {
          deps.logCreateOperatorDiagnostics("verify-enqueue-failed", {
            entryId,
            rowId: form16RowId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        if (queued) {
          deps.logCreateOperatorDiagnostics("verify-deferred", {
            entryId,
            rowId: form16RowId,
            source: queued.source,
          });
          return;
        }
      }

      await assertForm16EntryStored(
        form16WritePath,
        form16RowId,
        expectedForm16Entry,
        {
          readPriority: "user",
          timeoutMs: env.FORM16_WRITE_VERIFY_TIMEOUT_MS,
          maxRetries: env.FORM16_WRITE_VERIFY_MAX_RETRIES,
          continueOnReadError: true,
          onReadIndeterminate: async (payload) => {
            await form16WriteReverifyService.enqueue({
              ...payload,
              source: isBatchMode ? "work-report-batch-create" : "work-report-create",
              workReportFormId: formId,
              workReportEntryId: entryId,
              workOrderNo,
            });
          },
        }
      );
    });
  }

  const maxRetry = env.CREATE_POLL_MAX_RETRY;
  const retryDelayMs = env.CREATE_POLL_DELAY_MS;
  const createRecalculateFlowDeps = deps.buildCreateRecalculateFlowDeps();
  let latestRows: SubtableRow[] = beforeRows;
  let confirmedTargetRow: SubtableRow | null = null;
  if (isBatchMode && createdForm16RowId) {
    confirmedTargetRow = {
      rowId: createdForm16RowId,
      rowData: {},
    };
    latestRows = [
      confirmedTargetRow,
      ...beforeRows.filter((row) => row.rowId !== createdForm16RowId),
    ];
  } else {
    const { targetRow, latestRows: nextLatestRows, elapsedMs: pollingElapsedMs } = await pollCreatedSubtableRow({
      beforeRowIds,
      beforeRowsCount: beforeRows.length,
      maxRetry,
      retryDelayMs,
      fetchLatestRows: async () => {
        const latestEntry = await deps.getRawEntry(config, entryId, false);
        return collectSubtableRows(latestEntry[config.writeConfig.subtableId]);
      },
      sleep: createRecalculateFlowDeps.sleep,
    });
    createTimings.polling += pollingElapsedMs;
    latestRows = nextLatestRows;
    confirmedTargetRow =
      targetRow ??
      deps.findLikelyCreatedRow(latestRows, beforeRowIds, normalizedPayload, config);
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

  deps.logCreateOperatorDiagnostics("after-write", {
    entryId,
    rowId: confirmedTargetRow.rowId,
    operatorId: operatorIdValue,
    operatorName: operatorNameValue,
  });

  if (isEmptyValue(operatorIdValue)) {
    deps.logOperatorDebugSnapshot("after-write-empty-snapshot", {
      entryId,
      ...deps.buildOperatorDebugSnapshot(
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
    deps.logCreateOperatorDiagnostics("recalculate-skipped", {
      entryId,
      rowId: confirmedTargetRow.rowId,
      reason: "batch-mode",
      missingFields: actualRecalculateCheck.missingFields,
      formulaGaps: actualRecalculateCheck.formulaGaps,
    });
    deps.logCreatePerformanceIfSlow({
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
    deps.markReportFullCacheDirty(formId);
    return { rowId: confirmedTargetRow.rowId };
  }

  deps.logCreateOperatorDiagnostics("recalculate-check", {
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
    form16WritePath,
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

  deps.logCreatePerformanceIfSlow({
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

  deps.markReportFullCacheDirty(formId);
  return { rowId: confirmedTargetRow.rowId };
}
