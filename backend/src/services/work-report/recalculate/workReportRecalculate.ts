import {
  env,
  resolveWorkReportDataPath,
  resolveWritePath,
} from "../../../config/env";
import { runWithWriteRetry } from "../../../infra/ragicWriteRetry";
import { createLogger } from "../../../observability/logger";
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
  buildActivityLogFallbackWritePayload,
} from "../shared/workReportPayloadHelpers";
import {
  getSubtableRowDataByRowId,
} from "../shared/workReportReadHelpers";
import {
  saveActivityLogRow,
  throwRagicHttpError,
  writeComputedTotalWorkTime,
} from "../shared/workReportWriteHelpers";
import {
  logCreateOperatorDiagnostics,
} from "../shared/workReportDiagnostics";

const log = createLogger("work-report-recalculate");

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
  const activityLogButtonId = env.UPSTREAM_ACTIVITY_LOG_SAVE_ACTION_BUTTON_ID.trim();
  const activityLogWritePath = resolveWritePath("903", env.UPSTREAM_ACTIVITY_LOG_PATH);
  if (activityLogButtonId && activityLogWritePath && rowId) {
    targets.push({
      source: "activityLog-row",
      formPath: activityLogWritePath,
      targetEntryId: rowId,
      buttonId: activityLogButtonId,
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
    const affectedPaths = new Set([
      resolveWorkReportDataPath("903", env.UPSTREAM_ACTIVITY_LOG_PATH),
      resolveWorkReportDataPath("901", env.RAGIC_FORM_901_PATH),
      resolveWorkReportDataPath("902", env.RAGIC_FORM_902_PATH),
    ].map((path) => path.replace(/\/$/, "")));
    // executeActionButton 已清除實際寫入表單；其餘關聯表單仍逐筆失效。
    affectedPaths.delete(target.formPath.replace(/\/$/, ""));
    for (const path of affectedPaths) {
      ragicClient.clearFormCache(path);
    }
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
    buildActivityLogFallbackWritePayload,
    simulateActivityLogRowSave: saveActivityLogRow,
    shouldUseComputedTotalWorkTimeFallback,
    getSubtableRowDataByRowId,
    computeTotalWorkTimeHours,
    writeComputedTotalWorkTime,
    log: logCreateOperatorDiagnostics,
    warn: (tag, payload) => {
      log.warn({
        ...payload,
        event: "warning",
        tag,
      });
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

export async function triggerActivityLogRowRecalculateFlow(
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
