import type { Request, Response } from "express";
import {
  publishWorkReportFormUpdated,
  publishWorkReportUpdated,
} from "../events/realtimeEventBus";
import { runBackgroundTask } from "../infra/backgroundTaskRunner";
import { assertClientNotBlocked } from "./clientBlockGuard";
import { WorkReportRouterDeps } from "./workReportRouterTypes";
import { HttpError } from "../utils/httpError";
import { KeyedSerialQueueAbortedError } from "../utils/keyedSerialQueue";
import type {
  ProjectionApplyResult,
  ProjectionReason,
  SortOrderProjectionResult,
} from "../services/work-report-sync/workReportMutationProjectionServiceFactory";
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

async function enqueueSqliteProjectionAfterMutationSafe(
  deps: WorkReportRouterDeps,
  formId: string,
  entryId: string,
  reason: ProjectionReason
): Promise<number | null> {
  try {
    return await deps.enqueueSqliteProjectionAfterMutation(formId, entryId, reason);
  } catch (error) {
    console.warn("[sqlite-entry-projection-enqueue-failed]", {
      formId,
      entryId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function shouldPublishAfterProjection(result: ProjectionApplyResult): boolean {
  return result === "applied" || result === "deleted";
}

function shouldPublishAfterSortOrderProjection(result: SortOrderProjectionResult): boolean {
  return result === "applied" || result === "not-required";
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
  createIdempotencyKey?: string;
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
    createIdempotencyKey:
      String(req.header("x-create-idempotency-key") ?? "").trim() || undefined,
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

export async function runRequestEntryMutationExclusive<T>(input: {
  deps: WorkReportRouterDeps;
  ctx: MutationRequestContext;
  req: Request;
  res: Response;
  worker: () => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnUnfinishedResponseClose = () => {
    if (!input.res.writableEnded) {
      abort();
    }
  };
  input.req.once("aborted", abort);
  input.res.once("close", abortOnUnfinishedResponseClose);

  try {
    return await input.deps.runEntryMutationExclusive(
      input.ctx.formId,
      input.ctx.entryId,
      input.worker,
      { signal: controller.signal }
    );
  } catch (error) {
    if (error instanceof KeyedSerialQueueAbortedError) {
      throw new HttpError(499, "用戶端已中斷，排隊中的寫入未執行。", "CLIENT_CLOSED_REQUEST");
    }
    throw error;
  } finally {
    input.req.removeListener("aborted", abort);
    input.res.removeListener("close", abortOnUnfinishedResponseClose);
  }
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

export async function runPostMutationHooks(
  deps: WorkReportRouterDeps,
  formId: string,
  entryId: string,
  mutationType: "create" | "update" | "delete"
): Promise<void> {
  const projectionSeq = await enqueueSqliteProjectionAfterMutationSafe(
    deps,
    formId,
    entryId,
    mutationType
  );
  if (projectionSeq === null) {
    return;
  }
  if (projectionSeq <= 0) {
    publishMutationUpdated(formId, entryId);
    return;
  }

  runBackgroundTask(
    "work-report-mutation-projection",
    async () => {
      const result = await deps.applyQueuedSqliteProjectionAfterMutation(
        formId,
        entryId,
        mutationType,
        projectionSeq
      );
      if (shouldPublishAfterProjection(result)) {
        publishMutationUpdated(formId, entryId);
      }
    },
    (error) => {
      console.warn("[sqlite-entry-projection-apply-failed]", {
        formId,
        entryId,
        reason: mutationType,
        projectionSeq,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );
}

export async function runPostSortOrderMutationHooks(
  deps: WorkReportRouterDeps,
  formId: string,
  entryId: string,
  sortOrder: number
): Promise<void> {
  const projectionSeq = await enqueueSqliteProjectionAfterMutationSafe(
    deps,
    formId,
    entryId,
    "update"
  );
  if (projectionSeq === null) {
    return;
  }
  if (projectionSeq <= 0) {
    publishMutationUpdated(formId, entryId);
    return;
  }

  runBackgroundTask(
    "work-report-sort-order-projection",
    async () => {
      const projectionStartedAt = Date.now();
      const result = await deps.applyQueuedSortOrderSqliteAfterMutation(
        formId,
        entryId,
        sortOrder,
        projectionSeq
      );
      if (shouldPublishAfterSortOrderProjection(result)) {
        publishMutationUpdated(formId, entryId);
      }
      console.info("[work-report-sort-order][projection-timing]", {
        formId,
        entryId,
        projectionResult: result,
        projectionMs: Date.now() - projectionStartedAt,
      });
    },
    (error) => {
      console.warn("[sqlite-sort-order-projection-apply-failed]", {
        formId,
        entryId,
        sortOrder,
        projectionSeq,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );
}
