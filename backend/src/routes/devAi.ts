import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { assertClientNotBlocked } from "./clientBlockGuard";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";
import {
  devAiThreadService,
  type DevAiThreadService,
} from "../services/dev/ai/devAiThreadService";
import {
  devAiKnowledgeGovernanceService,
  type DevAiKnowledgeGovernanceService,
} from "../services/dev/ai/devAiKnowledgeGovernanceService";
import { HttpError } from "../utils/httpError";
import { env } from "../config/env";
import { normalizeDevAiProviderName } from "../services/dev/ai/devAiProviderFactory";
import { devAiKnowledgeBaseService } from "../services/dev/ai/devAiKnowledgeBaseService";
import type {
  DevAiCreateThreadRequest,
  DevAiFeedbackKind,
  DevAiFeedbackRequest,
  DevAiKnowledgeCandidateStatus,
  DevAiKnowledgeCandidateSubmitRequest,
  DevAiKnowledgeCandidateUpdateRequest,
  DevAiKnowledgeDomain,
  DevAiKnowledgeRuntimeStatus,
  DevAiReadiness,
  DevAiSendMessageRequest,
  DevAiSpeedMode,
  DevAiThreadMode,
} from "@shared-types/ragicDefinitions";

interface DevAiAuthInfo {
  username?: string | null;
}

export interface DevAiRouterDeps {
  threadService?: DevAiThreadService;
  knowledgeGovernanceService?: DevAiKnowledgeGovernanceService;
  verifyToken?: (authorizationHeader: string | undefined) => DevAiAuthInfo | void;
  getReadiness?: () => DevAiReadiness | Promise<DevAiReadiness>;
}

export function resolveDevAiReadiness(input: {
  conversationEnabled: boolean;
  providerEnabled: boolean;
  providerName: DevAiReadiness["provider"]["name"];
  providerConfigured: boolean;
  runtime: DevAiKnowledgeRuntimeStatus;
}): DevAiReadiness {
  const chatAvailable =
    input.conversationEnabled && input.providerEnabled && input.providerConfigured;
  const runtime = input.runtime;
  const knowledgeAvailable =
    runtime.retrievalMode === "lexical" ||
    (runtime.index.state === "ready" && runtime.embedding.state === "prepared");
  const knowledgeState: DevAiReadiness["knowledge"]["state"] =
    runtime.retrievalMode === "lexical"
      ? "not-required"
      : knowledgeAvailable
        ? "ready"
        : runtime.index.state === "ready"
          ? "not-prepared"
          : runtime.index.state;
  const reason = !input.conversationEnabled
    ? "conversation-disabled"
    : !input.providerEnabled
      ? "provider-disabled"
      : !input.providerConfigured
        ? "provider-not-configured"
        : "ready";
  return {
    chatAvailable,
    knowledge: { available: knowledgeAvailable, state: knowledgeState },
    conversation: { enabled: input.conversationEnabled },
    provider: {
      enabled: input.providerEnabled,
      configured: input.providerConfigured,
      name: input.providerName,
    },
    retrieval: { mode: runtime.retrievalMode },
    reason,
  };
}

export async function getDevAiReadiness(): Promise<DevAiReadiness> {
  const name = normalizeDevAiProviderName(env.DEV_AI_PROVIDER);
  const configured =
    name === "google"
      ? Boolean(env.GOOGLE_GEMINI_API_KEY)
      : name === "minimax"
        ? Boolean(env.MINIMAX_API_KEY)
        : false;
  return resolveDevAiReadiness({
    conversationEnabled: env.DEV_AI_CONVERSATION_HISTORY_ENABLED,
    providerEnabled: env.DEV_AI_ENABLED,
    providerName: name,
    providerConfigured: configured,
    runtime: await devAiKnowledgeBaseService.getRuntimeStatus!(),
  });
}

function devActor(resLocals: Record<string, unknown>): string {
  const actor = typeof resLocals.devActor === "string" ? resLocals.devActor.trim() : "";
  if (!actor) throw new HttpError(401, "缺少 Dev 使用者身分", "DEV_ACTOR_MISSING");
  return actor;
}

function parseMode(value: unknown): DevAiThreadMode | undefined {
  return value === "auto" || value === "formula" || value === "definitions" || value === "general"
    ? value
    : undefined;
}

function parseSpeedMode(value: unknown): DevAiSpeedMode | undefined {
  return value === "fast" || value === "balanced" || value === "deep" ? value : undefined;
}

