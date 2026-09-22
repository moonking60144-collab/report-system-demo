import { env } from "../../config/env";
import type {
  RagicReadPriority,
  RagicRequestAttemptTiming,
} from "../../infra/ragicRequestScheduler";
import { ragicClient, type RagicRecord } from "../../ragic/client";
import { createLogger } from "../../observability/logger";
import { HttpError } from "../../utils/httpError";
import { buildBackgroundReadOptions } from "../work-report/shared/refreshEntryOptions";
import { ACTIVITY_LOG_FIELD_KEYS, pickRagicField } from "./activityLogFieldKeys";

const log = createLogger("activityLog-write-verifier");

export interface VerifyActivityLogEntryExpected {
  /** 901/902 傳實際工令、downtime 傳空字串驗證 Ragic 沒亂塞；不填代表不驗 */
  workOrderNo?: string;
  /** 報工類別（resolvedReportType.type） */
  type?: string;
}

export interface ActivityLogObservedCoreFields {
  workOrderNo: string;
  type: string;
}

export interface ActivityLogMismatch {
  field: keyof ActivityLogObservedCoreFields;
  expected: string;
  actual: string;
}

export type ActivityLogVerificationObservation =
  | { kind: "confirmed"; entry: RagicRecord }
  | { kind: "gone" }
  | {
      kind: "mismatch";
      entry: RagicRecord;
      mismatches: ActivityLogMismatch[];
      observed: ActivityLogObservedCoreFields;
    };

export interface InspectActivityLogEntryOptions {
  readPriority?: RagicReadPriority;
  timeoutMs?: number;
  maxRetries?: number;
  onAttemptTiming?: (timing: RagicRequestAttemptTiming) => void;
}

export interface VerifyActivityLogEntryOptions extends InspectActivityLogEntryOptions {
  /** 讀取驗證本身失敗時視為「狀態未知」並放行；欄位 mismatch 仍會 rollback + throw */
  continueOnReadError?: boolean;
  /** 狀態未知時交給 caller 排入後續補驗；callback 失敗不應讓使用者寫入變成假失敗 */
  onReadIndeterminate?: (payload: VerifyActivityLogReadIndeterminatePayload) => void | Promise<void>;
}

export interface VerifyActivityLogReadIndeterminatePayload {
  rollbackPending?: boolean;
  activityLogPath: string;
  entryId: string;
  expected: VerifyActivityLogEntryExpected;
  readPriority: RagicReadPriority;
  timeoutMs?: number;
  maxRetries?: number;
  errorMessage: string;
  occurredAt: string;
}

export interface VerifyNewlyCreatedActivityLogEntryInput {
  activityLogPath: string;
  entryId: string;
  expected: VerifyActivityLogEntryExpected;
  /** 只有仍擁有本次新建 entry 的 create operation 可以呼叫 rollback wrapper。 */
  createOperationId: string;
  options?: VerifyActivityLogEntryOptions;
}

function resolveExpectedField(
  record: RagicRecord,
  fieldId: string,
  candidates: readonly string[]
): string {
  const fromId = (record as Record<string, unknown>)?.[fieldId];
  if (fromId !== undefined && fromId !== null && String(fromId).trim() !== "") {
    return String(fromId).trim();
  }
  return pickRagicField(record, candidates);
}

function readObservedCoreFields(entry: RagicRecord): ActivityLogObservedCoreFields {
  return {
    workOrderNo: resolveExpectedField(
      entry,
      env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID,
      ACTIVITY_LOG_FIELD_KEYS.workOrderNo
    ),
    type: resolveExpectedField(
      entry,
      env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID,
      ACTIVITY_LOG_FIELD_KEYS.reportType
    ),
  };
}

/** Ragic GET → normalize → compare → observation。沒有任何 mutation side effect。 */
export async function inspectActivityLogEntryStored(
  activityLogPath: string,
  entryId: string,
  expected: VerifyActivityLogEntryExpected,
  options: InspectActivityLogEntryOptions = {}
): Promise<ActivityLogVerificationObservation> {
  const readPriority = options.readPriority ?? "background";
  const readOptions = {
    ...buildBackgroundReadOptions(readPriority),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.onAttemptTiming ? { onAttemptTiming: options.onAttemptTiming } : {}),
  };
  const result = await ragicClient.observeEntry(activityLogPath, entryId, readOptions);
  if (result.kind === "gone") {
    return result;
  }

  const observed = readObservedCoreFields(result.record);
  const mismatches: ActivityLogMismatch[] = [];
  if (
    expected.workOrderNo !== undefined &&
    observed.workOrderNo !== String(expected.workOrderNo).trim()
  ) {
    mismatches.push({
      field: "workOrderNo",
      expected: String(expected.workOrderNo).trim(),
      actual: observed.workOrderNo,
    });
  }
  if (expected.type !== undefined && observed.type !== String(expected.type).trim()) {
    mismatches.push({
      field: "type",
      expected: String(expected.type).trim(),
      actual: observed.type,
    });
  }
  return mismatches.length === 0
    ? { kind: "confirmed", entry: result.record }
    : { kind: "mismatch", entry: result.record, mismatches, observed };
}

