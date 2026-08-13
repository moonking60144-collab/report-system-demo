import type {
  ReportMutationPayload,
  WorkReportItem,
  WorkReportRecord,
} from "../../api/workReport";
import {
  applyOptimisticMutation,
  createAcceptedMutationLifecycle,
  isStoredMutationLifecycle,
  reconcileOptimisticMutation,
  type MutationFailurePolicy,
  type MutationOperationKind,
  type MutationReconcilePolicy,
  type OptimisticMutationLifecycle,
  type OptimisticMutationTarget,
} from "./mutationLifecycle";
import { WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED } from "./optimisticMutationFeatureFlags";

export type WorkReportOptimisticPatch =
  | {
      kind: "create-rows";
      rows: Array<{ clientRowKey: string; payload: ReportMutationPayload }>;
    }
  | {
      kind: "update-row";
      rowId: string;
      payload: ReportMutationPayload;
    }
  | {
      kind: "delete-rows";
      rowIds: string[];
    }
  | {
      kind: "update-entry";
      patch: Partial<WorkReportRecord>;
    };

export interface WorkReportOptimisticMutation {
  lifecycle: OptimisticMutationLifecycle;
  patch: WorkReportOptimisticPatch;
}

export interface WorkReportOptimisticMutationInput {
  mutationId: string;
  operation: MutationOperationKind;
  target: OptimisticMutationTarget;
  patch: WorkReportOptimisticPatch;
  previousSnapshot: unknown;
  reconcilePolicy: MutationReconcilePolicy;
  failurePolicy: MutationFailurePolicy;
}

export interface WorkReportOptimisticTaskObservation {
  taskId: string;
  lifecycleState?: OptimisticMutationLifecycle["lifecycleState"];
  confirmedAt?: string | null;
  rowId?: string;
  batchCreatedRowIds?: string[];
  optimisticMutation?: WorkReportOptimisticMutation;
}

function hasVisibleOptimisticState(mutation: WorkReportOptimisticMutation): boolean {
  return (
    mutation.lifecycle.optimisticState === "applied" ||
    mutation.lifecycle.optimisticState === "confirmed" ||
    mutation.lifecycle.optimisticState === "frozen"
  );
}

function assignDefinedValues<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): T {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      target[key as keyof T] = value as T[keyof T];
    }
  }
  return target;
}

function buildOptimisticReportItem(
  rowId: string,
  payload: ReportMutationPayload,
  mutation: WorkReportOptimisticMutation
): WorkReportItem {
  const item: WorkReportItem = {
    rowId,
    date: payload.date,
    reportType: payload.reportType ?? null,
    plannedIdle: payload.plannedIdle ?? null,
    processCode: payload.processCode ?? null,
    processCodeDisplay: payload.processCode ?? null,
    machineId: payload.machineId,
    machineIdDisplay: payload.machineId,
    operatorId: payload.operatorId,
    operatorIdDisplay: payload.operatorName ?? payload.operatorId,
    operatorName: payload.operatorName ?? null,
    inputOptions: payload.inputOptions ?? null,
    shiftType: payload.shiftType ?? null,
    startTime: payload.startTime,
    endTime: payload.endTime,
    breakTime: payload.breakTime ?? null,
    totalWorkTime: null,
    productionQty: payload.productionQty ?? null,
    cumulativeQty: null,
    __optimisticMutationId: mutation.lifecycle.mutationId,
    __optimisticState: mutation.lifecycle.optimisticState,
  };
  return assignDefinedValues(item, payload as unknown as Record<string, unknown>);
}

function patchOptimisticReportItem(
  item: WorkReportItem,
  payload: ReportMutationPayload,
  mutation: WorkReportOptimisticMutation
): WorkReportItem {
  const next = assignDefinedValues(
    { ...item },
    payload as unknown as Record<string, unknown>
  );
  if (payload.processCode !== undefined) {
    next.processCodeDisplay = payload.processCode;
  }
  if (payload.machineId !== undefined) {
    next.machineIdDisplay = payload.machineId;
  }
  if (payload.operatorId !== undefined) {
    next.operatorIdDisplay = payload.operatorName ?? payload.operatorId;
  }
  next.__optimisticMutationId = mutation.lifecycle.mutationId;
  next.__optimisticState = mutation.lifecycle.optimisticState;
  return next;
}

function resolveOptimisticCreateRowId(
  row: { clientRowKey: string },
  rowIndex: number,
  observation: WorkReportOptimisticTaskObservation,
  mutation: WorkReportOptimisticMutation
): string {
  if (mutation.lifecycle.lifecycleState === "success") {
    if (observation.batchCreatedRowIds?.[rowIndex]) {
      return observation.batchCreatedRowIds[rowIndex];
    }
    if (rowIndex === 0 && observation.rowId) {
      return observation.rowId;
    }
  }
  return `__optimistic__:${row.clientRowKey}`;
}

