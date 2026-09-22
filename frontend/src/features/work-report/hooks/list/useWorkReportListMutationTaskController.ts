import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  updateWorkOrderMainMachineAccepted,
  updateWorkOrderPlannedEndDateAccepted,
  updateWorkOrderSortOrderAccepted,
  updateWorkOrderStartScheduleAccepted,
  updateWorkOrderUrgentAccepted,
  type CreateReportTaskAcceptedResult,
  type WorkReportRecord,
} from "../../../../api/workReport";
import {
  resolveTaskMutationLifecycleState,
  type OptimisticMutationState,
} from "../../mutationLifecycle";
import {
  createWorkReportOptimisticMutation,
  reconcileWorkReportOptimisticMutation,
} from "../../workReportOptimisticMutation";
import { WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED } from "../../optimisticMutationFeatureFlags";
import {
  bindRetryableEntryFieldMutationTask,
  getEntryFieldTaskRetryStoreRevision,
  getOrCreateRetryableEntryFieldMutation,
  isEntryFieldMutationOperation,
  isRetryableEntryFieldMutationBlocking,
  listRetryableEntryFieldMutations,
  subscribeEntryFieldTaskRetryStore,
  type RetryableEntryFieldMutation,
  type RetryableEntryFieldMutationInput,
} from "../../entryFieldTaskRetryStore";
import {
  isEntryFieldMutationConfirmationReusable,
  orderEntryFieldSettlementTasksForConsumption,
  shouldReplayEntryFieldOptimisticTask,
  shouldReplayEntryFieldMutationPatch,
} from "../../entryFieldMutationSettlement";
import type { EntryFieldSettlementConsumer } from "../useTaskMonitor";
import type {
  CreateTaskMonitor,
  NoticeState,
  WorkReportFormId,
} from "../../types";
import { normalizePlannedEndDate } from "../../utils/plannedEndDateUtils";
import { parseSemanticBoolean } from "../../utils";

