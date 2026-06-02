import { env, resolveWritePath } from "../../../config/env";
import { runWithWriteRetry } from "../../../infra/ragicWriteRetry";
import {
  ragicClient,
  RagicActionButtonExecutionResult,
} from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import {
  computeTotalWorkTimeHours,
  evaluatePostCreateRecalculateNeed,
  shouldUseComputedTotalWorkTimeFallback,
} from "../create/recalculateInspection";
import { CreateRecalculateFlowDeps } from "../create/recalculateOrchestration";
import {
  CreateRecalculateActionTarget,
  CreateRecalculateVerifyResult,
} from "../create/types";
import {
  buildForm16FallbackWritePayload,
} from "../shared/workReportPayloadHelpers";
import {
  getSubtableRowDataByRowId,
} from "../shared/workReportReadHelpers";
import {
  saveForm16Row,
  throwRagicHttpError,
  writeComputedTotalWorkTime,
} from "../shared/workReportWriteHelpers";
import {
  logCreateOperatorDiagnostics,
} from "../shared/workReportDiagnostics";

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveCreateRecalculateActionTargets(
  rowId: string
): CreateRecalculateActionTarget[] {
  const targets: CreateRecalculateActionTarget[] = [];
  const form16ButtonId = env.RAGIC_FORM_16_SAVE_ACTION_BUTTON_ID.trim();
  const form16WritePath = resolveWritePath("16", env.RAGIC_FORM_16_PATH);
  if (form16ButtonId && form16WritePath && rowId) {
    targets.push({
      source: "form16-row",
      formPath: form16WritePath,
      targetEntryId: rowId,
      buttonId: form16ButtonId,
    });
  }
  return targets;
}

export async function executeSaveActionButton(
  target: CreateRecalculateActionTarget,
  entryId: string,
  rowId: string
): Promise<RagicActionButtonExecutionResult> {
  try {
    const result = await runWithWriteRetry(
      () =>
        ragicClient.executeActionButton(
          target.formPath,
          target.targetEntryId,
          target.buttonId
        ),
      {
        label: `recalculateAction:${target.source}:${target.formPath}:${target.buttonId}`,
      }
    );
    ragicClient.clearFormCache(target.formPath);
    ragicClient.clearFormCache(env.RAGIC_FORM_16_PATH);
    ragicClient.clearFormCache(env.RAGIC_FORM_104_PATH);
    ragicClient.clearFormCache(env.RAGIC_FORM_105_PATH);
    return result;
  } catch (error) {
    throwRagicHttpError(error, {
      code: "RAGIC_ACTION_BUTTON_FAILED",
      messagePrefix: `觸發儲存模擬按鈕失敗 entryId=${entryId} rowId=${rowId} actionSource=${target.source} actionEntryId=${target.targetEntryId} buttonId=${target.buttonId}`,
    });
  }
}

export async function verifyRecalculateCompletion(
  config: FormConfig,
  entryId: string,
  rowId: string,
  phase: string
): Promise<CreateRecalculateVerifyResult> {
  const rowNotFoundCheck = () => ({
    needsRecalculate: true,
    missingFields: ["row-not-found"],
    checkedFields: ["rowId"],
    formulaGaps: ["row-not-found"],
  });
  let lastCheck = rowNotFoundCheck();

  for (let attempt = 1; attempt <= env.CREATE_RECALC_VERIFY_RETRY; attempt += 1) {
    const latestRowData = await getSubtableRowDataByRowId(config, entryId, rowId);
    lastCheck = latestRowData
      ? evaluatePostCreateRecalculateNeed(latestRowData, config)
      : rowNotFoundCheck();

    logCreateOperatorDiagnostics("recalculate-verify", {
      entryId,
      rowId,
      phase,
      attempt,
      ...lastCheck,
    });

    if (!lastCheck.needsRecalculate) {
      return {
        completed: true,
        attempts: attempt,
        lastCheck,
      };
    }

    if (attempt < env.CREATE_RECALC_VERIFY_RETRY) {
      await sleep(env.CREATE_RECALC_VERIFY_DELAY_MS);
    }
  }

  return {
    completed: false,
    attempts: env.CREATE_RECALC_VERIFY_RETRY,
    lastCheck,
  };
}

export function buildCreateRecalculateFlowDeps(): CreateRecalculateFlowDeps {
  return {
    sleep,
    resolveActionTargets: (_formId, _config, _entryId, rowId) =>
      resolveCreateRecalculateActionTargets(rowId),
    executeSaveActionButton,
    verifyRecalculateCompletion,
    buildForm16FallbackWritePayload,
    simulateForm16RowSave: saveForm16Row,
    shouldUseComputedTotalWorkTimeFallback,
    getSubtableRowDataByRowId,
    computeTotalWorkTimeHours,
    writeComputedTotalWorkTime,
    log: logCreateOperatorDiagnostics,
    warn: (tag, payload) => {
      console.warn(tag, payload);
    },
  };
}

export async function triggerUpdateRecalculateFlow(
  entryId: string,
  rowId: string
): Promise<void> {
  const targets = resolveCreateRecalculateActionTargets(rowId);
  if (targets.length === 0) {
    return;
  }

  for (const target of targets) {
    const result = await executeSaveActionButton(target, entryId, rowId);
    logCreateOperatorDiagnostics("update-recalculate-action-button-result", {
      entryId,
      rowId,
      source: target.source,
      actionFormPath: target.formPath,
      actionEntryId: target.targetEntryId,
      buttonId: target.buttonId,
      status: result.status,
      code: result.code,
      message: result.msg,
    });
  }
}

export async function triggerForm16RowRecalculateFlow(
  entryId: string,
  rowIds: string[]
): Promise<void> {
  for (const rowId of rowIds) {
    const targets = resolveCreateRecalculateActionTargets(rowId);

    for (const target of targets) {
      const result = await executeSaveActionButton(target, entryId, rowId);
      logCreateOperatorDiagnostics("batch-create-row-recalculate-action-button-result", {
        entryId,
        rowId,
        source: target.source,
        actionFormPath: target.formPath,
        actionEntryId: target.targetEntryId,
        buttonId: target.buttonId,
        status: result.status,
        code: result.code,
        message: result.msg,
      });
    }
  }
}
