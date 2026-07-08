import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { assertClientNotBlocked } from "./clientBlockGuard";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";
import { HttpError } from "../utils/httpError";
import {
  ragicDefinitionsReadService,
  type RagicDefinitionsReadService,
} from "../services/dev/ragicDefinitionsReadService";
import {
  createRagicFormulaPatchDryRunService,
  type RagicFormulaPatchDryRunRequest,
  type RagicFormulaPatchDryRunService,
} from "../services/dev/ragicFormulaPatchDryRunService";
import {
  createRagicFormulaPatchApplyService,
  type RagicFormulaPatchApplyService,
} from "../services/dev/ragicFormulaPatchApplyService";
import {
  createRagicDefinitionsVersionControlService,
  type RagicDefinitionsVersionControlService,
} from "../services/dev/ragicDefinitionsVersionControlService";
import {
  createRagicDefinitionsReExportService,
  type RagicDefinitionsReExportService,
} from "../services/dev/ragicDefinitionsReExportService";
import {
  ragicFormulaSiblingsService,
  type RagicFormulaSiblingsService,
} from "../services/dev/ragicFormulaSiblingsService";
import {
  ragicFormulaAiSuggestionService,
  type RagicFormulaAiSuggestionService,
} from "../services/dev/ai/ragicFormulaAiSuggestionService";
import {
  devAiChatService,
  type DevAiChatService,
} from "../services/dev/ai/devAiChatService";
import {
  devAiFeedbackService,
  type DevAiFeedbackService,
} from "../services/dev/ai/devAiFeedbackService";
import {
  devAiKnowledgeCompilerService,
  type DevAiKnowledgeCompilerService,
} from "../services/dev/ai/devAiKnowledgeCompilerService";
import { runAutoRefreshCycle } from "../bootstrap/ragicFieldIndexAutoRefresh";
import type {
  DevAiChatRequest,
  DevAiFeedbackRequest,
  RagicFormulaAiSuggestRequest,
} from "@shared-types/ragicDefinitions";

interface DevRagicDefinitionsAuthInfo {
  username?: string | null;
}

type FieldIndexRefreshStatus =
  | "triggered"
  | "already-running"
  | "unavailable"
  | "not-needed";

export interface DevRagicDefinitionsRouterDeps {
  service?: RagicDefinitionsReadService;
  formulaPatchDryRunService?: RagicFormulaPatchDryRunService;
  formulaPatchApplyService?: RagicFormulaPatchApplyService;
  versionControlService?: RagicDefinitionsVersionControlService;
  reExportService?: RagicDefinitionsReExportService;
  formulaSiblingsService?: RagicFormulaSiblingsService;
  formulaAiSuggestionService?: RagicFormulaAiSuggestionService;
  devAiChatService?: DevAiChatService;
  devAiFeedbackService?: DevAiFeedbackService;
  devAiKnowledgeCompilerService?: DevAiKnowledgeCompilerService;
  verifyToken?: (
    authorizationHeader: string | undefined
  ) => DevRagicDefinitionsAuthInfo | void;
}

