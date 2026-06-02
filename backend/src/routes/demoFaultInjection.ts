/**
 * Demo fault-injection control plane — 只在 DEMO_MODE=true 時 mount。
 *
 * 端點：
 * - GET  /api/__demo/fault-injection：回 current state（不需 key）
 * - PUT  /api/__demo/fault-injection：partial-update state，需 X-Demo-Key header
 *
 * 用途：讓 demo UI 上有按鈕一鍵打開「上游模擬失敗 / 延遲 / 掉欄位」，現場演示
 * 後端 circuit breaker、write verifier rollback、orphan cleanup 三條防線。
 */

import { Router } from "express";
import { env } from "../config/env";
import {
  getState,
  setState,
  type FaultInjectionState,
} from "../infra/faultInjection";

const demoFaultInjectionRouter = Router();

demoFaultInjectionRouter.get("/__demo/fault-injection", (_req, res) => {
  res.json({ data: getState() });
});

demoFaultInjectionRouter.put("/__demo/fault-injection", (req, res) => {
  if (!env.DEMO_RESET_KEY) {
    res.status(503).json({
      error: {
        code: "DEMO_RESET_KEY_NOT_CONFIGURED",
        message: "DEMO_RESET_KEY 尚未設定，fault-injection 控制端點停用",
      },
    });
    return;
  }
  const key = req.header("x-demo-key") ?? "";
  if (key !== env.DEMO_RESET_KEY) {
    res.status(403).json({
      error: {
        code: "DEMO_RESET_KEY_INVALID",
        message: "X-Demo-Key header 缺失或不正確",
      },
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const partial: Partial<FaultInjectionState> = {};
  if (typeof body.enabled === "boolean") partial.enabled = body.enabled;
  if (typeof body.failureRate === "number") partial.failureRate = body.failureRate;
  if (typeof body.latencyMs === "number") partial.latencyMs = body.latencyMs;
  if (typeof body.dropFieldRate === "number") partial.dropFieldRate = body.dropFieldRate;

  const next = setState(partial);
  res.status(200).json({ data: next });
});

export default demoFaultInjectionRouter;
