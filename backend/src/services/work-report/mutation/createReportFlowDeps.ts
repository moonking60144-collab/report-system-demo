import { ragicClient } from "../../../ragic/client";
import { verifyNewlyCreatedActivityLogEntryOrRollback } from "../../activityLog/activityLogWriteVerifier";
import { activityLogWriteReverifyService } from "../../activityLog/activityLogWriteReverifyService";
import { resolveActivityLogRequiredFields } from "../create/resolveActivityLogRequiredFields";
import {
  buildCreateRecalculateFlowDeps,
} from "../recalculate/workReportRecalculate";
import {
  buildOperatorDebugSnapshot,
  logCreateOperatorDiagnostics,
  logCreatePerformanceIfSlow,
  logOperatorDebugSnapshot,
} from "../shared/workReportDiagnostics";
import {
  buildSubtableRowData,
  findLikelyCreatedRow,
} from "../shared/workReportPayloadHelpers";
import { getRawEntry } from "../shared/workReportReadHelpers";
import { throwRagicHttpError } from "../shared/workReportWriteHelpers";
import { workReportReadService } from "../workReportReadService";
import { normalizePayloadForWrite } from "./normalizePayloadForWrite";
import type {
  CreateReportFlowCachePort,
  CreateReportFlowDeps,
  CreateReportFlowDiagnosticsPort,
  CreateReportFlowEntryPort,
  CreateReportFlowActivityLogPort,
  CreateReportFlowPayloadPort,
} from "./runCreateReportFlow";
import { validateReportPayload } from "./validateReportPayload";
import { workReportMutationCacheService } from "./workReportMutationCacheService";
import { workReportMutationPreconditionService } from "./workReportMutationPreconditionService";

export interface CreateReportFlowDepsOverrides {
  entry?: Partial<CreateReportFlowEntryPort>;
  payload?: Partial<CreateReportFlowPayloadPort>;
  activityLog?: Partial<CreateReportFlowActivityLogPort>;
  diagnostics?: Partial<CreateReportFlowDiagnosticsPort>;
  cache?: Partial<CreateReportFlowCachePort>;
}

export function createReportFlowDeps(
  overrides: CreateReportFlowDepsOverrides = {}
): CreateReportFlowDeps {
  const entry: CreateReportFlowEntryPort = {
    assertEntryNotModified:
      workReportMutationPreconditionService.assertEntryNotModified.bind(
        workReportMutationPreconditionService
      ),
    getRawEntry,
    getFormOptions: workReportReadService.getFormOptions.bind(workReportReadService),
    ...overrides.entry,
  };
  const payload: CreateReportFlowPayloadPort = {
    validateReportPayload,
    normalizePayloadForWrite,
    buildSubtableRowData,
    ...overrides.payload,
  };
  const activityLog: CreateReportFlowActivityLogPort = {
    createEntry: ragicClient.createEntry.bind(ragicClient),
    verifyNewlyCreatedEntry: verifyNewlyCreatedActivityLogEntryOrRollback,
    enqueueReverify: activityLogWriteReverifyService.enqueue.bind(activityLogWriteReverifyService),
    resolveActivityLogRequiredFields,
    findLikelyCreatedRow,
    buildCreateRecalculateFlowDeps,
    throwRagicHttpError,
    ...overrides.activityLog,
  };
  const diagnostics: CreateReportFlowDiagnosticsPort = {
    logCreateOperatorDiagnostics,
    buildOperatorDebugSnapshot,
    logOperatorDebugSnapshot,
    logCreatePerformanceIfSlow,
    ...overrides.diagnostics,
  };
  const cache: CreateReportFlowCachePort = {
    markReportFullCacheDirty:
      workReportMutationCacheService.markReportFullCacheDirty.bind(
        workReportMutationCacheService
      ),
    ...overrides.cache,
  };

  return {
    entry,
    payload,
    activityLog,
    diagnostics,
    cache,
  };
}
