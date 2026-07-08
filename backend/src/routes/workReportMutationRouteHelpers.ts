import type { Request } from "express";
import { env } from "../config/env";
import {
  publishWorkReportFormUpdated,
  publishWorkReportUpdated,
} from "../events/realtimeEventBus";
import { ragicRequestScheduler } from "../infra/ragicRequestScheduler";
import { assertClientNotBlocked } from "./clientBlockGuard";
import { WorkReportRouterDeps } from "./workReportRouterTypes";
import { HttpError } from "../utils/httpError";
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
  assertClientNotBlocked(req);

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
  ctx: MutationRequestContext,
  options: {
    staleCheck?: {
      timeoutMs?: number;
      maxRetries?: number;
    };
  } = {}
): Promise<void> {
  await assertLocalMutationPreconditions(deps, ctx);
  await assertMutationEntryNotModified(deps, ctx, options.staleCheck);
}

export async function assertLocalMutationPreconditions(
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
}

export async function assertMutationEntryNotModified(
  deps: WorkReportRouterDeps,
  ctx: MutationRequestContext,
  options: {
    timeoutMs?: number;
    maxRetries?: number;
  } = {}
): Promise<void> {
  await deps.assertEntryNotModified(
    ctx.formId,
    ctx.entryId,
    ctx.expectedEntryLastUpdatedAt,
    {
      priority: "mutation",
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    }
  );
}

export async function tryRouteMutationEntryPrecheck(
  deps: WorkReportRouterDeps,
  ctx: MutationRequestContext
): Promise<"verified" | "deferred" | "skipped"> {
  if (!ctx.expectedEntryLastUpdatedAt) {
    return "skipped";
  }
  try {
    await assertMutationEntryNotModified(deps, ctx, {
      timeoutMs: env.WORK_REPORT_ROUTE_PRECHECK_TIMEOUT_MS,
      maxRetries: 0,
    });
    return "verified";
  } catch (error) {
    if (error instanceof HttpError && error.code === "ENTRY_CONFLICT") {
      console.warn("[work-report-mutation][route-precheck-conflict-deferred]", {
        formId: ctx.formId,
        entryId: ctx.entryId,
        rowId: ctx.rowId ?? null,
        timeoutMs: env.WORK_REPORT_ROUTE_PRECHECK_TIMEOUT_MS,
        scheduler: ragicRequestScheduler.getStats(),
      });
      return "deferred";
    }
    console.warn("[work-report-mutation][route-precheck-deferred]", {
      formId: ctx.formId,
      entryId: ctx.entryId,
      rowId: ctx.rowId ?? null,
      timeoutMs: env.WORK_REPORT_ROUTE_PRECHECK_TIMEOUT_MS,
      error: error instanceof Error ? error.message : String(error),
      scheduler: ragicRequestScheduler.getStats(),
    });
    return "deferred";
  }
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
