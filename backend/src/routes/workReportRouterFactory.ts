import { Router } from "express";
import type { WorkReportRouterDeps } from "./workReportRouterTypes";
import {
  registerWorkReportCallbackAndPresenceRoutes,
  registerWorkReportMutationRoutes,
  registerWorkReportReadRoutes,
  registerWorkReportSyncRoutes,
} from "./workReportRouteRegistrars";

export type { WorkReportRouterDeps } from "./workReportRouterTypes";

export function createWorkReportRouter(deps: WorkReportRouterDeps): Router {
  const workReportRouter = Router();
  registerWorkReportSyncRoutes(workReportRouter, deps);
  registerWorkReportReadRoutes(workReportRouter, deps);
  registerWorkReportCallbackAndPresenceRoutes(workReportRouter, deps);
  registerWorkReportMutationRoutes(workReportRouter, deps);

  return workReportRouter;
}
