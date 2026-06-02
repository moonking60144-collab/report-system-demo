import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { HttpError } from "../utils/httpError";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";
import {
  ragicFieldIndexRepository,
  type RagicFieldIndexRepository,
} from "../storage/sqlite/ragicFieldIndexRepository";
import {
  ragicFieldIndexService,
  type RagicFieldIndexService,
} from "../services/dev/ragicFieldIndexService";
import { createLogger } from "../observability/logger";

const log = createLogger("dev-ragic-fields");

/**
 * Phase 3 Ragic 欄位索引路由
 *
 * 全部 endpoint 沿用 systemNotice admin token 驗證
 * （跟原本「開發者模式」同樣權限門檻）
 *
 * - GET  /api/dev/ragic-fields/state        看當前狀態
 * - GET  /api/dev/ragic-fields/search       搜尋（依 q / formPath / fieldId）
 * - POST /api/dev/ragic-fields/refresh      觸發背景重抓 + parse；立即回 202
 */
export interface DevRagicFieldIndexRouterDeps {
  repository?: RagicFieldIndexRepository;
  service?: RagicFieldIndexService;
  /** 注入 auth check（測試可換成 stub）；預設沿用 systemNotice token 體系 */
  verifyToken?: (authorizationHeader: string | undefined) => void;
}

export function createDevRagicFieldIndexRouter(
  deps: DevRagicFieldIndexRouterDeps = {}
): Router {
  const router = Router();
  const repository = deps.repository ?? ragicFieldIndexRepository;
  const service = deps.service ?? ragicFieldIndexService;
  const verifyToken =
    deps.verifyToken ??
    ((header: string | undefined) => {
      verifySystemNoticeBearerToken(header);
    });

  router.use(
    asyncHandler(async (req, _res, next) => {
      verifyToken(req.header("authorization"));
      next();
    })
  );

  router.get(
    "/state",
    asyncHandler(async (_req, res) => {
      const state = await repository.getState();
      // refresh 進行中時把 in-memory progress 注入；其他狀態保持 null
      const progress = state.status === "refreshing" ? service.getProgress() : null;
      res.json({ data: { ...state, progress } });
    })
  );

  router.get(
    "/search",
    asyncHandler(async (req, res) => {
      const q = String(req.query.q ?? "").trim();
      const formPath = String(req.query.formPath ?? "").trim();
      const fieldId = String(req.query.fieldId ?? "").trim();
      const rawLimit = Number(req.query.limit ?? 200);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : 200;

      const data = await repository.search({
        q: q || undefined,
        formPath: formPath || undefined,
        fieldId: fieldId || undefined,
        limit,
      });
      res.json({
        data,
        meta: { count: data.length, limit, q, formPath, fieldId },
      });
    })
  );

  router.post(
    "/refresh",
    asyncHandler(async (_req, res) => {
      // Atomic claim：若另一個 refresh 還在 flight，這次直接 409 不啟動。
      // 比起以前用 module-level flag + 兩段 read/write，
      // claimRefresh 用單一 SQL UPDATE WHERE status != 'refreshing' 保證原子性。
      const claimed = await repository.claimRefresh("queued");
      if (!claimed) {
        throw new HttpError(
          409,
          "另一個 refresh 仍在進行中，請等待完成",
          "REFRESH_IN_PROGRESS"
        );
      }
      // 背景跑、不擋住 response。Service 自己負責 success/error 的 setState
      void service.refresh().catch((error) => {
        log.warn({
          event: "background-refresh.failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      res.status(202).json({ data: { accepted: true } });
    })
  );

  return router;
}

const devRagicFieldIndexRouter = createDevRagicFieldIndexRouter();
export default devRagicFieldIndexRouter;
