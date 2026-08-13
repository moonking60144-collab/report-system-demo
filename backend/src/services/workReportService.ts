import { env, resolveWritePath, shouldUseSqliteReadForForm } from "../config/env";
import { getFormConfig } from "../config/forms";
import { ragicClient, type RagicRecord } from "../ragic/client";
import type { ReportWritePayload, WorkReportRecord } from "../types/workReport";
import { HttpError, UpstreamError } from "../utils/httpError";
import { workReportSqliteRepository } from "../storage/sqlite/workReportSqliteRepository";
import { reportFullSnapshotService } from "./reportFullSnapshotService";
import { hasReadableSqliteSnapshot } from "./work-report/readModelState";
import {
  throwRagicHttpError,
  writeToRagic,
} from "./work-report/shared/workReportWriteHelpers";
import {
  getRawEntry,
  getExistingSubtableRow,
} from "./work-report/shared/workReportReadHelpers";
import {
  buildSubtableRowData,
  findLikelyCreatedRow,
} from "./work-report/shared/workReportPayloadHelpers";
import {
  logCreateOperatorDiagnostics,
  buildOperatorDebugSnapshot,
  logOperatorDebugSnapshot,
  logCreatePerformanceIfSlow,
} from "./work-report/shared/workReportDiagnostics";
import {
  buildCreateRecalculateFlowDeps,
  triggerForm16RowRecalculateFlow,
  triggerUpdateRecalculateFlow,
} from "./work-report/recalculate/workReportRecalculate";
import { runCreateReportFlow } from "./work-report/mutation/runCreateReportFlow";
import type { CreateReportFlowOptions } from "./work-report/mutation/runCreateReportFlow";
import { checkOrCreateForm16Entry } from "./form16/form16IdempotencyService";
import { normalizePayloadForWrite } from "./work-report/mutation/normalizePayloadForWrite";
import { validateReportPayload } from "./work-report/mutation/validateReportPayload";
import { resolveForm16RequiredFields } from "./work-report/create/resolveForm16RequiredFields";
import { workReportReadService } from "./work-report/workReportReadService";
import { workReportEditingPresenceService } from "./workReportEditingPresenceService";
import type { RagicReadPriority } from "../infra/ragicRequestScheduler";
import { isRetryableReadError } from "../infra/ragicReadRetry";
import { resolveCandidateFieldKeys } from "./work-report/queries/rowTransform";
import { getFirstFieldValue } from "./work-report/shared/subtableUtils";

const ENTRY_CONFLICT_IGNORED_KEYS = new Set(["lastUpdatedAt", "filterLastUpdatedAt"]);
const CLOSED_WORK_ORDER_STATUS = "已結案";

