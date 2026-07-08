import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { assertClientNotBlocked } from "./clientBlockGuard";
import { HttpError } from "../utils/httpError";
import { env } from "../config/env";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";
import {
  ragicFieldIndexRepository,
  type RagicFieldIndexRepository,
} from "../storage/sqlite/ragicFieldIndexRepository";
import {
  ragicFieldIndexService,
  type RagicFieldIndexService,
} from "../services/dev/ragicFieldIndexService";
import {
  scanWorkflows,
  getWorkflowScanState,
  isWorkflowScanConfigured,
} from "../services/dev/ragicWorkflowScanService";
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
  let scanController: AbortController | null = null; // workflow 直讀 .nui 掃描專用

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

  // 依賴查詢：給一個 field_id，沿依賴邊往上游（它依賴誰）或下游（誰依賴它）展開。
  // upstream = 「這個欄位要正確，須先有哪些上游」；downstream =「改它會波及誰」。
  router.get(
    "/edges/dependencies",
    asyncHandler(async (req, res) => {
      const fieldId = String(req.query.fieldId ?? "").trim();
      if (!fieldId) {
        throw new HttpError(400, "缺少 fieldId 參數", "MISSING_FIELD_ID");
      }
      const direction =
        String(req.query.direction ?? "upstream").trim() === "downstream"
          ? "downstream"
          : "upstream";
      const rawDepth = Number(req.query.depth ?? 10);
      const maxDepth =
        Number.isFinite(rawDepth) && rawDepth > 0 ? Math.trunc(rawDepth) : 10;
      const nodes = await repository.queryDependencies({
        fieldId,
        direction,
        maxDepth,
      });
      // 帶上 Ragic 表單 URL（domain 來自 env，前端不必 hardcode），點得進去
      const base = `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`;
      const data = nodes.map((n) => ({
        ...n,
        ragicUrl: n.formPath ? `${base}/${n.formPath}` : null,
      }));
      res.json({
        data,
        meta: { fieldId, direction, maxDepth, count: data.length },
      });
    })
  );

  // 邊統計：各 edge_type 數量、resolved / broken / side-effect 概況
  router.get(
    "/edges/stats",
    asyncHandler(async (_req, res) => {
      const stats = await repository.getEdgeStats();
      res.json({ data: stats });
    })
  );

  // group 聚合 ER 鳥瞰圖：form group 超級節點 + 三型跨群聚合邊（FK / workflow / 子表）
  router.get(
    "/edges/group-graph",
    asyncHandler(async (_req, res) => {
      const graph = await repository.getGroupGraph();
      const base = `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`;
      const nodes = graph.nodes.map((n) => ({
        ...n,
        forms: n.forms.map((f) => ({ ...f, ragicUrl: `${base}/${f.formPath}` })),
      }));
      res.json({ data: { nodes, edges: graph.edges } });
    })
  );

  // 正規化體檢：每表 Link&Load fan-in/fan-out + 啟發式分類（主檔/交易檔/葉表）
  router.get(
    "/edges/normalization",
    asyncHandler(async (_req, res) => {
      const audit = await repository.getNormalizationAudit();
      const base = `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`;
      const tables = audit.tables.map((t) => ({ ...t, ragicUrl: `${base}/${t.formPath}` }));
      const cycles = audit.cycles.map((c) => ({
        members: c.members.map((m) => ({ ...m, ragicUrl: `${base}/${m.formPath}` })),
      }));
      res.json({ data: { tables, cycles } });
    })
  );

  // 跨系統副作用清單：會寫外部系統（dbfcommander / savework / callHtmlApp / saveClose）的欄位
  router.get(
    "/edges/side-effects",
    asyncHandler(async (_req, res) => {
      const list = await repository.listSideEffects();
      const base = `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`;
      const data = list.map((s) => ({
        ...s,
        ragicUrl: s.srcFormPath ? `${base}/${s.srcFormPath}` : null,
      }));
      res.json({ data, meta: { count: data.length } });
    })
  );

  // 實體清單（mainKey 群組）：開發者模式「實體瀏覽」分頁的主清單
  router.get(
    "/edges/entities",
    asyncHandler(async (_req, res) => {
      const data = await repository.listEntities();
      res.json({ data, meta: { count: data.length } });
    })
  );

  // 單一實體詳情：欄位（角色/約束/FK）+ 掛它的子表，view/子表帶 Ragic 連結
  router.get(
    "/edges/entities/:key/fields",
    asyncHandler(async (req, res) => {
      const key = String(req.params.key ?? "").trim();
      if (!key) throw new HttpError(400, "缺少 entity key", "MISSING_ENTITY_KEY");
      const d = await repository.getEntityFields(key);
      const base = `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`;
      res.json({
        data: {
          entityKey: d.entityKey,
          repName: d.repName,
          fields: d.fields,
          views: d.views.map((fp) => ({ formPath: fp, ragicUrl: `${base}/${fp}` })),
          childTables: d.childTables.map((c) => ({
            ...c,
            ragicUrl: `${base}/${c.formPath}`,
          })),
        },
      });
    })
  );

  // Workflow JS 層依賴統計（中樞入度榜）：補 field_note 看不到的 getAPIQuery 跨表依賴
  router.get(
    "/workflow/stats",
    asyncHandler(async (_req, res) => {
      const stats = await repository.getWorkflowEdgeStats();
      const base = `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`;
      res.json({
        data: {
          ...stats,
          topDepended: stats.topDepended.map((t) => ({
            ...t,
            ragicUrl: t.resolved ? `${base}/${t.formPath}` : null,
          })),
        },
      });
    })
  );

  // 單張表的 workflow 依賴：下游(query 哪些表) / 上游(被誰 query) / JS 寫的欄位 / 連外副作用
  router.get(
    "/workflow/form",
    asyncHandler(async (req, res) => {
      const formPath = String(req.query.path ?? "").trim();
      if (!formPath) throw new HttpError(400, "缺少 path 參數", "MISSING_FORM_PATH");
      const deps = await repository.getWorkflowFormDeps(formPath);
      const base = `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`;
      res.json({
        data: {
          formPath: deps.formPath,
          sourceScopes: deps.sourceScopes,
          downstreamForms: deps.downstreamForms.map((d) => ({
            ...d,
            ragicUrl: d.resolved ? `${base}/${d.targetFormPath}` : null,
          })),
          upstreamForms: deps.upstreamForms.map((u) => ({
            ...u,
            ragicUrl: `${base}/${u.srcFormPath}`,
          })),
          writes: deps.writes.map((w) => ({
            ...w,
            ragicUrl: w.formPath ? `${base}/${w.formPath}` : null,
          })),
          externals: deps.externals,
        },
      });
    })
  );

  // 單表單 scope 的 workflow JS 原文（前端展開看完整碼）
  router.get(
    "/workflow/source",
    asyncHandler(async (req, res) => {
      const formPath = String(req.query.path ?? "").trim();
      const scope = String(req.query.scope ?? "").trim();
      if (!formPath) throw new HttpError(400, "缺少 path 參數", "MISSING_FORM_PATH");
      if (!["pre", "post", "button", "all"].includes(scope)) {
        throw new HttpError(400, "scope 必須是 pre / post / button / all", "BAD_SCOPE");
      }
      const source = await repository.getWorkflowSource(formPath, scope);
      res.json({ data: source });
    })
  );

  // 直讀 Ragic 本地 .nui 重撈 workflow 依賴（backend 與 Ragic 同台、設了 RAGIC_BUILDER_PATH 才可用）
  router.post(
    "/workflow/scan",
    asyncHandler(async (_req, res) => {
      if (!isWorkflowScanConfigured()) {
        throw new HttpError(
          400,
          "未設定 RAGIC_BUILDER_PATH，此功能只在 Ragic 同台 server 可用",
          "WORKFLOW_SCAN_NOT_CONFIGURED"
        );
      }
      if (getWorkflowScanState().status === "running") {
        throw new HttpError(409, "workflow 掃描進行中，請稍候", "WORKFLOW_SCAN_IN_PROGRESS");
      }
      const controller = new AbortController();
      scanController = controller;
      void scanWorkflows({ signal: controller.signal })
        .catch((error) => {
          log.warn({
            event: "workflow-scan.failed",
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (scanController === controller) scanController = null;
        });
      res.status(202).json({ data: { accepted: true } });
    })
  );

  router.get(
    "/workflow/scan-state",
    asyncHandler(async (_req, res) => {
      res.json({ data: { ...getWorkflowScanState(), configured: isWorkflowScanConfigured() } });
    })
  );

  router.delete(
    "/workflow/scan",
    asyncHandler(async (_req, res) => {
      if (!scanController) {
        res.status(200).json({ data: { aborted: false, reason: "not-running" } });
        return;
      }
      scanController.abort();
      res.status(200).json({ data: { aborted: true } });
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
