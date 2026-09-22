import { env } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import { RagicRecord } from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { CreateTimingMap } from "../create/types";

const log = createLogger("work-report-create-diagnostics");

export function logCreateOperatorDiagnostics(
  stage: string,
  payload: Record<string, unknown>
): void {
  if (env.NODE_ENV === "production") {
    return;
  }
  log.info({
    ...payload,
    event: "operator-check",
    stage,
  });
}

export function buildOperatorDebugSnapshot(
  config: FormConfig,
  rowId: string,
  rowData: RagicRecord | null
): Record<string, unknown> {
  const operatorIdField = config.writeConfig.subtableWriteFields.operatorId;
  const operatorNameField = config.writeConfig.subtableWriteFields.operatorName;
  const operatorIdLabelField = config.subtableFields.operatorId;
  const operatorNameLabelField = config.subtableFields.operatorName;

  const keyCandidates = new Set<string>([
    operatorIdField,
    operatorNameField,
    operatorIdLabelField,
    operatorNameLabelField,
  ]);
  const pattern = /(Operator|操作者|工號|擔當)/i;
  if (rowData) {
    for (const key of Object.keys(rowData)) {
      if (pattern.test(key)) {
        keyCandidates.add(key);
      }
    }
  }

  const candidateKeys = Array.from(keyCandidates).slice(0, env.CREATE_DEBUG_OPERATOR_KEY_LIMIT);
  const candidateEntries = candidateKeys.map((key) => ({
    key,
    value: rowData ? rowData[key] : undefined,
  }));

  return {
    rowId,
    [operatorIdField]: rowData ? rowData[operatorIdField] : undefined,
    [operatorIdLabelField]: rowData ? rowData[operatorIdLabelField] : undefined,
    [operatorNameField]: rowData ? rowData[operatorNameField] : undefined,
    [operatorNameLabelField]: rowData ? rowData[operatorNameLabelField] : undefined,
    candidateKeys: candidateEntries,
  };
}

export function logOperatorDebugSnapshot(
  stage: string,
  payload: Record<string, unknown>
): void {
  if (!env.CREATE_DEBUG_OPERATOR) {
    return;
  }
  log.info({
    ...payload,
    event: "operator-debug",
    stage,
  });
}

export function logCreatePerformanceIfSlow(payload: {
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
}): void {
  if (payload.totalMs < env.CREATE_SLOW_LOG_THRESHOLD_MS) {
    return;
  }
  log.warn({
    ...payload,
    event: "slow",
  });
}