function applyOneOptimisticMutation(
  record: WorkReportRecord,
  observation: WorkReportOptimisticTaskObservation
): WorkReportRecord {
  const mutation = observation.optimisticMutation;
  if (!mutation || !hasVisibleOptimisticState(mutation)) {
    return record;
  }

  if (mutation.patch.kind === "update-entry") {
    return {
      ...record,
      ...mutation.patch.patch,
      __optimisticMutationId: mutation.lifecycle.mutationId,
      __optimisticState: mutation.lifecycle.optimisticState,
    };
  }

  const reports = record.reports ?? [];
  if (mutation.patch.kind === "delete-rows") {
    const deletedRowIds = new Set(mutation.patch.rowIds);
    return {
      ...record,
      reports: reports.filter((item) => !deletedRowIds.has(String(item.rowId))),
    };
  }

  if (mutation.patch.kind === "update-row") {
    const patch = mutation.patch;
    return {
      ...record,
      reports: reports.map((item) =>
        String(item.rowId) === patch.rowId
          ? patchOptimisticReportItem(item, patch.payload, mutation)
          : item
      ),
    };
  }

  const existingRowIds = new Set(reports.map((item) => String(item.rowId)));
  const optimisticRows = mutation.patch.rows
    .map((row, index) => ({
      rowId: resolveOptimisticCreateRowId(row, index, observation, mutation),
      payload: row.payload,
    }))
    .filter((row) => !existingRowIds.has(row.rowId))
    .map((row) => buildOptimisticReportItem(row.rowId, row.payload, mutation));
  if (optimisticRows.length === 0) {
    return record;
  }
  return {
    ...record,
    reports: [...reports, ...optimisticRows],
  };
}

export function createWorkReportOptimisticMutation(
  input: WorkReportOptimisticMutationInput & {
    taskId: string;
    acceptedAt: string;
  }
): WorkReportOptimisticMutation {
  return {
    lifecycle: applyOptimisticMutation(
      createAcceptedMutationLifecycle({
        mutationId: input.mutationId,
        taskId: input.taskId,
        operation: input.operation,
        target: input.target,
        acceptedAt: input.acceptedAt,
        reconcilePolicy: input.reconcilePolicy,
        failurePolicy: input.failurePolicy,
        previousSnapshot: input.previousSnapshot,
      })
    ),
    patch: input.patch,
  };
}

export function reconcileWorkReportOptimisticMutation(
  mutation: WorkReportOptimisticMutation,
  observation: {
    lifecycleState: OptimisticMutationLifecycle["lifecycleState"];
    confirmedAt?: string | null;
  }
): WorkReportOptimisticMutation {
  return {
    ...mutation,
    lifecycle: reconcileOptimisticMutation(mutation.lifecycle, observation),
  };
}

export function applyWorkReportOptimisticMutations(
  record: WorkReportRecord | null,
  observations: WorkReportOptimisticTaskObservation[]
): WorkReportRecord | null {
  if (!record) {
    return null;
  }
  if (!WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED) {
    return record;
  }
  return observations
    .filter(
      (observation) =>
        observation.optimisticMutation?.lifecycle.target.domain === "work-report" &&
        observation.optimisticMutation.lifecycle.target.entryId === String(record.id)
    )
    .sort((left, right) => {
      const leftAt = Date.parse(left.optimisticMutation?.lifecycle.acceptedAt ?? "");
      const rightAt = Date.parse(right.optimisticMutation?.lifecycle.acceptedAt ?? "");
      return leftAt - rightAt;
    })
    .reduce(applyOneOptimisticMutation, record);
}

export function isStoredWorkReportOptimisticMutation(
  value: unknown
): value is WorkReportOptimisticMutation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<WorkReportOptimisticMutation>;
  if (!isStoredMutationLifecycle(candidate.lifecycle) || !candidate.patch) {
    return false;
  }
  if (candidate.patch.kind === "create-rows") {
    return Array.isArray(candidate.patch.rows) && candidate.patch.rows.every(
      (row) =>
        typeof row.clientRowKey === "string" &&
        row.payload !== null &&
        typeof row.payload === "object"
    );
  }
  if (candidate.patch.kind === "update-row") {
    return (
      typeof candidate.patch.rowId === "string" &&
      candidate.patch.payload !== null &&
      typeof candidate.patch.payload === "object"
    );
  }
  if (candidate.patch.kind === "delete-rows") {
    return (
      Array.isArray(candidate.patch.rowIds) &&
      candidate.patch.rowIds.every((rowId) => typeof rowId === "string")
    );
  }
  return (
    candidate.patch.kind === "update-entry" &&
    candidate.patch.patch !== null &&
    typeof candidate.patch.patch === "object"
  );
}
