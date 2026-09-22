import { useCallback } from "react";
import { pushFrontendEvent } from "../../logging/frontendEventLog";
import type {
  WorkReportFrontendEventAction,
  WorkReportFrontendEventCategory,
} from "../../debug/workReportDeveloperContract";
import type { FrontendEventLogMetaValue } from "../../logging/frontendEventLog";

type ListEventMeta = Record<string, FrontendEventLogMetaValue>;

interface ListEventOptions {
  level?: "info" | "warn" | "error";
  entryId?: string;
  rowId?: string;
  taskId?: string;
  clientMutationId?: string;
  operationId?: string;
  operationType?: string;
  phase?: string;
  durationMs?: number;
  startedAt?: string;
  endedAt?: string;
  meta?: ListEventMeta;
}

export function useWorkReportListEventLogger(currentFormId: string) {
  function isListEventOptions(value: ListEventOptions | ListEventMeta): value is ListEventOptions {
    return (
      "level" in value ||
      "entryId" in value ||
      "rowId" in value ||
      "taskId" in value ||
      "clientMutationId" in value ||
      "operationId" in value ||
      "operationType" in value ||
      "phase" in value ||
      "durationMs" in value ||
      "startedAt" in value ||
      "endedAt" in value ||
      "meta" in value
    );
  }

  const logListEvent = useCallback(
    (
      category: WorkReportFrontendEventCategory,
      action: WorkReportFrontendEventAction,
      summary: string,
      optionsOrMeta: ListEventOptions | ListEventMeta = {},
      level: "info" | "warn" | "error" = "info"
    ) => {
      const options = isListEventOptions(optionsOrMeta)
        ? optionsOrMeta
        : { meta: optionsOrMeta };
      pushFrontendEvent({
        level: options.level ?? level,
        category,
        action,
        summary,
        operationId: options.operationId,
        operationType: options.operationType,
        phase: options.phase,
        durationMs: options.durationMs,
        startedAt: options.startedAt,
        endedAt: options.endedAt,
        formId: currentFormId,
        entryId: options.entryId,
        rowId: options.rowId,
        taskId: options.taskId,
        clientMutationId: options.clientMutationId,
        meta: options.meta,
      });
    },
    [currentFormId]
  );

  return { logListEvent };
}
