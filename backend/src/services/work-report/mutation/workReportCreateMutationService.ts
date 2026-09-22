import { createLogger } from "../../../observability/logger";
import type { ReportWritePayload } from "../../../types/workReport";
import { HttpError } from "../../../utils/httpError";
import { checkOrCreateActivityLogEntry } from "../../activityLog/activityLogIdempotencyService";
import { triggerActivityLogRowRecalculateFlow } from "../recalculate/workReportRecalculate";
import { createReportFlowDeps } from "./createReportFlowDeps";
import {
  runCreateReportFlow,
  type CreateReportFlowOptions,
} from "./runCreateReportFlow";
import { workReportMutationCacheService } from "./workReportMutationCacheService";
const log = createLogger("work-report-create-mutation");

class WorkReportCreateMutationService {
  async createReport(
    formId: string,
    entryId: string,
    payload: ReportWritePayload,
    options: CreateReportFlowOptions = {}
  ): Promise<{ rowId: string }> {
    const durableCreateKey = options.createIdempotencyKey ?? options.clientMutationId;
    const idempotencyResult = await checkOrCreateActivityLogEntry({
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
          deps: createReportFlowDeps(),
        });
        return { entryId: flowResult.rowId };
      },
    });

    if (!idempotencyResult.entryId) {
      throw new HttpError(500, "建立工令報工後沒拿到 rowId", "RAGIC_WRITE_FAILED");
    }

    if (idempotencyResult.reused) {
      log.info({
        event: "create.idempotency-hit",
        formId,
        entryId,
        clientMutationId: options.clientMutationId,
        createIdempotencyKey: durableCreateKey,
        rowId: idempotencyResult.entryId,
      });
    }

    return { rowId: idempotencyResult.entryId };
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
      await triggerActivityLogRowRecalculateFlow(entryId, normalizedRowIds);
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
    workReportMutationCacheService.markReportFullCacheDirty(formId);
  }
}

export const workReportCreateMutationService = new WorkReportCreateMutationService();
