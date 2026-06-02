import { RagicActionButtonExecutionResult, RagicRecord } from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { ReportWritePayload } from "../../../types/workReport";
import { HttpError } from "../../../utils/httpError";
import { RecalculateNeedCheck } from "./recalculateInspection";
import {
  CreateRecalculateActionTarget,
  CreateRecalculateVerifyResult,
  CreateTimingStage,
} from "./types";

type MeasureCreateStage = <T>(
  stage: CreateTimingStage,
  task: () => Promise<T>
) => Promise<T>;

interface RecalculateFlowResolvedRequiredFields {
  depUnit: string;
  prodType: string;
}

export interface CreateRecalculateFlowDeps {
  sleep: (ms: number) => Promise<void>;
  resolveActionTargets: (
    formId: string,
    config: FormConfig,
    entryId: string,
    rowId: string
  ) => CreateRecalculateActionTarget[];
  executeSaveActionButton: (
    target: CreateRecalculateActionTarget,
    entryId: string,
    rowId: string
  ) => Promise<RagicActionButtonExecutionResult>;
  verifyRecalculateCompletion: (
    config: FormConfig,
    entryId: string,
    rowId: string,
    phase: string
  ) => Promise<CreateRecalculateVerifyResult>;
  buildForm16FallbackWritePayload: (
    normalizedPayload: ReportWritePayload,
    workOrderNo: string,
    reportType: string,
    depUnit: string,
    prodType: string,
    config: FormConfig
  ) => RagicRecord;
  simulateForm16RowSave: (
    form16Path: string,
    rowId: string,
    body: RagicRecord
  ) => Promise<void>;
  shouldUseComputedTotalWorkTimeFallback: (
    lastCheck: CreateRecalculateVerifyResult["lastCheck"]
  ) => boolean;
  getSubtableRowDataByRowId: (
    config: FormConfig,
    entryId: string,
    rowId: string
  ) => Promise<RagicRecord | null>;
  computeTotalWorkTimeHours: (rowData: RagicRecord, config: FormConfig) => number | null;
  writeComputedTotalWorkTime: (
    form16Path: string,
    rowId: string,
    totalWorkTimeFieldId: string,
    totalWorkTime: number
  ) => Promise<void>;
  log: (stage: string, payload: Record<string, unknown>) => void;
  warn: (tag: string, payload: Record<string, unknown>) => void;
}

export interface RunCreateRecalculateFlowParams {
  formId: string;
  entryId: string;
  rowId: string;
  form16WritePath: string;
  workOrderNo: string;
  config: FormConfig;
  normalizedPayload: ReportWritePayload;
  resolvedReportType: string;
  resolvedRequiredFields: RecalculateFlowResolvedRequiredFields;
  recalculateCheck: RecalculateNeedCheck;
  strictMode: boolean;
  actionRetry: number;
  verifyDelayMs: number;
  totalWorkTimeFieldId: string;
  measureStage: MeasureCreateStage;
  deps: CreateRecalculateFlowDeps;
}

export interface RunCreateRecalculateFlowResult {
  didActionButton: boolean;
  actionButtonStatus: string;
  recalculateCompleted: boolean;
}