function parseStoredSortOrder(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

interface EntryConflictPreconditionOptions {
  priority?: RagicReadPriority;
  timeoutMs?: number;
  maxRetries?: number;
}

export async function reconcileHardDeleteWriteFailure(
  writeError: unknown,
  verifyRowStillExists: () => Promise<void>
): Promise<void> {
  try {
    await verifyRowStillExists();
  } catch (verifyError) {
    if (
      verifyError instanceof HttpError &&
      verifyError.code === "REPORT_NOT_FOUND"
    ) {
      return;
    }
    throw new UpstreamError(
      "Ragic 刪除回應未確認，且無法讀回明細判定最終結果；請先重新整理再決定是否重送。",
      "RAGIC_DELETE_INDETERMINATE",
      {
        writeError: writeError instanceof Error ? writeError.message : String(writeError),
        verifyError: verifyError instanceof Error ? verifyError.message : String(verifyError),
      }
    );
  }

  throw writeError;
}

function resolveRecordLastUpdatedAt(record: WorkReportRecord | null | undefined): string {
  return String((record as Record<string, unknown> | null | undefined)?.lastUpdatedAt ?? "").trim();
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
        if (ENTRY_CONFLICT_IGNORED_KEYS.has(key)) {
          return false;
        }
        if (key.endsWith("Display")) {
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
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    isRetryableReadError(error) ||
    (typeof candidate.message === "string" &&
      /(?:timeout of \d+ms exceeded|ECONNABORTED)/i.test(candidate.message))
  );
}

class WorkReportService {
  async createReport(
    formId: string,
    entryId: string,
    payload: ReportWritePayload,
    options: CreateReportFlowOptions = {}
  ): Promise<{ rowId: string }> {
    const durableCreateKey = options.createIdempotencyKey ?? options.clientMutationId;
    // Idempotency：task attempt ID 與跨 retry 的 create key 分離；舊 caller fallback 到 clientMutationId。
    // 同 key 命中既有映射就直接回舊 rowId、跳過 runCreateReportFlow（不再打 Ragic write /
    // polling / action button），擋 backend restart 或 worker crash 後 retry 產生的重複 entry。
    const idempotencyResult = await checkOrCreateForm16Entry({
      clientRowKey: durableCreateKey,
      source: `work-report-${formId}`,
      operationFingerprint: options.clientMutationFingerprint,
      create: async (reservation) => {
        const flowResult = await runCreateReportFlow({
          formId,
          entryId,
          payload,
          options: {
            ...options,
            ...(reservation?.reservationToken
              ? { idempotencyReservationToken: reservation.reservationToken }
              : {}),
          },
          deps: {
            assertEntryNotModified: this.assertEntryNotModified.bind(this),
            validateReportPayload,
            normalizePayloadForWrite,
            getRawEntry,
            getFormOptions: workReportReadService.getFormOptions.bind(workReportReadService),
            buildSubtableRowData,
            resolveForm16RequiredFields,
            logCreateOperatorDiagnostics,
            buildOperatorDebugSnapshot,
            logOperatorDebugSnapshot,
            findLikelyCreatedRow,
            buildCreateRecalculateFlowDeps,
            logCreatePerformanceIfSlow,
            markReportFullCacheDirty: this.markReportFullCacheDirty.bind(this),
            throwRagicHttpError,
          },
        });
        return { entryId: flowResult.rowId };
      },
    });

    if (!idempotencyResult.entryId) {
      // runCreateReportFlow 成功必回 rowId，失敗 throw，所以不該走到這
      throw new HttpError(500, "建立工令報工後沒拿到 rowId", "RAGIC_WRITE_FAILED");
    }

    if (idempotencyResult.reused) {
      console.info("[work-report-create][idempotency-hit]", {
        formId,
        entryId,
        clientMutationId: options.clientMutationId,
        createIdempotencyKey: durableCreateKey,
        rowId: idempotencyResult.entryId,
      });
    }

    return { rowId: idempotencyResult.entryId };
  }

  async updateReport(
    formId: string,
    entryId: string,
    rowId: string,
    payload: ReportWritePayload,
    options: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
    } = {}
  ): Promise<{ rowId: string }> {
    const config = getFormConfig(formId);
    await this.assertEntryNotModified(formId, entryId, options.expectedEntryLastUpdatedAt);
    const normalizedRowId = rowId.trim();
    if (!/^\d+$/.test(normalizedRowId)) {
      throw new HttpError(400, `非法的子表列識別碼：${rowId}`, "INVALID_ROW_ID");
    }
    validateReportPayload(payload, config.writeConfig.requiredFields);
    const normalizedPayload = await normalizePayloadForWrite(formId, config, payload);
    // NOTE: Ragic 讀取到的子表 row key 可能是「欄位名稱」。
    // 更新時只送出「欄位 ID」可避免 illegal subtable row key 錯誤。
    await getExistingSubtableRow(config, entryId, normalizedRowId);
    const subtableRowData = buildSubtableRowData(normalizedPayload, config);

    const writeBody = {
      [config.writeConfig.subtableId]: {
        [normalizedRowId]: subtableRowData,
      },
    };

    await writeToRagic(formId, config, entryId, writeBody);
    try {
      await triggerUpdateRecalculateFlow(entryId, normalizedRowId);
    } catch (error) {
      throw new UpstreamError(
        `報工內容已寫入 Ragic，但後續回算尚未完成：${
          error instanceof Error ? error.message : String(error)
        }`,
        "RAGIC_RECALCULATE_INCOMPLETE",
        {
          formId,
          entryId,
          rowId: normalizedRowId,
          causeCode:
            typeof (error as { code?: unknown })?.code === "string"
              ? String((error as { code?: unknown }).code)
              : undefined,
        }
      );
    }
    this.markReportFullCacheDirty(formId);
    return { rowId: normalizedRowId };
  }

  async hardDeleteReport(
    formId: string,
    entryId: string,
    rowId: string,
    options: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
      skipDeleteRecalculate?: boolean;
    } = {}
  ): Promise<{ rowId: string }> {
    const config = getFormConfig(formId);
    await this.assertEntryNotModified(formId, entryId, options.expectedEntryLastUpdatedAt);
    const normalizedRowId = rowId.trim();
    if (!/^\d+$/.test(normalizedRowId)) {
      throw new HttpError(400, `非法的子表列識別碼：${rowId}`, "INVALID_ROW_ID");
    }
    await getExistingSubtableRow(config, entryId, normalizedRowId);

    const normalizedSubtableId = config.writeConfig.subtableId.replace(/^_subtable_/, "");
    const deleteKey = `_DELSUB_${normalizedSubtableId}`;
    const parsedRowId = Number(normalizedRowId);
    const deleteList = Number.isFinite(parsedRowId) ? [parsedRowId] : [normalizedRowId];
    try {
      await writeToRagic(
        formId,
        config,
        entryId,
        { [deleteKey]: deleteList },
        !options.skipDeleteRecalculate,
        "PATCH",
        options.skipDeleteRecalculate
          ? undefined
          : {
              doFormula: true,
              doLinkLoad: "all",
            }
      );
    } catch (error) {
      await reconcileHardDeleteWriteFailure(error, async () => {
        await getExistingSubtableRow(config, entryId, normalizedRowId);
      });
    }

    this.markReportFullCacheDirty(formId);
    return { rowId: normalizedRowId };
  }

  async finalizeBatchDelete(
    formId: string,
    entryId: string,
    rowIds: string[]
  ): Promise<void> {
    const config = getFormConfig(formId);
    const normalizedRowIds = Array.from(
      new Set(
        rowIds
          .map((rowId) => String(rowId ?? "").trim())
          .filter((rowId) => /^\d+$/.test(rowId))
      )
    );
    if (normalizedRowIds.length === 0) {
      return;
    }

    // NOTE: 批次刪除時，每列的 hardDeleteReport 都帶 skipDeleteRecalculate=true，
    // 所以最後用一次空寫入帶 doFormula / doLinkLoad / doWorkflow 補回主表公式與 link 的回算。
    await writeToRagic(
      formId,
      config,
      entryId,
      {},
      true,
      "PATCH",
      {
        doFormula: true,
        doLinkLoad: "all",
      }
    );
    this.markReportFullCacheDirty(formId);
  }

  async finalizeBatchCreate(
    formId: string,
    entryId: string,
    rowIds: string[]
  ): Promise<void> {
    const normalizedRowIds = Array.from(
      new Set(
        rowIds
          .map((rowId) => String(rowId ?? "").trim())
          .filter((rowId) => /^\d+$/.test(rowId))
      )
    );
    if (normalizedRowIds.length === 0) {
      return;
    }
    try {
      await triggerForm16RowRecalculateFlow(entryId, normalizedRowIds);
    } catch (error) {
      if (error instanceof HttpError) {
        throw new HttpError(
          error.statusCode,
          `批次新增列收尾失敗：${error.message}`,
          "BATCH_CREATE_ROW_FINALIZE_FAILED"
        );
      }
      throw error;
    }
    this.markReportFullCacheDirty(formId);
  }

  async updateMainMachine(
    formId: string,
    entryId: string,
    machineCode: string,
    options: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
    } = {}
  ): Promise<{ machineCode: string }> {
    const config = getFormConfig(formId);
    await this.assertEntryNotModified(formId, entryId, options.expectedEntryLastUpdatedAt);
    const machineFieldId = config.writeConfig.mainWriteFields?.machineCode?.trim() ?? "";
    if (!machineFieldId) {
      throw new HttpError(503, "主表機台欄位尚未設定", "FORM_NOT_CONFIGURED");
    }

    const normalizedMachineCode = machineCode.trim();
    if (!normalizedMachineCode) {
      throw new HttpError(400, "缺少必要欄位：machineCode", "INVALID_PAYLOAD");
    }

    await writeToRagic(
      formId,
      config,
      entryId,
      {
        [machineFieldId]: normalizedMachineCode,
      },
      true,
      "PATCH",
      {
        doFormula: true,
        doLinkLoad: "all",
      }
    );

    this.markReportFullCacheDirty(formId);
    return { machineCode: normalizedMachineCode };
  }

  async updateSortOrder(
    formId: string,
    entryId: string,
    sortOrder: number,
    options: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
    } = {}
  ): Promise<{
    sortOrder: number;
    previousSortOrder: number | null;
    changed: boolean;
  }> {
    const totalStartedAt = Date.now();
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      throw new HttpError(
        400,
        "sortOrder 必須是大於或等於 0 的整數",
        "INVALID_PAYLOAD"
      );
    }

    const config = getFormConfig(formId);
    const sortOrderFieldId = config.writeConfig.mainWriteFields?.sortOrder?.trim() ?? "";
    if (!sortOrderFieldId) {
      throw new HttpError(503, "主表排序欄位尚未設定", "FORM_NOT_CONFIGURED");
    }

    const writePath = resolveWritePath(formId, config.ragicPath);
    if (!writePath) {
      throw new HttpError(
        503,
        "寫入路徑未設定（請確認 RAGIC_WRITE_TARGET 與 TEST_PATH）",
        "FORM_NOT_CONFIGURED"
      );
    }

    const fieldCandidates = Array.from(
      new Set([
        sortOrderFieldId,
        ...resolveCandidateFieldKeys(
          config.mainFields.sortOrder ?? "",
          config.mainFieldFallbacks?.sortOrder
        ),
      ])
    ).filter(Boolean);
    const lastUpdatedAtFieldCandidates = resolveCandidateFieldKeys(
      config.mainFields.lastUpdatedAt ?? "",
      config.mainFieldFallbacks?.lastUpdatedAt
    );
    const expectedLastUpdatedAt = String(
      options.expectedEntryLastUpdatedAt ?? ""
    ).trim();
    const currentReadStartedAt = Date.now();
    const currentEntry = await ragicClient.getEntry(writePath, entryId, false, {
      priority: "mutation",
    });
    if (!currentEntry) {
      throw new HttpError(404, `找不到工令：${entryId}`, "REPORT_NOT_FOUND");
    }
    const previousSortOrder = parseStoredSortOrder(
      getFirstFieldValue(currentEntry, fieldCandidates)
    );
    const currentLastUpdatedAt = String(
      getFirstFieldValue(currentEntry, lastUpdatedAtFieldCandidates) ?? ""
    ).trim();
    if (
      expectedLastUpdatedAt &&
      currentLastUpdatedAt !== expectedLastUpdatedAt
    ) {
      console.info("[work-report-sort-order][entry-timestamp-drift-ignored]", {
        formId,
        entryId,
        expectedEntryLastUpdatedAt: expectedLastUpdatedAt,
        currentEntryLastUpdatedAt: currentLastUpdatedAt,
        reason: "sort-order-is-field-level-and-entry-queue-is-serial",
      });
    }
    const currentReadMs = Date.now() - currentReadStartedAt;
    if (previousSortOrder === sortOrder) {
      console.info("[work-report-sort-order][timing]", {
        formId,
        entryId,
        changed: false,
        currentReadMs,
        writeMs: 0,
        verifyMs: 0,
        totalMs: Date.now() - totalStartedAt,
      });
      return {
        sortOrder,
        previousSortOrder,
        changed: false,
      };
    }

    const writeStartedAt = Date.now();
    await writeToRagic(
      formId,
      config,
      entryId,
      { [sortOrderFieldId]: sortOrder },
      false,
      "PATCH",
      {
        doFormula: false,
      }
    );
    const writeMs = Date.now() - writeStartedAt;
    this.markReportFullCacheDirty(formId);

    const verifyStartedAt = Date.now();
    const confirmedEntry = await ragicClient.getEntry(writePath, entryId, false, {
      priority: "mutation",
    });
    if (!confirmedEntry) {
      throw new UpstreamError(
        "Ragic 已回應排序碼更新，但無法回讀工令；請重新整理確認。",
        "RAGIC_WRITE_VERIFY_FAILED",
        { formId, entryId, expectedSortOrder: sortOrder }
      );
    }
    const confirmedSortOrder = parseStoredSortOrder(
      getFirstFieldValue(confirmedEntry, fieldCandidates)
    );
    if (confirmedSortOrder !== sortOrder) {
      throw new UpstreamError(
        "Ragic 已回應排序碼更新，但回讀值不一致；請重新整理確認。",
        "RAGIC_WRITE_VERIFY_FAILED",
        {
          formId,
          entryId,
          expectedSortOrder: sortOrder,
          confirmedSortOrder,
        }
      );
    }
    const verifyMs = Date.now() - verifyStartedAt;
    console.info("[work-report-sort-order][timing]", {
      formId,
      entryId,
      changed: true,
      currentReadMs,
      writeMs,
      verifyMs,
      totalMs: Date.now() - totalStartedAt,
    });

    return {
      sortOrder,
      previousSortOrder,
      changed: true,
    };
  }

  async manualCloseWorkOrder(
    formId: string,
    entryId: string,
    action: "close" | "reopen",
    _options: {
      expectedEntryLastUpdatedAt?: string;
      editSessionId?: string;
      editLockVersion?: number;
    } = {}
  ): Promise<{ action: "close" | "reopen" }> {
    // 不在此處重複 assertEntryNotModified：route 層 assertFullMutationPreconditions 已做過一次 Ragic GET，
    // 這裡再做一次純粹浪費延遲。options 保留給未來若有其他呼叫端需要再開啟。
    const config = getFormConfig(formId);

    const buttonId = (
      action === "close"
        ? formId === "104"
          ? env.RAGIC_FORM_104_CLOSE_ACTION_BUTTON_ID
          : env.RAGIC_FORM_105_CLOSE_ACTION_BUTTON_ID
        : formId === "104"
          ? env.RAGIC_FORM_104_REOPEN_ACTION_BUTTON_ID
          : env.RAGIC_FORM_105_REOPEN_ACTION_BUTTON_ID
    ).trim();

    if (!buttonId) {
      throw new HttpError(503, `${action} 按鈕 ID 尚未設定`, "FORM_NOT_CONFIGURED");
    }

    const writePath = resolveWritePath(formId, config.ragicPath);
    if (!writePath) {
      throw new HttpError(503, "寫入路徑未設定（請確認 RAGIC_WRITE_TARGET 與 TEST_PATH）", "FORM_NOT_CONFIGURED");
    }

    const result = await ragicClient.executeActionButton(writePath, entryId, buttonId);
    ragicClient.clearFormCache(config.ragicPath);

    console.info("[manual-close-work-order]", {
      formId,
      entryId,
      action,
      buttonId,
      status: result.status,
      msg: result.msg,
    });

    if (result.status !== "SUCCESS" && result.status !== "WARN") {
      throw new HttpError(
        502,
        result.msg || `人工${action === "close" ? "結案" : "取消結案"}失敗`,
        "RAGIC_ACTION_BUTTON_FAILED"
      );
    }

    this.markReportFullCacheDirty(formId);
    return { action };
  }

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

  private async readLatestEntryForConflictCheck(
    formId: string,
    entryId: string,
    options: EntryConflictPreconditionOptions = {}
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
      buildEntryConflictFingerprint(expectedSnapshot) === buildEntryConflictFingerprint(latestRecord)
    ) {
      console.info("[work-report-mutation][timestamp-drift-allowed]", {
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

  async assertEntryEditableBySession(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    editSessionId?: string;
  }): Promise<void> {
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

  async assertEntryLockVersion(input: {
    formId: string;
    entryId: string;
    rowId?: string;
    editSessionId?: string;
    editLockVersion?: number;
  }): Promise<void> {
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
    let entry: RagicRecord | null;
    try {
      entry = await ragicClient.getEntry(config.ragicPath, entryId, false, {
        priority: "mutation",
        timeoutMs: env.RAGIC_MUTATION_READ_TIMEOUT_MS,
        maxRetries: env.RAGIC_MUTATION_READ_MAX_RETRIES,
      });
      if (!entry) {
        throw new Error(`找不到工令：${entryId}`);
      }
    } catch (error) {
      console.warn("[work-report-create][entry-status-precheck-failed]", {
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

    const status = String(
      getFirstFieldValue(
        entry,
        resolveCandidateFieldKeys(
          config.mainFields.status ?? "",
          config.mainFieldFallbacks?.status
        )
      ) ?? ""
    ).trim();
    if (status !== CLOSED_WORK_ORDER_STATUS) {
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

      const snapshotRecord = await workReportSqliteRepository.getReportByEntryId(formId, entryId);
      if (!snapshotRecord || resolveRecordLastUpdatedAt(snapshotRecord) !== expectedLastUpdatedAt) {
        return null;
      }
      return snapshotRecord;
    } catch (error) {
      console.warn("[work-report-mutation][entry-snapshot-read-failed]", {
        formId,
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private markReportFullCacheDirty(formId: string): void {
    if (!env.REPORT_FULL_CACHE_ENABLED) {
      return;
    }
    if (shouldUseSqliteReadForForm(formId)) {
      console.info("[full-cache-rebuild-skipped]", {
        formId,
        reason: "sqlite-primary-read-model",
      });
      return;
    }
    reportFullSnapshotService.markDirty(formId);
    const triggered = reportFullSnapshotService.triggerRebuildInBackground(
      formId,
      async () => workReportReadService.buildFullReportRecords(formId),
      "mutation"
    );
    if (triggered) {
      console.info("[full-cache-rebuild-triggered]", { formId, source: "mutation" });
    }
  }

}

export const workReportService = new WorkReportService();
