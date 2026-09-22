import { assertRowSnapshotUnchanged, parseExpectedRowSnapshotHash } from "../shared/rowMutationPrecondition";
import { getFormConfig } from "../../../config/forms";
import type { ReportWritePayload } from "../../../types/workReport";
import { HttpError, UpstreamError } from "../../../utils/httpError";
import { triggerUpdateRecalculateFlow } from "../recalculate/workReportRecalculate";
import { buildSubtableRowData } from "../shared/workReportPayloadHelpers";
import { getExistingSubtableRow } from "../shared/workReportReadHelpers";
import { writeToRagic } from "../shared/workReportWriteHelpers";
import { normalizePayloadForWrite } from "./normalizePayloadForWrite";
import { validateReportPayload } from "./validateReportPayload";
import { workReportMutationCacheService } from "./workReportMutationCacheService";
import { workReportMutationPreconditionService } from "./workReportMutationPreconditionService";

export interface WorkReportRowMutationOptions {
  expectedRowSnapshotHash?: string;
  expectedEntryLastUpdatedAt?: string;
  editSessionId?: string;
  editLockVersion?: number;
}

export interface WorkReportDeleteOptions extends WorkReportRowMutationOptions {
  skipDeleteRecalculate?: boolean;
}

export interface WorkReportRowMutationResult {
  rowId: string;
  beforeSnapshot: Record<string, unknown>;
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

class WorkReportRowMutationService {
  async updateReport(
    formId: string,
    entryId: string,
    rowId: string,
    payload: ReportWritePayload,
    options: WorkReportRowMutationOptions = {}
  ): Promise<WorkReportRowMutationResult> {
    const config = getFormConfig(formId);
    const expectedRowSnapshotHash = parseExpectedRowSnapshotHash(options.expectedRowSnapshotHash);
    if (expectedRowSnapshotHash === undefined) {
      await workReportMutationPreconditionService.assertEntryNotModified(
        formId, entryId, options.expectedEntryLastUpdatedAt
      );
    }
    const normalizedRowId = rowId.trim();
    if (!/^\d+$/.test(normalizedRowId)) {
      throw new HttpError(400, `非法的子表列識別碼：${rowId}`, "INVALID_ROW_ID");
    }
    validateReportPayload(payload, config.writeConfig.requiredFields);
    const normalizedPayload = await normalizePayloadForWrite(formId, config, payload);
    const beforeSnapshot = await getExistingSubtableRow(config, entryId, normalizedRowId, { requireOpen: expectedRowSnapshotHash !== undefined });
    if (expectedRowSnapshotHash !== undefined) {
      assertRowSnapshotUnchanged(config, normalizedRowId, beforeSnapshot, expectedRowSnapshotHash);
    }
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
    workReportMutationCacheService.markReportFullCacheDirty(formId);
    return { rowId: normalizedRowId, beforeSnapshot };
  }

  async hardDeleteReport(
    formId: string,
    entryId: string,
    rowId: string,
    options: WorkReportDeleteOptions = {}
  ): Promise<WorkReportRowMutationResult> {
    const config = getFormConfig(formId);
    const expectedRowSnapshotHash = parseExpectedRowSnapshotHash(options.expectedRowSnapshotHash);
    if (expectedRowSnapshotHash === undefined) {
      await workReportMutationPreconditionService.assertEntryNotModified(
        formId, entryId, options.expectedEntryLastUpdatedAt
      );
    }
    const normalizedRowId = rowId.trim();
    if (!/^\d+$/.test(normalizedRowId)) {
      throw new HttpError(400, `非法的子表列識別碼：${rowId}`, "INVALID_ROW_ID");
    }
    const beforeSnapshot = await getExistingSubtableRow(config, entryId, normalizedRowId, { requireOpen: expectedRowSnapshotHash !== undefined });
    if (expectedRowSnapshotHash !== undefined) {
      assertRowSnapshotUnchanged(config, normalizedRowId, beforeSnapshot, expectedRowSnapshotHash);
    }

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

    workReportMutationCacheService.markReportFullCacheDirty(formId);
    return { rowId: normalizedRowId, beforeSnapshot };
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
    workReportMutationCacheService.markReportFullCacheDirty(formId);
  }
}

export const workReportRowMutationService = new WorkReportRowMutationService();