interface UseWorkReportListMutationTaskControllerArgs {
  currentFormId: WorkReportFormId;
  records: WorkReportRecord[];
  authoritativeRecords: readonly WorkReportRecord[];
  createTaskMonitors: CreateTaskMonitor[];
  registerEntryFieldSettlementConsumer: (
    formId: WorkReportFormId,
    consumer: EntryFieldSettlementConsumer
  ) => () => void;
  upsertCreateTaskMonitor: (task: CreateTaskMonitor) => void;
  mergeListRecord: (
    formId: WorkReportFormId,
    incomingRecord: WorkReportRecord,
    expectedPatch?: Partial<WorkReportRecord>
  ) => void;
  patchListRecord: (
    formId: WorkReportFormId,
    entryId: string,
    patch: Partial<WorkReportRecord>
  ) => void;
  setNotice: Dispatch<SetStateAction<NoticeState | null>>;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function parseRollbackSortOrder(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseRollbackPlannedEndDate(value: unknown): string | null {
  return normalizePlannedEndDate(value);
}

function parseRollbackBoolean(value: unknown): boolean {
  return parseSemanticBoolean(value) ?? false;
}

type EntryFieldMutationOperation = RetryableEntryFieldMutation["operation"];
type EntryFieldMutationSyncingEntryKeysByOperation = ReadonlyMap<
  EntryFieldMutationOperation,
  ReadonlySet<string>
>;

export function buildEntryFieldMutationSyncingEntryIdsByOperation(input: {
  currentFormId: WorkReportFormId;
  localSyncingEntryKeysByOperation: EntryFieldMutationSyncingEntryKeysByOperation;
  retryMutations: readonly RetryableEntryFieldMutation[];
  taskMonitors?: readonly Pick<
    CreateTaskMonitor,
    | "taskId"
    | "formId"
    | "entryId"
    | "entryFieldOperation"
    | "entryFieldSettlementOutcome"
    | "optimisticMutation"
  >[];
}): ReadonlyMap<EntryFieldMutationOperation, ReadonlySet<string>> {
  const syncingEntryIdsByOperation = new Map<
    EntryFieldMutationOperation,
    Set<string>
  >();
  const add = (operation: EntryFieldMutationOperation, entryId: string) => {
    const current = syncingEntryIdsByOperation.get(operation) ?? new Set<string>();
    current.add(entryId);
    syncingEntryIdsByOperation.set(operation, current);
  };
  const keyPrefix = `${input.currentFormId}:`;

  for (const [operation, entryKeys] of input.localSyncingEntryKeysByOperation) {
    for (const entryKey of entryKeys) {
      if (entryKey.startsWith(keyPrefix)) {
        add(operation, entryKey.slice(keyPrefix.length));
      }
    }
  }
  for (const monitor of input.taskMonitors ?? []) {
    const operation =
      monitor.entryFieldOperation ??
      monitor.optimisticMutation?.lifecycle.operation;
    if (
      monitor.formId === input.currentFormId &&
      monitor.entryFieldSettlementOutcome === undefined &&
      isEntryFieldMutationOperation(operation)
    ) {
      add(operation, monitor.entryId);
    }
  }
  for (const mutation of input.retryMutations) {
    const monitor = input.taskMonitors?.find(
      (task) => task.taskId === mutation.taskId
    );
    if (
      mutation.formId === input.currentFormId &&
      isRetryableEntryFieldMutationBlocking(mutation, monitor)
    ) {
      add(mutation.operation, mutation.entryId);
    }
  }
  return syncingEntryIdsByOperation;
}

export function buildEntryFieldMutationBlockedEntryIds(
  syncingEntryIdsByOperation: EntryFieldMutationSyncingEntryKeysByOperation
): ReadonlySet<string> {
  const blockedEntryIds = new Set<string>();
  for (const entryIds of syncingEntryIdsByOperation.values()) {
    for (const entryId of entryIds) {
      blockedEntryIds.add(entryId);
    }
  }
  return blockedEntryIds;
}

export function shouldDisplayEntryFieldOptimisticState(
  state: OptimisticMutationState | undefined
): boolean {
  return state === undefined || state === "applied" || state === "confirmed";
}

export function shouldDisplayStoredEntryFieldPendingPatch(
  taskState: OptimisticMutationState | undefined,
  storedState: OptimisticMutationState | undefined
): boolean {
  return shouldDisplayEntryFieldOptimisticState(taskState ?? storedState);
}

export function findEntryFieldMutationAuthoritativeRecord(
  entryId: string,
  authoritativeRecords: readonly WorkReportRecord[],
  previewRecords: readonly WorkReportRecord[]
): WorkReportRecord | undefined {
  return (
    authoritativeRecords.find((record) => String(record.id) === entryId) ??
    previewRecords.find((record) => String(record.id) === entryId)
  );
}

export function selectEntryFieldMutationAuthoritativeRecords(input: {
  previewRecords: readonly WorkReportRecord[];
  allRecords: readonly WorkReportRecord[];
  hasHydratedAllRecords: boolean;
}): readonly WorkReportRecord[] {
  return input.hasHydratedAllRecords
    ? input.allRecords
    : input.previewRecords;
}

interface AcceptedEntryFieldMutation {
  accepted: CreateReportTaskAcceptedResult;
  operation: EntryFieldMutationOperation;
  clientMutationId: string;
  formId: WorkReportFormId;
  entryId: string;
  workOrderNo: string;
  previousSnapshot: unknown;
  patch: Partial<WorkReportRecord>;
}

function getEntryFieldMutationMessageKey(
  operation: EntryFieldMutationOperation,
  state: "queued" | "success" | "failed"
): string {
  const prefix =
    operation === "work-report-start-schedule"
      ? "startSchedule"
      : operation === "work-report-main-machine"
        ? "mainMachine"
        : operation === "work-report-planned-end-date"
          ? "plannedEndDate"
          : operation === "work-report-urgent"
            ? "urgent"
            : "sortOrder";
  if (state === "queued") return `workReport:table.${prefix}Queued`;
  if (state === "success") return `workReport:table.${prefix}Updated`;
  return `workReport:table.${prefix}UpdateFailed`;
}

export function useWorkReportListMutationTaskController({
  currentFormId,
  records,
  authoritativeRecords,
  createTaskMonitors,
  registerEntryFieldSettlementConsumer,
  upsertCreateTaskMonitor,
  mergeListRecord,
  patchListRecord,
  setNotice,
  t,
}: UseWorkReportListMutationTaskControllerArgs) {
  const appliedSettledEntryFieldTaskIdsRef = useRef<Set<string>>(new Set());
  const [
    localEntryFieldMutationSyncingEntryKeysByOperation,
    setLocalEntryFieldMutationSyncingEntryKeysByOperation,
  ] = useState<Map<EntryFieldMutationOperation, Set<string>>>(() => new Map());
  const setEntryFieldMutationSyncing = useCallback(
    (
      operation: EntryFieldMutationOperation,
      formId: WorkReportFormId,
      entryId: string,
      syncing: boolean
    ) => {
      setLocalEntryFieldMutationSyncingEntryKeysByOperation((current) => {
        const normalizedEntryId = String(entryId).trim();
        const key = `${formId}:${normalizedEntryId}`;
        const currentEntryKeys = current.get(operation) ?? new Set<string>();
        if (!normalizedEntryId || currentEntryKeys.has(key) === syncing) {
          return current;
        }
        const next = new Map(current);
        const nextEntryKeys = new Set(currentEntryKeys);
        if (syncing) nextEntryKeys.add(key);
        else nextEntryKeys.delete(key);
        if (nextEntryKeys.size > 0) next.set(operation, nextEntryKeys);
        else next.delete(operation);
        return next;
      });
    },
    []
  );
  const entryFieldTaskRetryStoreRevision = useSyncExternalStore(
    subscribeEntryFieldTaskRetryStore,
    getEntryFieldTaskRetryStoreRevision,
    getEntryFieldTaskRetryStoreRevision
  );
  const entryFieldMutationSyncingEntryIdsByOperation =
    buildEntryFieldMutationSyncingEntryIdsByOperation({
      currentFormId,
      localSyncingEntryKeysByOperation:
        localEntryFieldMutationSyncingEntryKeysByOperation,
      retryMutations: listRetryableEntryFieldMutations(currentFormId),
      taskMonitors: createTaskMonitors,
    });
  const entryFieldMutationBlockedEntryIds = buildEntryFieldMutationBlockedEntryIds(
    entryFieldMutationSyncingEntryIdsByOperation
  );
  useEffect(() => {
    return registerEntryFieldSettlementConsumer(currentFormId, {
      getCurrentRecord: (entryId) =>
        findEntryFieldMutationAuthoritativeRecord(
          entryId,
          authoritativeRecords,
          records
        ),
      applySettlement: ({ taskId, authoritativeRecord, expectedPatch }) => {
        mergeListRecord(currentFormId, authoritativeRecord, expectedPatch);
        appliedSettledEntryFieldTaskIdsRef.current.add(taskId);
      },
    });
  }, [
    authoritativeRecords,
    currentFormId,
    mergeListRecord,
    records,
    registerEntryFieldSettlementConsumer,
  ]);

  useEffect(() => {
    if (!WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED) {
      return;
    }
    for (const task of createTaskMonitors) {
      const mutation = task.optimisticMutation;
      const currentRecord = findEntryFieldMutationAuthoritativeRecord(
        task.entryId,
        authoritativeRecords,
        records
      );
      if (
        task.formId !== currentFormId ||
        !mutation ||
        mutation.patch.kind !== "update-entry" ||
        !shouldReplayEntryFieldOptimisticTask(task, currentRecord)
      ) {
        continue;
      }
      if (!shouldDisplayEntryFieldOptimisticState(mutation.lifecycle.optimisticState)) {
        continue;
      }
      patchListRecord(currentFormId, task.entryId, mutation.patch.patch);
    }
  }, [
    authoritativeRecords,
    createTaskMonitors,
    currentFormId,
    entryFieldTaskRetryStoreRevision,
    patchListRecord,
    records,
  ]);

  useEffect(() => {
    for (const mutation of listRetryableEntryFieldMutations(currentFormId)) {
      const taskMonitor = mutation.taskId
        ? createTaskMonitors.find((task) => task.taskId === mutation.taskId)
        : undefined;
      const taskOptimisticState =
        taskMonitor?.optimisticMutation?.lifecycle.optimisticState;
      const currentRecord = findEntryFieldMutationAuthoritativeRecord(
        mutation.entryId,
        authoritativeRecords,
        records
      );
      if (
        WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED &&
        mutation.pendingPatch &&
        (taskMonitor?.confirmedEntry
          ? isEntryFieldMutationConfirmationReusable(
              taskMonitor.confirmedEntry,
              currentRecord,
              mutation
            )
          : shouldReplayEntryFieldMutationPatch(
              mutation.expectedEntryLastUpdatedAt,
              mutation,
              currentRecord,
              taskMonitor
            )) &&
        shouldDisplayStoredEntryFieldPendingPatch(
          taskOptimisticState,
          mutation.lifecycle?.optimisticState
        )
      ) {
        patchListRecord(mutation.formId, mutation.entryId, mutation.pendingPatch);
      }
    }
  }, [
    authoritativeRecords,
    createTaskMonitors,
    currentFormId,
    entryFieldTaskRetryStoreRevision,
    patchListRecord,
    records,
  ]);

  useEffect(() => {
    for (const task of orderEntryFieldSettlementTasksForConsumption(
      createTaskMonitors
    )) {
      if (
        task.formId !== currentFormId ||
        !task.entryFieldSettlementRecord ||
        appliedSettledEntryFieldTaskIdsRef.current.has(task.taskId)
      ) {
        continue;
      }
      appliedSettledEntryFieldTaskIdsRef.current.add(task.taskId);
      const expectedPatch = task.confirmedEntry?.patch ??
        (task.optimisticMutation?.patch.kind === "update-entry"
          ? task.optimisticMutation.patch.patch
          : undefined);
      mergeListRecord(
        currentFormId,
        task.entryFieldSettlementRecord,
        expectedPatch
      );
    }
  }, [createTaskMonitors, currentFormId, mergeListRecord]);

  const registerAcceptedEntryFieldMutation = useCallback(
    ({
      accepted,
      operation,
      clientMutationId,
      formId,
      entryId,
      workOrderNo,
      previousSnapshot,
      patch,
    }: AcceptedEntryFieldMutation) => {
      if (
        accepted.status !== "failed" &&
        WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED
      ) {
        patchListRecord(formId, entryId, patch);
      }

      const lifecycleState =
        accepted.lifecycleState ??
        resolveTaskMutationLifecycleState({ status: accepted.status });
      const optimisticMutation = WORK_REPORT_OPTIMISTIC_MUTATIONS_ENABLED
        ? reconcileWorkReportOptimisticMutation(
            createWorkReportOptimisticMutation({
              taskId: accepted.taskId,
              mutationId: clientMutationId,
              operation,
              target: {
                domain: "work-report",
                formId,
                entryId,
              },
              acceptedAt: accepted.acceptedAt ?? accepted.createdAt,
              reconcilePolicy: "replace-target",
              failurePolicy: "rollback",
              previousSnapshot,
              patch: {
                kind: "update-entry",
                patch,
              },
            }),
            {
              lifecycleState,
              confirmedAt: accepted.confirmedAt,
            }
          )
        : undefined;
      const messageState =
        accepted.status === "success"
          ? "success"
          : accepted.status === "failed"
            ? "failed"
            : "queued";
      const message = t(getEntryFieldMutationMessageKey(operation, messageState));
      upsertCreateTaskMonitor({
        taskId: accepted.taskId,
        kind: "update",
        formId,
        entryId,
        workOrderNo,
        status: accepted.status,
        lifecycleState,
        acceptedAt: accepted.acceptedAt ?? accepted.createdAt,
        confirmedAt: accepted.confirmedAt ?? null,
        entryFieldOperation: operation,
        entryFieldClientMutationId: clientMutationId,
        message,
        updatedAt: new Date().toISOString(),
        ...(optimisticMutation ? { optimisticMutation } : {}),
      });
      setNotice({
        type: accepted.status === "failed" ? "error" : "info",
        message,
      });
      setEntryFieldMutationSyncing(operation, formId, entryId, false);
    },
    [
      patchListRecord,
      setNotice,
      setEntryFieldMutationSyncing,
      t,
      upsertCreateTaskMonitor,
    ]
  );

  const submitEntryFieldMutation = useCallback(
    async (
      record: WorkReportRecord,
      input: RetryableEntryFieldMutationInput,
      send: (
        retryRecord: RetryableEntryFieldMutation
      ) => Promise<CreateReportTaskAcceptedResult>
    ) => {
      const entryId = String(record.id);
      setEntryFieldMutationSyncing(input.operation, currentFormId, entryId, true);
      try {
        const retryRecord = getOrCreateRetryableEntryFieldMutation(input);
        const accepted = await send(retryRecord);
        bindRetryableEntryFieldMutationTask(
          retryRecord.operation,
          retryRecord.clientMutationId,
          accepted.taskId,
          accepted.acceptedAt ?? accepted.createdAt
        );
        registerAcceptedEntryFieldMutation({
          accepted,
          operation: retryRecord.operation,
          clientMutationId: retryRecord.clientMutationId,
          formId: retryRecord.formId,
          entryId: retryRecord.entryId,
          workOrderNo: String(record.workOrderNo ?? record.id),
          previousSnapshot: retryRecord.rollbackPatch ?? {},
          patch: retryRecord.successPatch,
        });
      } catch (error) {
        setEntryFieldMutationSyncing(input.operation, currentFormId, entryId, false);
        throw error;
      }
    },
    [
      currentFormId,
      registerAcceptedEntryFieldMutation,
      setEntryFieldMutationSyncing,
    ]
  );

  const requireExpectedEntryLastUpdatedAt = useCallback(
    (record: WorkReportRecord, messageKey: string): string => {
      const value = String(record.lastUpdatedAt ?? "").trim();
      if (!value) throw new Error(t(messageKey));
      return value;
    },
    [t]
  );

  const handleUpdateSortOrder = useCallback(
    async (record: WorkReportRecord, sortOrder: number) => {
      await submitEntryFieldMutation(
        record,
        {
          operation: "work-report-sort-order",
          formId: currentFormId,
          entryId: String(record.id),
          value: sortOrder,
          previousValue: parseRollbackSortOrder(record.sortOrder),
          workOrderNo: record.workOrderNo,
          expectedEntryLastUpdatedAt: record.lastUpdatedAt ?? undefined,
        },
        (retryRecord) =>
          updateWorkOrderSortOrderAccepted(
            retryRecord.formId,
            retryRecord.entryId,
            sortOrder,
            {
              expectedSortOrder: retryRecord.fieldPreconditionVersion === 1 && retryRecord.hasPreviousValue
                ? retryRecord.previousValue as number | null
                : undefined,
              clientMutationId: retryRecord.clientMutationId,
              workOrderNo: retryRecord.workOrderNo,
              expectedEntryLastUpdatedAt: retryRecord.expectedEntryLastUpdatedAt,
            }
          )
      );
    },
    [currentFormId, submitEntryFieldMutation]
  );

  const handleUpdatePlannedEndDate = useCallback(
    async (record: WorkReportRecord, plannedEndDate: string) => {
      const expectedEntryLastUpdatedAt = requireExpectedEntryLastUpdatedAt(
        record,
        "workReport:table.plannedEndDatePreconditionMissing"
      );
      await submitEntryFieldMutation(
        record,
        {
          operation: "work-report-planned-end-date",
          formId: currentFormId,
          entryId: String(record.id),
          value: plannedEndDate,
          previousValue: parseRollbackPlannedEndDate(record.plannedEndDate),
          workOrderNo: record.workOrderNo,
          expectedEntryLastUpdatedAt,
        },
        (retryRecord) =>
          updateWorkOrderPlannedEndDateAccepted(
            retryRecord.formId,
            retryRecord.entryId,
            plannedEndDate,
            {
              expectedPlannedEndDate: retryRecord.fieldPreconditionVersion === 1 && retryRecord.hasPreviousValue
                ? retryRecord.previousValue as string | null : undefined,
              clientMutationId: retryRecord.clientMutationId,
              workOrderNo: retryRecord.workOrderNo,
              expectedEntryLastUpdatedAt,
            }
          )
      );
    },
    [
      currentFormId,
      requireExpectedEntryLastUpdatedAt,
      submitEntryFieldMutation,
    ]
  );

  const handleUpdateUrgent = useCallback(
    async (record: WorkReportRecord, urgent: boolean) => {
      const expectedEntryLastUpdatedAt = requireExpectedEntryLastUpdatedAt(
        record,
        "workReport:table.urgentPreconditionMissing"
      );
      await submitEntryFieldMutation(
        record,
        {
          operation: "work-report-urgent",
          formId: currentFormId,
          entryId: String(record.id),
          value: urgent,
          previousValue: parseRollbackBoolean(record.urgent),
          workOrderNo: record.workOrderNo,
          expectedEntryLastUpdatedAt,
        },
        (retryRecord) =>
          updateWorkOrderUrgentAccepted(
            retryRecord.formId,
            retryRecord.entryId,
            urgent,
            {
              expectedUrgent: retryRecord.fieldPreconditionVersion === 1 && retryRecord.hasPreviousValue
                ? retryRecord.previousValue as boolean : undefined,
              clientMutationId: retryRecord.clientMutationId,
              workOrderNo: retryRecord.workOrderNo,
              expectedEntryLastUpdatedAt,
            }
          )
      );
    },
    [
      currentFormId,
      requireExpectedEntryLastUpdatedAt,
      submitEntryFieldMutation,
    ]
  );

  const handleUpdateStartSchedule = useCallback(
    async (record: WorkReportRecord, startSchedule: boolean) => {
      const expectedEntryLastUpdatedAt = requireExpectedEntryLastUpdatedAt(
        record,
        "workReport:table.startSchedulePreconditionMissing"
      );
      await submitEntryFieldMutation(
        record,
        {
          operation: "work-report-start-schedule",
          formId: currentFormId,
          entryId: String(record.id),
          value: startSchedule,
          previousValue: parseRollbackBoolean(record.startSchedule),
          workOrderNo: record.workOrderNo,
          expectedEntryLastUpdatedAt,
        },
        (retryRecord) =>
          updateWorkOrderStartScheduleAccepted(
            retryRecord.formId,
            retryRecord.entryId,
            startSchedule,
            {
              expectedStartSchedule: retryRecord.fieldPreconditionVersion === 1 && retryRecord.hasPreviousValue
                ? retryRecord.previousValue as boolean : undefined,
              clientMutationId: retryRecord.clientMutationId,
              workOrderNo: retryRecord.workOrderNo,
              expectedEntryLastUpdatedAt,
            }
          )
      );
    },
    [
      currentFormId,
      requireExpectedEntryLastUpdatedAt,
      submitEntryFieldMutation,
    ]
  );

  const handleUpdateMainMachine = useCallback(
    async (record: WorkReportRecord, machineCode: string) => {
      const expectedEntryLastUpdatedAt = requireExpectedEntryLastUpdatedAt(
        record,
        "workReport:table.mainMachinePreconditionMissing"
      );
      const previousMachineCode = String(
        currentFormId === "902" ? record.filterMachineCode ?? "" : record.machineCode ?? ""
      ).trim();
      await submitEntryFieldMutation(
        record,
        {
          operation: "work-report-main-machine",
          formId: currentFormId,
          entryId: String(record.id),
          value: machineCode,
          previousValue: previousMachineCode || null,
          workOrderNo: record.workOrderNo,
          expectedEntryLastUpdatedAt,
        },
        (retryRecord) =>
          updateWorkOrderMainMachineAccepted(
            retryRecord.formId,
            retryRecord.entryId,
            machineCode,
            {
              expectedMachineCode: retryRecord.fieldPreconditionVersion === 1 && retryRecord.hasPreviousValue
                ? retryRecord.previousValue as string | null : undefined,
              clientMutationId: retryRecord.clientMutationId,
              workOrderNo: retryRecord.workOrderNo,
              expectedEntryLastUpdatedAt,
            }
          )
      );
    },
    [
      currentFormId,
      requireExpectedEntryLastUpdatedAt,
      submitEntryFieldMutation,
    ]
  );

  return {
    handleUpdateStartSchedule,
    handleUpdateMainMachine,
    handleUpdateUrgent,
    handleUpdateSortOrder,
    handleUpdatePlannedEndDate,
    entryFieldMutationSyncingEntryIdsByOperation,
    entryFieldMutationBlockedEntryIds,
  };
}
