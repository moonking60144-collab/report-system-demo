import { env, resolveWritePath, shouldUseSqliteReadForForm } from "../config/env";
import { getFormConfig } from "../config/forms";
import { ragicClient } from "../ragic/client";
import { ReportWritePayload } from "../types/workReport";
import { HttpError } from "../utils/httpError";
import { reportFullSnapshotService } from "./reportFullSnapshotService";
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

class WorkReportService {
  async createReport(
    formId: string,
    entryId: string,
    payload: ReportWritePayload,
    options: CreateReportFlowOptions = {}
  ): Promise<{ rowId: string }> {
    // Idempotency：reuse clientMutationId 當 Form 16 寫入的 key。
    // 同 key 命中既有映射就直接回舊 rowId、跳過 runCreateReportFlow（不再打 Ragic write /
    // polling / action button），擋 backend restart 或 worker crash 後 retry 產生的重複 entry。
    const idempotencyResult = await checkOrCreateForm16Entry({
      clientRowKey: options.clientMutationId,
      source: `work-report-${formId}`,
      create: async () => {
        const flowResult = await runCreateReportFlow({
          formId,
          entryId,
          payload,
          options,
          deps: {
            assertEntryNotModified: this.assertEntryNotModified.bind(this),
            validateReportPayload,
            normalizePayloadForWrite,
            getRawEntry,
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
    await triggerUpdateRecalculateFlow(entryId, normalizedRowId);
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
    const deleteKeyCandidates = [
      `_DELSUB_${normalizedSubtableId}`,
      `_DELSUB_${config.writeConfig.subtableId}`,
    ];
    const parsedRowId = Number(normalizedRowId);
    const deleteList = Number.isFinite(parsedRowId) ? [parsedRowId] : [normalizedRowId];
    let deleted = false;
    let lastError: unknown;

    for (const deleteKey of deleteKeyCandidates) {
      try {
        const writeBody = {
          [deleteKey]: deleteList,
        };
        await writeToRagic(
          formId,
          config,
          entryId,
          writeBody,
          !options.skipDeleteRecalculate,
          "PATCH",
          options.skipDeleteRecalculate
            ? undefined
            : {
                doFormula: true,
                doLinkLoad: "all",
              }
        );
        deleted = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!deleted && lastError) {
      throw lastError;
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
    expectedEntryLastUpdatedAt?: string
  ): Promise<void> {
    const expected = String(expectedEntryLastUpdatedAt ?? "").trim();
    if (!expected) {
      return;
    }

    const latestRecord = await workReportReadService.getReportByEntryId(formId, entryId, {
      refresh: true,
    });
    const latestUpdatedAt = String((latestRecord as Record<string, unknown>)?.lastUpdatedAt ?? "").trim();
    if (latestUpdatedAt === expected) {
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
