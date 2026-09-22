import {
  env,
  resolveWorkReportDataPath,
  shouldUseSqliteReadForForm,
} from "../../../config/env";
import { getFormConfig } from "../../../config/forms";
import { isRetryableReadError } from "../../../infra/ragicReadRetry";
import type { RagicReadPriority } from "../../../infra/ragicRequestScheduler";
import { createLogger } from "../../../observability/logger";
import { ragicClient, type RagicRecord } from "../../../ragic/client";
import { workReportSqliteRepository } from "../../../storage/sqlite/workReportSqliteRepository";
import type { WorkReportRecord } from "../../../types/workReport";
import { HttpError } from "../../../utils/httpError";
import { workReportEditingPresenceService } from "../../workReportEditingPresenceService";
import { hasReadableSqliteSnapshot } from "../readModelState";
import { isWorkOrderClosedEntry } from "../shared/workOrderStatus";
import { workReportReadService } from "../workReportReadService";

const ENTRY_CONFLICT_IGNORED_KEYS = new Set(["lastUpdatedAt", "filterLastUpdatedAt", "snapshotHash"]);
const log = createLogger("work-report-mutation-precondition");

export interface EntryConflictPreconditionOptions {
  priority?: RagicReadPriority;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface EntryEditingPreconditionInput {
  formId: string;
  entryId: string;
  rowId?: string;
  editSessionId?: string;
}

export interface EntryLockVersionPreconditionInput extends EntryEditingPreconditionInput {
  editLockVersion?: number;
}

function resolveRecordLastUpdatedAt(record: WorkReportRecord | null | undefined): string {
  return String(
    (record as Record<string, unknown> | null | undefined)?.lastUpdatedAt ?? ""
  ).trim();
}

function normalizeEntryConflictComparableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeEntryConflictComparableValue(item));
  }
  if (!value || typeof value !== "object") {
    return value ?? null;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, nextValue]) => {
        if (ENTRY_CONFLICT_IGNORED_KEYS.has(key) || key.endsWith("Display")) {
          return false;
        }
        return nextValue !== undefined;
      })
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nextValue]) => [
        key,
        normalizeEntryConflictComparableValue(nextValue),
      ])
  );
}

function buildEntryConflictFingerprint(record: WorkReportRecord): string {
  return JSON.stringify(normalizeEntryConflictComparableValue(record));
}

function isRagicStaleCheckUnavailable(error: unknown): boolean {
  const candidate = error as { message?: unknown };
  return (
    isRetryableReadError(error) ||
    (typeof candidate.message === "string" &&
      /(?:timeout of \d+ms exceeded|ECONNABORTED)/i.test(candidate.message))
  );
}

class WorkReportMutationPreconditionService {
  async assertEntryNotModified(
    formId: string,
    entryId: string,
    expectedEntryLastUpdatedAt?: string,
    options: EntryConflictPreconditionOptions = {}
  ): Promise<void> {
    const expected = String(expectedEntryLastUpdatedAt ?? "").trim();
    if (!expected) {
      return;
    }

    const latestRecord = await this.readLatestEntryForConflictCheck(
      formId,
      entryId,
      options
    );
    await this.assertLatestEntryMatchesExpected(
      formId,
      entryId,
      expected,
      latestRecord
    );
  }

  assertEntryEditableBySession(input: EntryEditingPreconditionInput): void {
    const snapshot = workReportEditingPresenceService.assertOwnerOrAvailable({
      formId: input.formId,
      entryId: input.entryId,
      rowId: input.rowId,
      sessionId: input.editSessionId,
    });
    if (snapshot.canEdit) {
      return;
    }

    throw new HttpError(
      409,
      "這筆工令目前由其他人編輯中，請稍後再試。",
      "ENTRY_EDIT_LOCKED"
    );
  }

