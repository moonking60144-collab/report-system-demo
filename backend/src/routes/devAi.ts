import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { assertClientNotBlocked } from "./clientBlockGuard";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";
import {
  devAiThreadService,
  type DevAiThreadService,
} from "../services/dev/ai/devAiThreadService";
import { HttpError } from "../utils/httpError";
import type {
  DevAiCreateThreadRequest,
  DevAiSendMessageRequest,
  DevAiSpeedMode,
  DevAiThreadMode,
} from "@shared-types/ragicDefinitions";

interface DevAiAuthInfo {
  username?: string | null;
}

export interface DevAiRouterDeps {
  threadService?: DevAiThreadService;
  verifyToken?: (authorizationHeader: string | undefined) => DevAiAuthInfo | void;
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
  return {
    ...(typeof input.formPath === "string" ? { formPath: input.formPath } : {}),
    ...(typeof input.fieldId === "string" ? { fieldId: input.fieldId } : {}),
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
  message?: unknown;
  mode?: unknown;
  speedMode?: unknown;
  context?: unknown;
  includeKnowledge?: unknown;
  includeDefinitions?: unknown;
}): DevAiSendMessageRequest {
  const message = typeof body.message === "string" ? body.message : "";
  const mode = parseMode(body.mode);
  const speedMode = parseSpeedMode(body.speedMode);
  return {
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

export function createDevAiRouter(deps: DevAiRouterDeps = {}): Router {
  const router = Router();
  const threadService = deps.threadService ?? devAiThreadService;
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
      const result = await threadService.sendMessage(
        devActor(res.locals),
        req.params.threadId,
        parseSendMessageBody(req.body as Parameters<typeof parseSendMessageBody>[0]),
        {
          clientId: String(req.header("x-debug-client-id") ?? "").trim() || null,
          tabId: String(req.header("x-debug-tab-id") ?? "").trim() || null,
        }
      );
      res.json({ data: result });
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
