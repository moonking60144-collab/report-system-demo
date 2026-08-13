import { Router } from "express";
import { env } from "../config/env";
import { SERVER_BOOT_ID } from "../observability/serverBootState";
import { SERVER_DEPLOY_VERSION } from "../observability/deployVersionState";
import { ragicRequestScheduler } from "../infra/ragicRequestScheduler";
import { form16WriteReverifyService } from "../services/form16/form16WriteReverifyService";
import { ragicCallbackRefreshService } from "../services/ragicCallbackRefreshService";
import {
  getRuntimeHealthSnapshot,
  type RuntimeHealthSnapshot,
} from "../observability/runtimeHealthLogger";

interface HealthRouterDeps {
  getForm16WriteReverifyStats?: () => { pending: number; failed: number; total: number };
  getRagicSchedulerStats?: () => unknown;
  getRagicCallbackRefreshStats?: () => unknown;
  getRuntimeHealthSnapshot?: () => RuntimeHealthSnapshot | null;
}

function isDetailRequested(value: unknown): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function createHealthRouter(deps: HealthRouterDeps = {}): Router {
  const router = Router();
  const getForm16WriteReverifyStats =
    deps.getForm16WriteReverifyStats ?? (() => form16WriteReverifyService.getStats());
  const getRagicSchedulerStats =
    deps.getRagicSchedulerStats ?? (() => ragicRequestScheduler.getStats());
  const getRagicCallbackRefreshStats =
    deps.getRagicCallbackRefreshStats ?? (() => ragicCallbackRefreshService.getStats());
  const readRuntimeHealthSnapshot =
    deps.getRuntimeHealthSnapshot ?? getRuntimeHealthSnapshot;

  router.get("/health", (req, res) => {
    const payload: Record<string, unknown> = {
      status: "ok",
      timestamp: new Date().toISOString(),
      demoMode: env.DEMO_MODE,
      bootId: SERVER_BOOT_ID,
      deployVersion: SERVER_DEPLOY_VERSION,
      form16WriteReverify: getForm16WriteReverifyStats(),
    };

    if (isDetailRequested(req.query.detail)) {
      payload.ragicScheduler = getRagicSchedulerStats();
      payload.ragicCallbackRefresh = getRagicCallbackRefreshStats();
      payload.runtime = readRuntimeHealthSnapshot();
    }

    res.json(payload);
  });

  return router;
}

const healthRouter = createHealthRouter();

export default healthRouter;