function parseContext(value: unknown): DevAiCreateThreadRequest["context"] {
  if (typeof value !== "object" || value === null) return undefined;
  const input = value as Record<string, unknown>;
  const formulaKind =
    input.formulaKind === "formula" || input.formulaKind === "defaultFormula"
      ? input.formulaKind
      : undefined;
  const sourceLine = input.sourceLine === undefined
    ? undefined
    : Number(input.sourceLine);
  const position = typeof input.position === "string"
    ? input.position.trim().toUpperCase()
    : "";
  if (
    sourceLine !== undefined &&
    (!Number.isSafeInteger(sourceLine) || sourceLine <= 0)
  ) {
    throw new HttpError(400, "context.sourceLine 必須是正整數", "BAD_SOURCE_LINE");
  }
  if (position && !/^[A-Z]+\d+$/.test(position)) {
    throw new HttpError(400, "context.position 格式不合法", "BAD_FORMULA_POSITION");
  }
  if (Boolean(position) !== (sourceLine !== undefined)) {
    throw new HttpError(
      400,
      "context.position 與 context.sourceLine 必須一起提供",
      "FORMULA_OCCURRENCE_LOCATOR_INCOMPLETE"
    );
  }
  return {
    ...(typeof input.formPath === "string" ? { formPath: input.formPath.trim() } : {}),
    ...(typeof input.fieldId === "string" ? { fieldId: input.fieldId.trim() } : {}),
    ...(position ? { position } : {}),
    ...(sourceLine !== undefined ? { sourceLine } : {}),
    ...(formulaKind ? { formulaKind } : {}),
  };
}

function parseCreateThreadBody(body: {
  title?: unknown;
  mode?: unknown;
  context?: unknown;
}): DevAiCreateThreadRequest {
  const mode = parseMode(body.mode);
  return {
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(mode ? { mode } : {}),
    ...(body.context ? { context: parseContext(body.context) } : {}),
  };
}

function parseSendMessageBody(body: {
  clientMessageId?: unknown;
  message?: unknown;
  mode?: unknown;
  speedMode?: unknown;
  context?: unknown;
  includeKnowledge?: unknown;
  includeDefinitions?: unknown;
}): DevAiSendMessageRequest {
  const clientMessageId =
    typeof body.clientMessageId === "string" ? body.clientMessageId.trim() : "";
  if (!clientMessageId) {
    throw new HttpError(
      400,
      "缺少 clientMessageId",
      "DEV_AI_CLIENT_MESSAGE_ID_REQUIRED"
    );
  }
  const message = typeof body.message === "string" ? body.message : "";
  const mode = parseMode(body.mode);
  const speedMode = parseSpeedMode(body.speedMode);
  return {
    clientMessageId,
    message,
    ...(mode ? { mode } : {}),
    ...(speedMode ? { speedMode } : {}),
    ...(body.context ? { context: parseContext(body.context) } : {}),
    ...(typeof body.includeKnowledge === "boolean"
      ? { includeKnowledge: body.includeKnowledge }
      : {}),
    ...(typeof body.includeDefinitions === "boolean"
      ? { includeDefinitions: body.includeDefinitions }
      : {}),
  };
}

function parseKnowledgeDomain(value: unknown): DevAiKnowledgeDomain | undefined {
  return value === "ragic" ||
    value === "definitions" ||
    value === "internal-sop" ||
    value === "meeting"
    ? value
    : undefined;
}

function parseKnowledgeCandidateBody(body: {
  payload?: unknown;
  domain?: unknown;
  title?: unknown;
  sourceKey?: unknown;
  sourceThreadId?: unknown;
  sourceMessageId?: unknown;
}): DevAiKnowledgeCandidateSubmitRequest {
  if (typeof body.payload !== "object" || body.payload === null) {
    throw new HttpError(
      400,
      "缺少候選知識內容",
      "DEV_AI_KNOWLEDGE_CANDIDATE_PAYLOAD_REQUIRED"
    );
  }
  const domain = parseKnowledgeDomain(body.domain);
  return {
    payload: body.payload as DevAiFeedbackRequest,
    ...(domain ? { domain } : {}),
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.sourceKey === "string" ? { sourceKey: body.sourceKey } : {}),
    ...(typeof body.sourceThreadId === "string"
      ? { sourceThreadId: body.sourceThreadId }
      : {}),
    ...(typeof body.sourceMessageId === "string"
      ? { sourceMessageId: body.sourceMessageId }
      : {}),
  };
}

function parseKnowledgeCandidateUpdateBody(body: {
  payload?: unknown;
  domain?: unknown;
  title?: unknown;
}): DevAiKnowledgeCandidateUpdateRequest {
  const domain = parseKnowledgeDomain(body.domain);
  return {
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(domain ? { domain } : {}),
    ...(typeof body.payload === "object" && body.payload !== null
      ? { payload: body.payload as DevAiFeedbackRequest }
      : {}),
  };
}

function parseCandidateStatus(value: unknown): DevAiKnowledgeCandidateStatus | undefined {
  return value === "pending" ||
    value === "publishing" ||
    value === "approved" ||
    value === "rejected"
    ? value
    : undefined;
}

function parseCandidateKind(value: unknown): DevAiFeedbackKind | undefined {
  return value === "chat-answer" || value === "formula-suggestion" ? value : undefined;
}

function parseCandidateLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new HttpError(400, "limit 必須是正整數", "DEV_AI_KNOWLEDGE_BAD_LIMIT");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new HttpError(400, "limit 必須是正整數", "DEV_AI_KNOWLEDGE_BAD_LIMIT");
  }
  return limit;
}

