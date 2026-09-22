import type { RagicRecord } from "../ragic/client";
import type { ReportWritePayload } from "../types/workReport";
import type { CreateReportFlowOptions } from "./work-report/mutation/runCreateReportFlow";
import { workReportCreateMutationService } from "./work-report/mutation/workReportCreateMutationService";
import {
  workReportMutationPreconditionService,
  type EntryConflictPreconditionOptions,
  type EntryEditingPreconditionInput,
  type EntryLockVersionPreconditionInput,
} from "./work-report/mutation/workReportMutationPreconditionService";
import {
  workReportRowMutationService,
  type WorkReportDeleteOptions,
  type WorkReportRowMutationResult,
  type WorkReportRowMutationOptions,
} from "./work-report/mutation/workReportRowMutationService";
import {
  workReportWorkOrderCommandService,
  type WorkOrderCommandOptions,
} from "./work-report/mutation/workReportWorkOrderCommandService";

export { reconcileHardDeleteWriteFailure } from "./work-report/mutation/workReportRowMutationService";

class WorkReportService {
  async createReport(
    formId: string,
    entryId: string,
    payload: ReportWritePayload,
    options: CreateReportFlowOptions = {}
  ): Promise<{ rowId: string }> {
    return workReportCreateMutationService.createReport(
      formId,
      entryId,
      payload,
      options
    );
  }

  async updateReport(
    formId: string,
    entryId: string,
    rowId: string,
    payload: ReportWritePayload,
    options: WorkReportRowMutationOptions = {}
  ): Promise<WorkReportRowMutationResult> {
    return workReportRowMutationService.updateReport(
      formId,
      entryId,
      rowId,
      payload,
      options
    );
  }
  async hardDeleteReport(
    formId: string,
    entryId: string,
    rowId: string,
    options: WorkReportDeleteOptions = {}
  ): Promise<WorkReportRowMutationResult> {
    return workReportRowMutationService.hardDeleteReport(
      formId,
      entryId,
      rowId,
      options
    );
  }
  async finalizeBatchDelete(
    formId: string,
    entryId: string,
    rowIds: string[]
  ): Promise<void> {
    await workReportRowMutationService.finalizeBatchDelete(formId, entryId, rowIds);
  }
  async finalizeBatchCreate(
    formId: string,
    entryId: string,
    rowIds: string[]
  ): Promise<void> {
    await workReportCreateMutationService.finalizeBatchCreate(formId, entryId, rowIds);
  }

  async updateMainMachine(
    formId: string,
    entryId: string,
    machineCode: string,
    options: WorkOrderCommandOptions = {}
  ): Promise<{
    machineCode: string;
    previousMachineCode: string | null;
    changed: boolean;
  }> {
    return workReportWorkOrderCommandService.updateMainMachine(
      formId,
      entryId,
      machineCode,
      options
    );
  }

  async updateSortOrder(
    formId: string,
    entryId: string,
    sortOrder: number,
    options: WorkOrderCommandOptions = {}
  ): Promise<{
    sortOrder: number;
    previousSortOrder: number | null;
    changed: boolean;
  }> {
    return workReportWorkOrderCommandService.updateSortOrder(
      formId,
      entryId,
      sortOrder,
      options
    );
  }
  async updatePlannedEndDate(
    formId: string,
    entryId: string,
    plannedEndDate: string,
    options: WorkOrderCommandOptions = {}
  ): Promise<{
    plannedEndDate: string;
    previousPlannedEndDate: string | null;
    changed: boolean;
  }> {
    return workReportWorkOrderCommandService.updatePlannedEndDate(
      formId,
      entryId,
      plannedEndDate,
      options
    );
  }
  async updateUrgent(
    formId: string,
    entryId: string,
    urgent: boolean,
    options: WorkOrderCommandOptions = {}
  ): Promise<{ urgent: boolean; previousUrgent: boolean; changed: boolean }> {
    return workReportWorkOrderCommandService.updateUrgent(
      formId,
      entryId,
      urgent,
      options
    );
  }
  async updateStartSchedule(
    formId: string,
    entryId: string,
    startSchedule: boolean,
    options: WorkOrderCommandOptions = {}
  ): Promise<{
    startSchedule: boolean;
    previousStartSchedule: boolean;
    changed: boolean;
  }> {
    return workReportWorkOrderCommandService.updateStartSchedule(
      formId,
      entryId,
      startSchedule,
      options
    );
  }
  async manualCloseWorkOrder(
    formId: string,
    entryId: string,
    action: "close" | "reopen",
    options: WorkOrderCommandOptions = {}
  ): Promise<{ action: "close" | "reopen"; previousStatus: string | null }> {
    return workReportWorkOrderCommandService.manualCloseWorkOrder(
      formId,
      entryId,
      action,
      options
    );
  }
  async assertEntryNotModified(
    formId: string,
    entryId: string,
    expectedEntryLastUpdatedAt?: string,
    options: EntryConflictPreconditionOptions = {}
  ): Promise<void> {
    await workReportMutationPreconditionService.assertEntryNotModified(
      formId,
      entryId,
      expectedEntryLastUpdatedAt,
      options
    );
  }

  async assertEntryEditableBySession(
    input: EntryEditingPreconditionInput
  ): Promise<void> {
    workReportMutationPreconditionService.assertEntryEditableBySession(input);
  }

  async assertEntryLockVersion(
    input: EntryLockVersionPreconditionInput
  ): Promise<void> {
    workReportMutationPreconditionService.assertEntryLockVersion(input);
  }

  async assertCreateEntryAcceptsReports(
    formId: string,
    entryId: string
  ): Promise<RagicRecord> {
    return workReportMutationPreconditionService.assertCreateEntryAcceptsReports(
      formId,
      entryId
    );
  }

  async assertBatchCreateEntryAcceptsReports(
    formId: string,
    entryId: string
  ): Promise<RagicRecord> {
    return workReportMutationPreconditionService.assertBatchCreateEntryAcceptsReports(
      formId,
      entryId
    );
  }

}

export const workReportService = new WorkReportService();
