import { Router } from "express";
import { env } from "../config/env";
import { SERVER_BOOT_ID } from "../observability/serverBootState";
import { SERVER_DEPLOY_VERSION } from "../observability/deployVersionState";
import { ragicRequestScheduler } from "../infra/ragicRequestScheduler";
import { activityLogWriteReverifyService } from "../services/activityLog/activityLogWriteReverifyService";
import { ragicCallbackRefreshService } from "../services/ragicCallbackRefreshService";
import {
  getMeetingProviderReadiness,
  type MeetingProviderReadiness,
} from "../config/meetingProviderReadiness";
import {
  getRuntimeHealthSnapshot,
  type RuntimeHealthSnapshot,
} from "../observability/runtimeHealthLogger";
import {
  workReportReadinessService,
  type WorkReportReadinessSnapshot,
} from "../services/work-report/workReportReadinessService";
import { asyncHandler } from "./asyncHandler";

interface HealthRouterDeps {
  getActivityLogWriteReverifyStats?: () => {
    pending: number;
    conflict: number;
    failed: number;
    total: number;
    storeUnavailable?: boolean;
  };
  getRagicSchedulerStats?: () => unknown;
  getRagicCallbackRefreshStats?: () => unknown;
  getMeetingProviderReadiness?: () => MeetingProviderReadiness;
  getRuntimeHealthSnapshot?: () => RuntimeHealthSnapshot | null;
  getWorkReportReadiness?: () => Promise<WorkReportReadinessSnapshot>;
}

function isDetailRequested(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function createHealthRouter(deps: HealthRouterDeps = {}): Router {
  const router = Router();
  const getActivityLogWriteReverifyStats =
    deps.getActivityLogWriteReverifyStats ?? (() => activityLogWriteReverifyService.getStats());
  const getRagicSchedulerStats =
    deps.getRagicSchedulerStats ?? (() => ragicRequestScheduler.getStats());
  const getRagicCallbackRefreshStats =
    deps.getRagicCallbackRefreshStats ?? (() => ragicCallbackRefreshService.getStats());
  const readMeetingProviderReadiness =
    deps.getMeetingProviderReadiness ?? getMeetingProviderReadiness;
  const readRuntimeHealthSnapshot =
    deps.getRuntimeHealthSnapshot ?? getRuntimeHealthSnapshot;
  const getWorkReportReadiness =
    deps.getWorkReportReadiness ?? (() => workReportReadinessService.getSnapshot());

  router.get("/health", (req, res) => {
    const activityLogWriteReverify = getActivityLogWriteReverifyStats();
    const issues = [
      ...(activityLogWriteReverify.storeUnavailable
        ? ["ACTIVITY_LOG_WRITE_REVERIFY_STORE_UNAVAILABLE"]
        : []),
      ...(activityLogWriteReverify.failed > 0 ? ["ACTIVITY_LOG_WRITE_REVERIFY_FAILED"] : []),
      ...(activityLogWriteReverify.conflict > 0 ? ["ACTIVITY_LOG_WRITE_REVERIFY_CONFLICT"] : []),
    ];
    const payload: Record<string, unknown> = {
      status: "ok",
      healthState: issues.length > 0 ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      demoMode: env.DEMO_MODE,
      bootId: SERVER_BOOT_ID,
      deployVersion: SERVER_DEPLOY_VERSION,
      activityLogWriteReverify,
      issues,
    };

    if (isDetailRequested(req.query.detail)) {
      payload.ragicScheduler = getRagicSchedulerStats();
      payload.ragicCallbackRefresh = getRagicCallbackRefreshStats();
      payload.meetingProviders = readMeetingProviderReadiness();
      payload.runtime = readRuntimeHealthSnapshot();
    }

    res.json(payload);
  });

  router.get(
    "/ready",
    asyncHandler(async (_req, res) => {
      const snapshot = await getWorkReportReadiness();
      res.setHeader("Cache-Control", "no-store");
      res.status(snapshot.ready ? 200 : 503).json(snapshot);
    })
  );

  return router;
}

const healthRouter = createHealthRouter();

export default healthRouter;
