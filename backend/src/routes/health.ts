import { Router } from "express";
import { env } from "../config/env";
import { SERVER_BOOT_ID } from "../observability/serverBootState";
import { SERVER_DEPLOY_VERSION } from "../observability/deployVersionState";

const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    bootId: SERVER_BOOT_ID,
    deployVersion: SERVER_DEPLOY_VERSION,
    demoMode: env.DEMO_MODE,
  });
});

export default healthRouter;