function formatMismatch(mismatch: ActivityLogMismatch): string {
  return `${mismatch.field}: expected="${mismatch.expected}" actual="${mismatch.actual}"`;
}

/**
 * Immediate create owner 專用：只有本次 operation 剛建立的 entry mismatch 時可 rollback。
 * 延遲補驗不得呼叫這個 wrapper。
 */
export async function verifyNewlyCreatedActivityLogEntryOrRollback(
  input: VerifyNewlyCreatedActivityLogEntryInput
): Promise<RagicRecord | null> {
  const { activityLogPath, entryId, expected, createOperationId, options = {} } = input;
  if (!createOperationId.trim()) {
    throw new HttpError(
      500,
      "activity log 即時驗證缺少 create operation ownership",
      "ACTIVITY_LOG_WRITE_ROLLBACK_OWNER_REQUIRED"
    );
  }
  let observation: ActivityLogVerificationObservation;
  try {
    observation = await inspectActivityLogEntryStored(activityLogPath, entryId, expected, options);
  } catch (error) {
    if (!options.continueOnReadError) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const readPriority = options.readPriority ?? "background";
    log.warn({
      event: "verify-read-indeterminate",
      entryId,
      activityLogPath,
      createOperationId,
      readPriority,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries ?? null,
      error: errorMessage,
    });
    if (options.onReadIndeterminate) {
      try {
        await options.onReadIndeterminate({
          activityLogPath,
          entryId,
          expected,
          readPriority,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
          errorMessage,
          occurredAt: new Date().toISOString(),
        });
      } catch (enqueueError) {
        log.error({
          event: "verify-read-indeterminate-enqueue-failed",
          entryId,
          activityLogPath,
          createOperationId,
          error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
        });
      }
    }
    return null;
  }

  if (observation.kind === "confirmed") {
    return observation.entry;
  }
  if (observation.kind === "gone") {
    throw new HttpError(
      502,
      `activity log 寫入後驗證：entry ${entryId} 讀不回來`,
      "RAGIC_WRITE_GONE"
    );
  }

  const mismatchMessages = observation.mismatches.map(formatMismatch);
  let rollbackDeleted = false;
  try {
    await ragicClient.deleteEntry(activityLogPath, entryId);
    const afterDelete = await inspectActivityLogEntryStored(activityLogPath, entryId, expected, options);
    rollbackDeleted = afterDelete.kind === "gone";
    log.warn({
      event: rollbackDeleted ? "rollback-confirmed" : "rollback-unconfirmed",
      createOperationId,
      entryId,
      mismatches: mismatchMessages,
    });
  } catch (deleteError) {
    log.error({
      event: "rollback-delete-failed",
      createOperationId,
      entryId,
      mismatches: mismatchMessages,
      error: deleteError instanceof Error ? deleteError.message : String(deleteError),
    });
  }

  if (!rollbackDeleted && options.onReadIndeterminate) {
    try {
      await options.onReadIndeterminate({
        activityLogPath, entryId, expected, rollbackPending: true,
        readPriority: options.readPriority ?? "background",
        errorMessage: "RAGIC_WRITE_ROLLBACK_UNCONFIRMED",
        occurredAt: new Date().toISOString(),
      });
    } catch (error) {
      log.error({ event: "rollback-reverify-enqueue-failed", entryId,
        error: error instanceof Error ? error.message : String(error) });
    }
  }

  throw new HttpError(
    502,
    rollbackDeleted
      ? `activity log 寫入後驗證失敗（已回滾刪除 entry ${entryId}）：${mismatchMessages.join("; ")}`
      : `activity log 寫入後驗證失敗（entry ${entryId} 回滾刪除未確認）：${mismatchMessages.join("; ")}`,
    rollbackDeleted ? "RAGIC_WRITE_ROLLBACK_CONFIRMED" : "RAGIC_WRITE_ROLLBACK_UNCONFIRMED"
  );
}
