import type { Request } from "express";
import {
  publishWorkReportFormUpdated,
  publishWorkReportUpdated,
} from "../events/realtimeEventBus";
import { WorkReportRouterDeps } from "./workReportRouterTypes";
import {
  assertRequiredPathValue,
  assertWritableFormId,
  parseEditLockVersion,
  parseEditSessionId,
  parseExpectedEntryLastUpdatedAt,
} from "./workReportRequest";

// 保留 re-export 避免動到既有 callers；新程式碼請直接從 ./taskActorContext import
import { readTaskActorContext, type TaskActorContext } from "./taskActorContext";
export { readTaskActorContext, type TaskActorContext };

export async function projectSqliteAfterMutationSafe(
  deps: WorkReportRouterDeps,
  formId: string,
  entryId: string,
  reason: "create" | "update" | "delete"
): Promise<void> {
  try {
    await deps.projectSqliteAfterMutation(formId, entryId, reason);
  } catch (error) {
    console.warn("[sqlite-entry-projection-failed]", {
      formId,
      entryId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function publishMutationUpdated(formId: string, entryId: string): void {
  publishWorkReportUpdated(formId, entryId);
  publishWorkReportFormUpdated(formId);
}

export interface MutationRequestContext {
  formId: string;
  entryId: string;
  rowId?: string;
  editSessionId?: string;
  editLockVersion?: number;
  expectedEntryLastUpdatedAt?: string;
  clientMutationId?: string;
  actor: TaskActorContext;
}

interface ParseMutationContextOptions {
  includeRowId?: boolean;
}

export function parseMutationRequestContext(
  req: Request,
  options: ParseMutationContextOptions = {}
): MutationRequestContext {
  const formId = req.params.formId;
  const entryId = req.params.entryId;
  const rowId = options.includeRowId ? req.params.rowId : undefined;

  assertWritableFormId(formId);
  assertRequiredPathValue(entryId, "entryId");
  if (options.includeRowId) {
    assertRequiredPathValue(rowId, "rowId");
  }

  return {
    formId,
    entryId,
    rowId,
    editSessionId: parseEditSessionId(req.header("x-edit-session-id")),
    editLockVersion: parseEditLockVersion(req.header("x-edit-lock-version")),
    expectedEntryLastUpdatedAt: parseExpectedEntryLastUpdatedAt(
      req.header("x-entry-last-updated-at")
    ),
    clientMutationId: String(req.header("x-client-mutation-id") ?? "").trim() || undefined,
    actor: readTaskActorContext(req),
  };
}

export async function assertFullMutationPreconditions(
  deps: WorkReportRouterDeps,
  ctx: MutationRequestContext
): Promise<void> {
  await deps.assertEntryEditableBySession({
    formId: ctx.formId,
    entryId: ctx.entryId,
    rowId: ctx.rowId,
    editSessionId: ctx.editSessionId,
  });
  await deps.assertEntryLockVersion({
    formId: ctx.formId,
    entryId: ctx.entryId,
    rowId: ctx.rowId,
    editSessionId: ctx.editSessionId,
    editLockVersion: ctx.editLockVersion,
  });
  await deps.assertEntryNotModified(
    ctx.formId,
    ctx.entryId,
    ctx.expectedEntryLastUpdatedAt
  );
}

export async function runPostMutationHooks(
  deps: WorkReportRouterDeps,
  formId: string,
  entryId: string,
  mutationType: "create" | "update" | "delete"
): Promise<void> {
  await projectSqliteAfterMutationSafe(deps, formId, entryId, mutationType);
  publishMutationUpdated(formId, entryId);
}