  assertEntryLockVersion(input: EntryLockVersionPreconditionInput): void {
    try {
      workReportEditingPresenceService.assertLockVersion({
        formId: input.formId,
        entryId: input.entryId,
        rowId: input.rowId,
        sessionId: input.editSessionId,
        expectedLockVersion: input.editLockVersion,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "LOCK_VERSION_MISMATCH") {
        throw new HttpError(
          409,
          "你已失去這筆工令的編輯權，請重新整理或稍後再試。",
          "ENTRY_EDIT_LOCKED"
        );
      }
      throw error;
    }
  }

  async assertCreateEntryAcceptsReports(
    formId: string,
    entryId: string
  ): Promise<RagicRecord> {
    const config = getFormConfig(formId);
    const readPath = resolveWorkReportDataPath(formId, config.ragicPath);
    let entry: RagicRecord | null;
    try {
      entry = await ragicClient.getEntry(readPath, entryId, false, {
        priority: "mutation",
        timeoutMs: env.RAGIC_MUTATION_READ_TIMEOUT_MS,
        maxRetries: env.RAGIC_MUTATION_READ_MAX_RETRIES,
      });
      if (!entry) {
        throw new Error(`找不到工令：${entryId}`);
      }
    } catch (error) {
      log.warn({
        event: "create.entry-status-precheck-failed",
        formId,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(
        409,
        "暫時無法從 Ragic 取得最新工令狀態，這筆報工尚未寫入；請稍後重送。",
        "ENTRY_STATUS_UNKNOWN"
      );
    }

    if (!isWorkOrderClosedEntry(entry, config)) {
      return entry;
    }

    throw new HttpError(
      409,
      "這筆工令已結案，不能新增報工；請刷新工令後確認狀態。",
      "ENTRY_CLOSED"
    );
  }

  async assertBatchCreateEntryAcceptsReports(
    formId: string,
    entryId: string
  ): Promise<RagicRecord> {
    return this.assertCreateEntryAcceptsReports(formId, entryId);
  }

  private async readLatestEntryForConflictCheck(
    formId: string,
    entryId: string,
    options: EntryConflictPreconditionOptions
  ): Promise<WorkReportRecord> {
    try {
      return await workReportReadService.getReportByEntryId(formId, entryId, {
        refresh: true,
        priority: options.priority ?? "mutation",
        ragicReadTimeoutMs: options.timeoutMs ?? env.RAGIC_MUTATION_READ_TIMEOUT_MS,
        ragicReadMaxRetries: options.maxRetries ?? env.RAGIC_MUTATION_READ_MAX_RETRIES,
      });
    } catch (error) {
      if (isRagicStaleCheckUnavailable(error)) {
        throw new HttpError(
          504,
          "確認工令最新狀態逾時，尚未執行寫入，請重新整理後重試。",
          "RAGIC_STALE_CHECK_UNAVAILABLE"
        );
      }
      throw error;
    }
  }

  private async assertLatestEntryMatchesExpected(
    formId: string,
    entryId: string,
    expected: string,
    latestRecord: WorkReportRecord
  ): Promise<void> {
    const latestUpdatedAt = resolveRecordLastUpdatedAt(latestRecord);
    if (latestUpdatedAt === expected) {
      return;
    }

    const expectedSnapshot = await this.getExpectedEntrySnapshotFromReadModel(
      formId,
      entryId,
      expected
    );
    if (
      expectedSnapshot &&
      buildEntryConflictFingerprint(expectedSnapshot) ===
        buildEntryConflictFingerprint(latestRecord)
    ) {
      log.info({
        event: "mutation.timestamp-drift-allowed",
        formId,
        entryId,
        expectedLastUpdatedAt: expected,
        latestLastUpdatedAt: latestUpdatedAt,
      });
      return;
    }

    throw new HttpError(
      409,
      "這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。",
      "ENTRY_CONFLICT"
    );
  }

  private async getExpectedEntrySnapshotFromReadModel(
    formId: string,
    entryId: string,
    expectedLastUpdatedAt: string
  ): Promise<WorkReportRecord | null> {
    if (!shouldUseSqliteReadForForm(formId)) {
      return null;
    }

    try {
      const syncState = await workReportSqliteRepository.getSyncState(formId);
      if (!hasReadableSqliteSnapshot(syncState)) {
        return null;
      }

      const snapshotRecord = await workReportSqliteRepository.getReportByEntryId(
        formId,
        entryId
      );
      if (
        !snapshotRecord ||
        resolveRecordLastUpdatedAt(snapshotRecord) !== expectedLastUpdatedAt
      ) {
        return null;
      }
      return snapshotRecord;
    } catch (error) {
      log.warn({
        event: "mutation.entry-snapshot-read-failed",
        formId,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export const workReportMutationPreconditionService =
  new WorkReportMutationPreconditionService();