export function createDevAiRouter(deps: DevAiRouterDeps = {}): Router {
  const router = Router();
  const threadService = deps.threadService ?? devAiThreadService;
  const knowledgeGovernanceService =
    deps.knowledgeGovernanceService ?? devAiKnowledgeGovernanceService;
  const verifyToken =
    deps.verifyToken ??
    ((header: string | undefined) => verifySystemNoticeBearerToken(header));
  const readReadiness = deps.getReadiness ?? getDevAiReadiness;

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
    "/readiness",
    asyncHandler(async (_req, res) => {
      res.json({ data: await readReadiness() });
    })
  );

  router.get(
    "/knowledge/candidates",
    asyncHandler(async (req, res) => {
      const status = parseCandidateStatus(req.query.status);
      const kind = parseCandidateKind(req.query.kind);
      const limit = parseCandidateLimit(req.query.limit);
      res.json({
        data: await knowledgeGovernanceService.listCandidates({
          ...(status ? { status } : {}),
          ...(kind ? { kind } : {}),
          ...(typeof req.query.query === "string" ? { query: req.query.query } : {}),
          ...(typeof req.query.cursor === "string" ? { cursor: req.query.cursor } : {}),
          ...(limit ? { limit } : {}),
        }),
      });
    })
  );

  router.post(
    "/knowledge/candidates",
    asyncHandler(async (req, res) => {
      const result = await knowledgeGovernanceService.submitCandidate(
        parseKnowledgeCandidateBody(
          req.body as Parameters<typeof parseKnowledgeCandidateBody>[0]
        ),
        {
          actor: devActor(res.locals),
          clientId: String(req.header("x-debug-client-id") ?? "").trim() || null,
          tabId: String(req.header("x-debug-tab-id") ?? "").trim() || null,
        }
      );
      res.status(result.duplicate ? 200 : 201).json({ data: result });
    })
  );

  router.patch(
    "/knowledge/candidates/:candidateId",
    asyncHandler(async (req, res) => {
      res.json({
        data: await knowledgeGovernanceService.updateCandidate(
          req.params.candidateId,
          parseKnowledgeCandidateUpdateBody(
            req.body as Parameters<typeof parseKnowledgeCandidateUpdateBody>[0]
          ),
          { actor: devActor(res.locals) }
        ),
      });
    })
  );

  router.post(
    "/knowledge/candidates/:candidateId/approve",
    asyncHandler(async (req, res) => {
      const body = req.body as { note?: unknown };
      res.json({
        data: await knowledgeGovernanceService.approveCandidate(
          req.params.candidateId,
          typeof body.note === "string" ? body.note : undefined,
          {
            actor: devActor(res.locals),
            clientId: String(req.header("x-debug-client-id") ?? "").trim() || null,
            tabId: String(req.header("x-debug-tab-id") ?? "").trim() || null,
          }
        ),
      });
    })
  );

  router.post(
    "/knowledge/candidates/:candidateId/reject",
    asyncHandler(async (req, res) => {
      const body = req.body as { note?: unknown };
      res.json({
        data: await knowledgeGovernanceService.rejectCandidate(
          req.params.candidateId,
          typeof body.note === "string" ? body.note : undefined,
          { actor: devActor(res.locals) }
        ),
      });
    })
  );

  router.get(
    "/threads",
    asyncHandler(async (_req, res) => {
      res.json({ data: await threadService.listThreads(devActor(res.locals)) });
    })
  );

  router.post(
    "/threads",
    asyncHandler(async (req, res) => {
      const thread = await threadService.createThread(
        devActor(res.locals),
        parseCreateThreadBody(req.body as Parameters<typeof parseCreateThreadBody>[0])
      );
      res.status(201).json({ data: thread });
    })
  );

  router.get(
    "/threads/:threadId",
    asyncHandler(async (req, res) => {
      res.json({
        data: await threadService.getThreadDetail(devActor(res.locals), req.params.threadId),
      });
    })
  );

  router.post(
    "/threads/:threadId/messages",
    asyncHandler(async (req, res) => {
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
        const result = await threadService.sendMessage(
          devActor(res.locals),
          req.params.threadId,
          parseSendMessageBody(req.body as Parameters<typeof parseSendMessageBody>[0]),
          {
            clientId: String(req.header("x-debug-client-id") ?? "").trim() || null,
            tabId: String(req.header("x-debug-tab-id") ?? "").trim() || null,
            signal: abortController.signal,
          }
        );
        if (abortController.signal.aborted || res.writableEnded) return;
        res.json({ data: result });
      } catch (error) {
        if (abortController.signal.aborted) return;
        throw error;
      } finally {
        res.removeListener("finish", onFinish);
        res.removeListener("close", onClose);
      }
    })
  );

  router.post(
    "/threads/:threadId/archive",
    asyncHandler(async (req, res) => {
      res.json({
        data: await threadService.archiveThread(devActor(res.locals), req.params.threadId),
      });
    })
  );

  return router;
}

export default createDevAiRouter();
