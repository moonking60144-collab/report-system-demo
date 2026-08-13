import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { assertClientNotBlocked } from "./clientBlockGuard";
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
 * - GET    /api/dev/ragic-fields/state        看當前狀態
 * - GET    /api/dev/ragic-fields/search       搜尋（依 q / formPath / fieldId）
 * - POST   /api/dev/ragic-fields/refresh      觸發背景重抓 + parse；立即回 202
 * - DELETE /api/dev/ragic-fields/refresh      中止當前 refresh（無 in-flight 回 200 no-op）
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

  // Router-instance-level controller：每次建 router 自帶一個（測試會建多個 router；
  // 不能用 module-level，否則 test 之間會互相污染）。生產只建一次，等同 singleton。
  let currentController: AbortController | null = null;

  router.use(
    asyncHandler(async (req, _res, next) => {
      verifyToken(req.header("authorization"));
      next();
    })
  );

  router.use((req, _res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    try {
      assertClientNotBlocked(req);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/state",
    asyncHandler(async (_req, res) => {
      const state = await repository.getState();
      // refresh 進行中時把 in-memory progress 注入；其他狀態保持 null
      const progress = state.status === "refreshing" ? service.getProgress() : null;
      // 區分 in-flight refresh 歸屬：背景排程 claimRefresh 寫 message="auto-refresh"，
      // route POST /refresh 寫 message="queued"。autoRefreshing=true 表示這次 in-flight
      // 是背景擁有的，前端用來隱藏取消鈕、改顯示友善文案。不改 DB schema、純衍生。
      const autoRefreshing =
        state.status === "refreshing" && state.message === "auto-refresh";
      res.json({ data: { ...state, progress, autoRefreshing } });
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

      // 多撈 1 筆判斷是否截斷：rows.length > limit 就 trim 回 limit，並標 truncated
      const oversampled = await repository.search({
        q: q || undefined,
        formPath: formPath || undefined,
        fieldId: fieldId || undefined,
        limit: limit + 1,
      });
      const truncated = oversampled.length > limit;
      const data = truncated ? oversampled.slice(0, limit) : oversampled;
      res.json({
        data,
        meta: { count: data.length, limit, truncated, q, formPath, fieldId },
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
      // 起新的 AbortController；DELETE /refresh 會抓這個 controller.abort()
      const controller = new AbortController();
      currentController = controller;
      // 背景跑、不擋住 response。Service 自己負責 success/error 的 setState
      void service
        .refresh({ signal: controller.signal })
        .catch((error) => {
          const isAbort =
            error instanceof DOMException && error.name === "AbortError";
          log.warn({
            event: isAbort
              ? "background-refresh.aborted"
              : "background-refresh.failed",
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          // 只有當前 controller 還是 in-flight 時才清；若另一次 refresh 已經
          // 接續（理論上不會，但保險）覆蓋 currentController，這裡不要把它清掉
          if (currentController === controller) {
            currentController = null;
          }
        });
      res.status(202).json({ data: { accepted: true } });
    })
  );

  router.delete(
    "/refresh",
    asyncHandler(async (_req, res) => {
      // 沒在跑 → 直接回 no-op 200，不算錯（client 重複按 cancel 是合理的）
      if (!currentController) {
        res.status(200).json({ data: { aborted: false, reason: "not-running" } });
        return;
      }
      const controller = currentController;
      controller.abort();
      // service.refresh 的 catch block 會把 state 設成 'idle' 並 resetProgress；
      // 這裡只負責回應「中止訊號已發出」，不等 service 收尾（避免 client 等太久）
      res.status(200).json({ data: { aborted: true } });
    })
  );

  return router;
}

const devRagicFieldIndexRouter = createDevRagicFieldIndexRouter();
export default devRagicFieldIndexRouter;