function parseLimit(raw: unknown, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function shouldRefreshFieldIndexAfterReExport(params: {
  before: Awaited<ReturnType<RagicDefinitionsReadService["getState"]>>;
  result: Awaited<ReturnType<RagicDefinitionsReExportService["reExport"]>>;
}): boolean {
  const beforeCounts = params.before.manifest?.counts;
  if (
    !beforeCounts ||
    beforeCounts.forms !== params.result.summary.forms ||
    beforeCounts.fields !== params.result.summary.fields
  ) {
    return true;
  }
  return params.result.versionStatus.definitionsEntries.some((entry) => {
    const path = entry.path.replace(/\\/g, "/");
    return (
      path.endsWith("/fields.json") ||
      path.endsWith("/form.json") ||
      path.endsWith("/manifest.json") ||
      path === "manifest.json"
    );
  });
}

function mapDefinitionError(error: unknown): never {
  if (error instanceof Error && error.message === "BAD_FORM_PATH") {
    throw new HttpError(400, "formPath 格式不合法", "BAD_FORM_PATH");
  }
  if (error instanceof Error && /ENOENT/.test(error.message)) {
    throw new HttpError(404, "找不到指定 definitions 檔案", "DEFINITION_NOT_FOUND");
  }
  throw error;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function parseFormulaPatchBody(body: {
  formPath?: unknown;
  fieldId?: unknown;
  formulaKind?: unknown;
  newFormula?: unknown;
}): RagicFormulaPatchDryRunRequest {
  const formPath = String(body.formPath ?? "").trim();
  const fieldId = String(body.fieldId ?? "").trim();
  const rawFormulaKind = String(body.formulaKind ?? "formula").trim();
  const formulaKind =
    rawFormulaKind === "formula" || rawFormulaKind === "defaultFormula"
      ? rawFormulaKind
      : null;
  const newFormula = typeof body.newFormula === "string" ? body.newFormula : "";

  if (!formPath) throw new HttpError(400, "缺少 formPath", "MISSING_FORM_PATH");
  if (!fieldId) throw new HttpError(400, "缺少 fieldId", "MISSING_FIELD_ID");
  if (!formulaKind) {
    throw new HttpError(
      400,
      "formulaKind 必須是 formula 或 defaultFormula",
      "BAD_FORMULA_KIND"
    );
  }
  if (!newFormula.trim()) {
    throw new HttpError(400, "缺少 newFormula", "MISSING_NEW_FORMULA");
  }

  return { formPath, fieldId, formulaKind, newFormula };
}

function parseFormulaAiSuggestBody(body: {
  formPath?: unknown;
  fieldId?: unknown;
  formulaKind?: unknown;
  objective?: unknown;
  userNotes?: unknown;
  includeSiblings?: unknown;
  includeSimilarFormulas?: unknown;
}): RagicFormulaAiSuggestRequest {
  const formPath = String(body.formPath ?? "").trim();
  const fieldId = String(body.fieldId ?? "").trim();
  const rawFormulaKind = String(body.formulaKind ?? "formula").trim();
  const formulaKind =
    rawFormulaKind === "formula" || rawFormulaKind === "defaultFormula"
      ? rawFormulaKind
      : null;
  const objective = typeof body.objective === "string" ? body.objective.trim() : "";
  const userNotes = typeof body.userNotes === "string" ? body.userNotes.trim() : "";

  if (!formPath) throw new HttpError(400, "缺少 formPath", "MISSING_FORM_PATH");
  if (!fieldId) throw new HttpError(400, "缺少 fieldId", "MISSING_FIELD_ID");
  if (!formulaKind) {
    throw new HttpError(
      400,
      "formulaKind 必須是 formula 或 defaultFormula",
      "BAD_FORMULA_KIND"
    );
  }
  if (!objective) throw new HttpError(400, "缺少 objective", "MISSING_OBJECTIVE");

  return {
    formPath,
    fieldId,
    formulaKind,
    objective,
    ...(userNotes ? { userNotes } : {}),
    includeSiblings: body.includeSiblings !== false,
    includeSimilarFormulas: body.includeSimilarFormulas !== false,
  };
}

function parseDevAiChatBody(body: {
  question?: unknown;
  mode?: unknown;
  speedMode?: unknown;
  formPath?: unknown;
  includeDefinitions?: unknown;
  includeKnowledge?: unknown;
  maxSources?: unknown;
}): DevAiChatRequest {
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const mode = body.mode === "definitions" ? "definitions" : "general";
  const speedMode =
    body.speedMode === "balanced" || body.speedMode === "deep" ? body.speedMode : "fast";
  const formPath = typeof body.formPath === "string" ? body.formPath.trim() : "";
  const maxSources = Number(body.maxSources ?? 8);

  if (!question) throw new HttpError(400, "缺少 question", "MISSING_QUESTION");

  return {
    question,
    mode,
    speedMode,
    ...(formPath ? { formPath } : {}),
    includeDefinitions: body.includeDefinitions === true,
    includeKnowledge: body.includeKnowledge !== false,
    maxSources: Number.isFinite(maxSources) && maxSources > 0 ? Math.trunc(maxSources) : 8,
  };
}

function parseDevAiFeedbackBody(body: {
  kind?: unknown;
  question?: unknown;
  answer?: unknown;
  objective?: unknown;
  proposedFormula?: unknown;
  explanation?: unknown;
  formPath?: unknown;
  fieldId?: unknown;
  formulaKind?: unknown;
  notes?: unknown;
  sourceIds?: unknown;
}): DevAiFeedbackRequest {
  const kind =
    body.kind === "chat-answer" || body.kind === "formula-suggestion"
      ? body.kind
      : null;
  if (!kind) {
    throw new HttpError(
      400,
      "feedback kind 必須是 chat-answer 或 formula-suggestion",
      "DEV_AI_FEEDBACK_BAD_KIND"
    );
  }
  const rawFormulaKind = typeof body.formulaKind === "string" ? body.formulaKind.trim() : "";
  const formulaKind =
    rawFormulaKind === "formula" || rawFormulaKind === "defaultFormula"
      ? rawFormulaKind
      : undefined;
  const sourceIds = Array.isArray(body.sourceIds)
    ? body.sourceIds.filter((item): item is string => typeof item === "string")
    : [];
  return {
    kind,
    ...(typeof body.question === "string" ? { question: body.question } : {}),
    ...(typeof body.answer === "string" ? { answer: body.answer } : {}),
    ...(typeof body.objective === "string" ? { objective: body.objective } : {}),
    ...(typeof body.proposedFormula === "string" ? { proposedFormula: body.proposedFormula } : {}),
    ...(typeof body.explanation === "string" ? { explanation: body.explanation } : {}),
    ...(typeof body.formPath === "string" ? { formPath: body.formPath } : {}),
    ...(typeof body.fieldId === "string" ? { fieldId: body.fieldId } : {}),
    ...(formulaKind ? { formulaKind } : {}),
    ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
    sourceIds,
  };
}

export function createDevRagicDefinitionsRouter(
  deps: DevRagicDefinitionsRouterDeps = {}
): Router {
  const router = Router();
  const service = deps.service ?? ragicDefinitionsReadService;
  const formulaPatchDryRunService =
    deps.formulaPatchDryRunService ??
    createRagicFormulaPatchDryRunService({ definitionsService: service });
  const formulaPatchApplyService =
    deps.formulaPatchApplyService ??
    createRagicFormulaPatchApplyService({
      definitionsService: service,
      dryRunService: formulaPatchDryRunService,
    });
  const versionControlService =
    deps.versionControlService ?? createRagicDefinitionsVersionControlService();
  const reExportService =
    deps.reExportService ??
    createRagicDefinitionsReExportService({
      definitionsService: service,
      versionControlService,
    });
  const formulaSiblingsService =
    deps.formulaSiblingsService ?? ragicFormulaSiblingsService;
  const formulaAiService =
    deps.formulaAiSuggestionService ?? ragicFormulaAiSuggestionService;
  const chatAiService = deps.devAiChatService ?? devAiChatService;
  const feedbackAiService = deps.devAiFeedbackService ?? devAiFeedbackService;
  const knowledgeCompilerService =
    deps.devAiKnowledgeCompilerService ?? devAiKnowledgeCompilerService;
  const verifyToken =
    deps.verifyToken ??
    ((header: string | undefined) => verifySystemNoticeBearerToken(header));

  router.use(
    asyncHandler(async (req, res, next) => {
      const auth = verifyToken(req.header("authorization"));
      res.locals.devActor = auth?.username ?? null;
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
      res.json({ data: await service.getState() });
    })
  );

  router.post(
    "/re-export",
    asyncHandler(async (_req, res) => {
      const before = await service.getState();
      const result = await reExportService.reExport();
      // 重新匯入＝全部同步：definitions 匯完後連動觸發欄位索引 refresh
      // （跨版本判定靠索引；新建多版本表單要刷索引才會出現在跨版本清單）。
      // 公式內容變更不影響跨版本索引，避免每次公式 re-export 都抓整份 Ragic doc。
      let fieldIndexRefresh: FieldIndexRefreshStatus = "not-needed";
      if (
        shouldRefreshFieldIndexAfterReExport({
          before,
          result,
        })
      ) {
        fieldIndexRefresh = "unavailable";
        try {
          const claimed = await runAutoRefreshCycle("re-export-sync");
          fieldIndexRefresh = claimed ? "triggered" : "already-running";
        } catch (error) {
          console.warn("[dev-ragic-definitions][index-refresh-trigger-failed]", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      res.json({ data: { ...result, fieldIndexRefresh } });
    })
  );

  router.get(
    "/forms",
    asyncHandler(async (req, res) => {
      const q = String(req.query.q ?? "").trim();
      const limit = parseLimit(req.query.limit, 200);
      res.json(await service.listForms({ q, limit }));
    })
  );

  router.get(
    "/search",
    asyncHandler(async (req, res) => {
      const rawType = String(req.query.type ?? "all").trim();
      const type: "all" | "field" | "formula" =
        rawType === "field" || rawType === "formula" || rawType === "all"
          ? rawType
          : "all";
      const params = {
        q: String(req.query.q ?? "").trim(),
        fieldId: String(req.query.fieldId ?? "").trim(),
        formPath: String(req.query.formPath ?? "").trim() || undefined,
        type,
        limit: parseLimit(req.query.limit, 200),
      };
      try {
        res.json(await service.search(params));
      } catch (error) {
        mapDefinitionError(error);
      }
    })
  );

  router.get(
    "/form",
    asyncHandler(async (req, res) => {
      const formPath = String(req.query.path ?? "").trim();
      if (!formPath) throw new HttpError(400, "缺少 path 參數", "MISSING_FORM_PATH");
      try {
        res.json({ data: await service.readForm(formPath) });
      } catch (error) {
        mapDefinitionError(error);
      }
    })
  );

  router.get(
    "/formula/siblings",
    asyncHandler(async (req, res) => {
      const formPath = String(req.query.formPath ?? "").trim();
      const fieldId = String(req.query.fieldId ?? "").trim();
      const rawFormulaKind = String(req.query.formulaKind ?? "formula").trim();
      const formulaKind =
        rawFormulaKind === "formula" || rawFormulaKind === "defaultFormula"
          ? rawFormulaKind
          : null;
      const newFormula =
        typeof req.query.newFormula === "string" ? req.query.newFormula : "";
      const includeFreshness = req.query.includeFreshness !== "false";
      const includeCurrent = req.query.includeCurrent === "true";

      if (!formPath) throw new HttpError(400, "缺少 formPath", "MISSING_FORM_PATH");
      if (!fieldId) throw new HttpError(400, "缺少 fieldId", "MISSING_FIELD_ID");
      if (!formulaKind) {
        throw new HttpError(
          400,
          "formulaKind 必須是 formula 或 defaultFormula",
          "BAD_FORMULA_KIND"
        );
      }

      const abortController = new AbortController();
      let responseFinished = false;
      const onFinish = () => {
        responseFinished = true;
      };
      const onClose = () => {
        if (!responseFinished) {
          abortController.abort();
        }
      };
      res.once("finish", onFinish);
      res.once("close", onClose);

      try {
        const data = await formulaSiblingsService.listSiblings({
          formPath,
          fieldId,
          formulaKind,
          ...(newFormula ? { newFormula } : {}),
          includeFreshness,
          includeCurrent,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || res.writableEnded) {
          return;
        }
        res.json({ data });
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) {
          return;
        }
        mapDefinitionError(error);
      } finally {
        res.removeListener("finish", onFinish);
        res.removeListener("close", onClose);
      }
    })
  );

  router.post(
    "/ai/formula/suggest",
    asyncHandler(async (req, res) => {
      const data = parseFormulaAiSuggestBody(req.body as {
        formPath?: unknown;
        fieldId?: unknown;
        formulaKind?: unknown;
        objective?: unknown;
        userNotes?: unknown;
        includeSiblings?: unknown;
        includeSimilarFormulas?: unknown;
      });
      const abortController = new AbortController();
      let responseFinished = false;
      const onFinish = () => {
        responseFinished = true;
      };
      const onClose = () => {
        if (!responseFinished) abortController.abort();
      };
      res.once("finish", onFinish);
      res.once("close", onClose);

      try {
        const result = await formulaAiService.suggestFormula(data, {
          actor: typeof res.locals.devActor === "string" ? res.locals.devActor : null,
          clientId: String(req.header("x-debug-client-id") ?? "").trim() || null,
          tabId: String(req.header("x-debug-tab-id") ?? "").trim() || null,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || res.writableEnded) return;
        res.json({ data: result });
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) return;
        mapDefinitionError(error);
      } finally {
        res.removeListener("finish", onFinish);
        res.removeListener("close", onClose);
      }
    })
  );

  router.post(
    "/formula/dry-run",
    asyncHandler(async (req, res) => {
      const data = parseFormulaPatchBody(req.body as {
        formPath?: unknown;
        fieldId?: unknown;
        formulaKind?: unknown;
        newFormula?: unknown;
      });

      try {
        res.json({ data: await formulaPatchDryRunService.dryRunFormulaPatch(data) });
      } catch (error) {
        mapDefinitionError(error);
      }
    })
  );

  router.post(
    "/formula/apply",
    asyncHandler(async (req, res) => {
      const data = parseFormulaPatchBody(req.body as {
        formPath?: unknown;
        fieldId?: unknown;
        formulaKind?: unknown;
        newFormula?: unknown;
      });

      try {
        res.json({ data: await formulaPatchApplyService.applyFormulaPatch(data) });
      } catch (error) {
        mapDefinitionError(error);
      }
    })
  );

  router.post(
    "/formula/apply-batch",
    asyncHandler(async (req, res) => {
      const body = req.body as { targets?: unknown };
      if (!Array.isArray(body.targets) || body.targets.length === 0) {
        throw new HttpError(400, "缺少 targets", "MISSING_TARGETS");
      }
      if (body.targets.length > 30) {
        throw new HttpError(400, "targets 數量過多（上限 30）", "TOO_MANY_TARGETS");
      }
      const targets = body.targets.map((target) => {
        if (typeof target !== "object" || target === null) {
          throw new HttpError(400, "targets 內含非物件項目", "BAD_TARGET");
        }
        return parseFormulaPatchBody(target as Parameters<typeof parseFormulaPatchBody>[0]);
      });
      const seen = new Set<string>();
      for (const target of targets) {
        const key = `${target.formPath}::${target.fieldId}::${target.formulaKind}`;
        if (seen.has(key)) {
          throw new HttpError(
            400,
            `targets 內同一公式欄位重複：${target.formPath} · ${target.fieldId}`,
            "DUPLICATE_TARGET"
          );
        }
        seen.add(key);
      }

      try {
        res.json({
          data: await formulaPatchApplyService.applyFormulaPatchBatch(targets),
        });
      } catch (error) {
        mapDefinitionError(error);
      }
    })
  );

  router.post(
    "/formula/rollback-latest",
    asyncHandler(async (_req, res) => {
      const rollback = await formulaPatchApplyService.rollbackLatestFormulaPatch();
      res.json({
        data: {
          ...rollback,
          state: await service.getState(),
          versionStatus: await versionControlService.getStatus(),
        },
      });
    })
  );

  router.post(
    "/ai/chat",
    asyncHandler(async (req, res) => {
      const data = parseDevAiChatBody(req.body as {
        question?: unknown;
        mode?: unknown;
        speedMode?: unknown;
        formPath?: unknown;
        includeDefinitions?: unknown;
        includeKnowledge?: unknown;
        maxSources?: unknown;
      });
      const abortController = new AbortController();
      let responseFinished = false;
      const onFinish = () => {
        responseFinished = true;
      };
      const onClose = () => {
        if (!responseFinished) abortController.abort();
      };
      res.once("finish", onFinish);
      res.once("close", onClose);

      try {
        const result = await chatAiService.ask(data, {
          actor: typeof res.locals.devActor === "string" ? res.locals.devActor : null,
          clientId: String(req.header("x-debug-client-id") ?? "").trim() || null,
          tabId: String(req.header("x-debug-tab-id") ?? "").trim() || null,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || res.writableEnded) return;
        res.json({ data: result });
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) return;
        mapDefinitionError(error);
      } finally {
        res.removeListener("finish", onFinish);
        res.removeListener("close", onClose);
      }
    })
  );

  router.post(
    "/ai/feedback",
    asyncHandler(async (req, res) => {
      const data = parseDevAiFeedbackBody(req.body as {
        kind?: unknown;
        question?: unknown;
        answer?: unknown;
        objective?: unknown;
        proposedFormula?: unknown;
        explanation?: unknown;
        formPath?: unknown;
        fieldId?: unknown;
        formulaKind?: unknown;
        notes?: unknown;
        sourceIds?: unknown;
      });
      const result = await feedbackAiService.store(data, {
        actor: typeof res.locals.devActor === "string" ? res.locals.devActor : null,
        clientId: String(req.header("x-debug-client-id") ?? "").trim() || null,
        tabId: String(req.header("x-debug-tab-id") ?? "").trim() || null,
      });
      res.json({ data: result });
    })
  );

  router.get(
    "/ai/knowledge/status",
    asyncHandler(async (_req, res) => {
      res.json({ data: await knowledgeCompilerService.getStatus() });
    })
  );

  router.post(
    "/ai/knowledge/compile",
    asyncHandler(async (req, res) => {
      const result = await knowledgeCompilerService.compile({
        actor: typeof res.locals.devActor === "string" ? res.locals.devActor : null,
        clientId: String(req.header("x-debug-client-id") ?? "").trim() || null,
        tabId: String(req.header("x-debug-tab-id") ?? "").trim() || null,
      });
      res.json({ data: result });
    })
  );

  router.get(
    "/version-control/status",
    asyncHandler(async (_req, res) => {
      res.json({ data: await versionControlService.getStatus() });
    })
  );

  router.post(
    "/version-control/commit",
    asyncHandler(async (req, res) => {
      const body = req.body as { message?: unknown; formPaths?: unknown };
      const message = typeof body.message === "string" ? body.message : undefined;
      const formPaths = Array.isArray(body.formPaths)
        ? body.formPaths.filter((item): item is string => typeof item === "string")
        : undefined;
      const actor =
        typeof res.locals.devActor === "string" ? res.locals.devActor : undefined;
      res.json({
        data: await versionControlService.commitBaseline(message, { actor, formPaths }),
      });
    })
  );

  router.post(
    "/version-control/push",
    asyncHandler(async (_req, res) => {
      res.json({ data: await versionControlService.pushBaseline() });
    })
  );

  return router;
}

export default createDevRagicDefinitionsRouter();
