/**
 * Demo control plane — 只在 DEMO_MODE=true 時 mount。
 *
 * 端點：
 * - POST /api/__demo/reset：清空 in-memory store 並重新載入 fixture
 *   需 X-Demo-Key header；不符回 403。沒設定 DEMO_RESET_KEY 直接 503（避免裸奔）
 * - GET  /api/__demo/info：回 demo 公開 metadata，不需 key
 *   bootId、fixture 規模、最近一次 reset 時間、fault-injection state（masked）
 */

import { Router } from "express";
import { env } from "../config/env";
import { SERVER_BOOT_ID } from "../observability/serverBootState";
import { ragicClient } from "../ragic/client";

const demoResetRouter = Router();

demoResetRouter.get("/__demo/info", (_req, res) => {
  const meta = ragicClient.getDemoMetadata?.() ?? {
    lastResetAt: null,
    maxEntriesPerForm: null,
    buckets: [],
  };
  const faultState = ragicClient.getFaultInjection?.() ?? { enabled: false };
  res.json({
    data: {
      demoMode: env.DEMO_MODE,
      bootId: SERVER_BOOT_ID,
      lastResetAt: meta.lastResetAt,
      maxEntriesPerForm: meta.maxEntriesPerForm,
      buckets: meta.buckets,
      faultInjection: { enabled: faultState.enabled === true },
      // 不洩漏 reset key 本身；只透露「有沒有設定」
      resetKeyConfigured: env.DEMO_RESET_KEY.length > 0,
    },
  });
});

demoResetRouter.post("/__demo/reset", (req, res) => {
  if (!env.DEMO_RESET_KEY) {
    res.status(503).json({
      error: {
        code: "DEMO_RESET_KEY_NOT_CONFIGURED",
        message: "DEMO_RESET_KEY 尚未設定，reset 端點停用",
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
  if (typeof ragicClient.reset !== "function") {
    // 邏輯上不會發生（DEMO_MODE=true 時走 MockRagicClient），但保留安全網
    res.status(503).json({
      error: {
        code: "DEMO_RESET_UNSUPPORTED",
        message: "目前的 RagicClient 實作不支援 reset()",
      },
    });
    return;
  }
  ragicClient.reset();
  res.json({
    data: {
      reset: true,
      resetAt: new Date().toISOString(),
    },
  });
});

export default demoResetRouter;
