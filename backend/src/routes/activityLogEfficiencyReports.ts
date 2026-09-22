import { Router } from "express";
import { activityLogEfficiencyReportArchiveService } from "../services/activityLog/activityLogEfficiencyReportArchiveService";
import { HttpError } from "../utils/httpError";
import { asyncHandler } from "./asyncHandler";
import { readTaskActorContext } from "./taskActorContext";

const activityLogEfficiencyReportsRouter = Router();
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

function toPublicSnapshot(snapshot: Awaited<ReturnType<
  typeof activityLogEfficiencyReportArchiveService.listSnapshots
>>["records"][number]) {
  return {
    id: snapshot.id,
    periodMonth: snapshot.periodMonth,
    version: snapshot.version,
    status: snapshot.status,
    sourceRowCount: snapshot.sourceRowCount,
    sourceSizeBytes: snapshot.sourceSizeBytes,
    createdAt: snapshot.createdAt,
    finalizedAt: snapshot.finalizedAt,
    artifacts: snapshot.artifacts.map((artifact) => ({
      id: artifact.id,
      snapshotId: artifact.snapshotId,
      attendanceDays: artifact.attendanceDays,
      xlsxSizeBytes: artifact.xlsxSizeBytes,
      createdAt: artifact.createdAt,
    })),
  };
}

function readNonNegativeInteger(
  value: unknown,
  fallback: number,
  fieldName: string,
  max?: number
): number {
  const normalized = String(value ?? "").trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `${fieldName} 必須是有效整數`, "INVALID_QUERY_PARAM");
  }
  return max === undefined ? parsed : Math.min(parsed, max);
}

function readAttendanceDays(value: unknown): number | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 31) {
    throw new HttpError(400, "attendanceDays 需為 0~31 之間的數字", "INVALID_QUERY_PARAM");
  }
  return parsed;
}

function sendDownload(
  res: Parameters<Parameters<typeof asyncHandler>[0]>[1],
  filePath: string,
  filename: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    res.download(filePath, filename, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

activityLogEfficiencyReportsRouter.get(
  "/downtime/efficiency-reports",
  asyncHandler(async (req, res) => {
    const limit = Math.max(
      1,
      readNonNegativeInteger(req.query.limit, DEFAULT_HISTORY_LIMIT, "limit", MAX_HISTORY_LIMIT)
    );
    const offset = readNonNegativeInteger(req.query.offset, 0, "offset");
    const result = await activityLogEfficiencyReportArchiveService.listSnapshots(limit, offset);
    res.json({
      data: result.records.map(toPublicSnapshot),
      meta: {
        count: result.records.length,
        totalCount: result.totalCount,
        limit,
        offset,
        hasMore: offset + result.records.length < result.totalCount,
      },
    });
  })
);

activityLogEfficiencyReportsRouter.get(
  "/downtime/export/monthly-csv",
  asyncHandler(async (req, res) => {
    const actor = readTaskActorContext(req);
    const result = await activityLogEfficiencyReportArchiveService.getOrCreateCurrentCsv(
      actor.actorClientId
    );
    await sendDownload(res, result.filePath, result.filename);
  })
);

activityLogEfficiencyReportsRouter.get(
  "/downtime/export/analysis-xlsx",
  asyncHandler(async (req, res) => {
    const actor = readTaskActorContext(req);
    const result = await activityLogEfficiencyReportArchiveService.getOrCreateCurrentAnalysis(
      readAttendanceDays(req.query.attendanceDays),
      actor.actorClientId
    );
    await sendDownload(res, result.filePath, result.filename);
  })
);

activityLogEfficiencyReportsRouter.get(
  "/downtime/efficiency-reports/:snapshotId/csv",
  asyncHandler(async (req, res) => {
    const result = await activityLogEfficiencyReportArchiveService.getStoredCsv(req.params.snapshotId);
    await sendDownload(res, result.filePath, result.filename);
  })
);

activityLogEfficiencyReportsRouter.get(
  "/downtime/efficiency-reports/:snapshotId/artifacts/:artifactId/xlsx",
  asyncHandler(async (req, res) => {
    const result = await activityLogEfficiencyReportArchiveService.getStoredXlsx(
      req.params.snapshotId,
      req.params.artifactId
    );
    await sendDownload(res, result.filePath, result.filename);
  })
);

export default activityLogEfficiencyReportsRouter;