export async function runCreateRecalculateFlow(
  params: RunCreateRecalculateFlowParams
): Promise<RunCreateRecalculateFlowResult> {
  const {
    formId,
    entryId,
    rowId,
    form16WritePath,
    workOrderNo,
    config,
    normalizedPayload,
    resolvedReportType,
    resolvedRequiredFields,
    recalculateCheck,
    strictMode,
    actionRetry,
    verifyDelayMs,
    totalWorkTimeFieldId,
    measureStage,
    deps,
  } = params;
  const {
    sleep,
    resolveActionTargets,
    executeSaveActionButton,
    verifyRecalculateCompletion,
    buildForm16FallbackWritePayload,
    simulateForm16RowSave,
    shouldUseComputedTotalWorkTimeFallback,
    getSubtableRowDataByRowId,
    computeTotalWorkTimeHours,
    writeComputedTotalWorkTime,
    log,
    warn,
  } = deps;

  let didActionButton = false;
  let actionButtonStatus = "skipped";
  let recalculateCompleted = !recalculateCheck.needsRecalculate;
  const actionTargets = resolveActionTargets(formId, config, entryId, rowId);

  if (!recalculateCheck.needsRecalculate) {
    log("after-recalculate-skipped", {
      entryId,
      rowId,
      reason: "no-missing-required-fields",
      missingFields: recalculateCheck.missingFields,
    });
    return { didActionButton, actionButtonStatus, recalculateCompleted };
  }

  if (actionTargets.length === 0) {
    const detail = {
      entryId,
      rowId,
      reason: "action-button-not-configured",
      missingFields: recalculateCheck.missingFields,
      formulaGaps: recalculateCheck.formulaGaps,
    };
    log("after-recalculate-incomplete", detail);
    if (strictMode) {
      throw new HttpError(
        502,
        "重算按鈕未設定，無法完成新增後公式同步",
        "RAGIC_RECALC_INCOMPLETE"
      );
    }
    return { didActionButton, actionButtonStatus, recalculateCompleted };
  }

  const maxActionAttempts = actionRetry + 1;
  const actionStatusTrail: string[] = [];
  for (const actionTarget of actionTargets) {
    for (let actionAttempt = 1; actionAttempt <= maxActionAttempts; actionAttempt += 1) {
      let actionResult: RagicActionButtonExecutionResult | null = null;
      try {
        actionResult = await measureStage("actionButton", () =>
          executeSaveActionButton(actionTarget, entryId, rowId)
        );
        didActionButton = true;
        const resolvedStatus = actionResult.status || "SUCCESS";
        actionStatusTrail.push(`${actionTarget.source}:${resolvedStatus}`);
        actionButtonStatus = actionStatusTrail.join("|");
        log("action-button-result", {
          entryId,
          rowId,
          attempt: actionAttempt,
          source: actionTarget.source,
          actionFormPath: actionTarget.formPath,
          actionEntryId: actionTarget.targetEntryId,
          buttonId: actionTarget.buttonId,
          status: resolvedStatus,
          code: actionResult.code,
          message: actionResult.msg,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        actionStatusTrail.push(`${actionTarget.source}:FAILED`);
        actionButtonStatus = actionStatusTrail.join("|");
        warn("[createReport][action-button-failed]", {
          entryId,
          rowId,
          attempt: actionAttempt,
          source: actionTarget.source,
          actionFormPath: actionTarget.formPath,
          actionEntryId: actionTarget.targetEntryId,
          buttonId: actionTarget.buttonId,
          error: message,
        });
        if (actionAttempt < maxActionAttempts) {
          await sleep(verifyDelayMs);
        }
        continue;
      }

      const verifyResult = await measureStage("recalculateVerify", () =>
        verifyRecalculateCompletion(config, entryId, rowId, `${actionTarget.source}-${actionAttempt}`)
      );
      recalculateCompleted = verifyResult.completed;
      if (recalculateCompleted) {
        log("after-recalculate-complete", {
          entryId,
          rowId,
          source: actionTarget.source,
          attempt: actionAttempt,
          actionStatus: actionResult?.status || "SUCCESS",
        });
        break;
      }

      if (actionAttempt < maxActionAttempts) {
        await sleep(verifyDelayMs);
      }
    }

    if (recalculateCompleted) {
      break;
    }
  }

  if (!recalculateCompleted) {
    const fallbackPayload = buildForm16FallbackWritePayload(
      normalizedPayload,
      workOrderNo,
      resolvedReportType,
      resolvedRequiredFields.depUnit,
      resolvedRequiredFields.prodType,
      config
    );
    log("recalculate-fallback-start", {
      entryId,
      rowId,
      fallbackFieldCount: Object.keys(fallbackPayload).length,
    });

    try {
      await measureStage("fallback", () =>
        simulateForm16RowSave(form16WritePath, rowId, fallbackPayload)
      );
      log("recalculate-fallback-success", { entryId, rowId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn("[createReport][recalculate-fallback-failed]", {
        entryId,
        rowId,
        error: message,
      });
    }

    const fallbackVerifyResult = await measureStage("recalculateVerify", () =>
      verifyRecalculateCompletion(config, entryId, rowId, "fallback")
    );
    let finalVerifyResult = fallbackVerifyResult;
    recalculateCompleted = finalVerifyResult.completed;

    if (
      !recalculateCompleted &&
      shouldUseComputedTotalWorkTimeFallback(finalVerifyResult.lastCheck)
    ) {
      const latestRowData = await getSubtableRowDataByRowId(config, entryId, rowId);
      const computedTotalWorkTime = latestRowData
        ? computeTotalWorkTimeHours(latestRowData, config)
        : null;
      if (computedTotalWorkTime !== null) {
        log("recalculate-fallback-computed-start", {
          entryId,
          rowId,
          totalWorkTime: computedTotalWorkTime,
        });
        try {
          await measureStage("fallback", () =>
            writeComputedTotalWorkTime(form16WritePath, rowId, totalWorkTimeFieldId, computedTotalWorkTime)
          );
          log("recalculate-fallback-computed-success", {
            entryId,
            rowId,
            totalWorkTime: computedTotalWorkTime,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warn("[createReport][recalculate-fallback-computed-failed]", {
            entryId,
            rowId,
            error: message,
          });
        }

        finalVerifyResult = await measureStage("recalculateVerify", () =>
          verifyRecalculateCompletion(config, entryId, rowId, "fallback-computed")
        );
        recalculateCompleted = finalVerifyResult.completed;
        if (recalculateCompleted) {
          actionButtonStatus = `${actionButtonStatus}|FALLBACK_COMPUTED`;
        }
      } else {
        log("recalculate-fallback-computed-skipped", {
          entryId,
          rowId,
          reason: "cannot-calculate-total-work-time",
        });
      }
    }

    if (recalculateCompleted) {
      if (!actionButtonStatus.includes("FALLBACK")) {
        actionButtonStatus = `${actionButtonStatus}|FALLBACK`;
      }
      log("after-recalculate-complete", {
        entryId,
        rowId,
        source: "fallback",
        actionStatus: actionButtonStatus,
      });
    } else {
      const incompleteDetail = {
        entryId,
        rowId,
        actionStatus: actionButtonStatus,
        missingFields: finalVerifyResult.lastCheck.missingFields,
        formulaGaps: finalVerifyResult.lastCheck.formulaGaps,
      };
      log("after-recalculate-incomplete", incompleteDetail);
      if (strictMode) {
        throw new HttpError(
          502,
          `新增後重算仍未完成：rowId=${rowId}，缺漏欄位=${finalVerifyResult.lastCheck.missingFields.join(",") || "-"}，公式缺口=${finalVerifyResult.lastCheck.formulaGaps.join(",") || "-"}`,
          "RAGIC_RECALC_INCOMPLETE"
        );
      }
    }
  }

  return {
    didActionButton,
    actionButtonStatus,
    recalculateCompleted,
  };
}
