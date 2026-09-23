import { env } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import { HttpError } from "../../../utils/httpError";
import { createKeyedSerialQueue } from "../../../utils/keyedSerialQueue";
import { createStableJsonFingerprint } from "../../../utils/stableJsonFingerprint";
import { maskSecrets } from "../ragicFormulaPatchDryRunService";
import { ragicDefinitionsReadService, type RagicDefinitionsReadService } from "../ragicDefinitionsReadService";
import {
  devAiChatService,
  type DevAiChatOptions,
  type DevAiChatService,
} from "./devAiChatService";
import {
  devAiThreadRepository,
  type DevAiThreadRepository,
} from "./devAiThreadRepository";
import {
  DEFAULT_DEV_AI_THREAD_TITLE,
  shouldApplyGeneratedDevAiThreadTitle,
} from "./devAiThreadTitle";
import {
  asksAboutForm,
  formNumbersFromQuestion,
  formPathsFromQuestion,
  isContextualFormFollowUp,
  isFormPathOnly,
  normalizeExplicitFormPath,
} from "./devAiFormContext";
import {
  ragicFormulaAiSuggestionService,
  type RagicFormulaAiSuggestionService,
} from "./ragicFormulaAiSuggestionService";
import type {
  DevAiCreateThreadRequest,
  DevAiMessageIntent,
  DevAiSendMessageRequest,
  DevAiSendMessageResult,
  DevAiThread,
  DevAiThreadContext,
  DevAiThreadDetail,
  DevAiThreadMode,
} from "@shared-types/ragicDefinitions";

const log = createLogger("dev-ai-thread");
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const PENDING_REQUEST_STALE_MS = 10 * 60 * 1_000;

export interface DevAiThreadServiceDeps {
  enabled?: boolean;
  threadListLimit?: number;
  threadDetailMessageLimit?: number;
  threadDetailArtifactLimit?: number;
  threadContextMessages?: number;
  maxThreadsPerActor?: number;
  maxMessagesPerThread?: number;
  maxArtifactsPerThread?: number;
  threadRetentionDays?: number;
  archivedThreadRetentionDays?: number;
  repository?: DevAiThreadRepository;
  chatService?: DevAiChatService;
  definitionsService?: Pick<RagicDefinitionsReadService, "listForms">;
  formulaService?: RagicFormulaAiSuggestionService;
  now?: () => Date;
  summaryEnabled?: boolean;
  summaryAfterMessages?: number;
}

export interface DevAiThreadService {
  createThread(ownerActor: string, request?: DevAiCreateThreadRequest): Promise<DevAiThread>;
  listThreads(ownerActor: string): Promise<DevAiThread[]>;
  getThreadDetail(ownerActor: string, threadId: string): Promise<DevAiThreadDetail>;
  sendMessage(
    ownerActor: string,
    threadId: string,
    request: DevAiSendMessageRequest,
    options?: Pick<DevAiChatOptions, "clientId" | "tabId" | "signal">
  ): Promise<DevAiSendMessageResult>;
  archiveThread(ownerActor: string, threadId: string): Promise<DevAiThread>;
}

function compactText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function titleFromMessage(message: string): string {
  return compactText(message, 42) || DEFAULT_DEV_AI_THREAD_TITLE;
}

function normalizeMode(value: unknown): DevAiThreadMode {
  return value === "formula" || value === "definitions" || value === "general" ? value : "auto";
}

function normalizeContext(value: unknown): DevAiThreadContext {
  if (typeof value !== "object" || value === null) return {};
  const input = value as Record<string, unknown>;
  const formPath = normalizeExplicitFormPath(input.formPath);
  const formulaKind =
    input.formulaKind === "formula" || input.formulaKind === "defaultFormula"
      ? input.formulaKind
      : undefined;
  const sourceLine = Number(input.sourceLine);
  return {
    ...(formPath ? { formPath } : {}),
    ...(typeof input.fieldId === "string" && input.fieldId.trim()
      ? { fieldId: input.fieldId.trim() }
      : {}),
    ...(typeof input.position === "string" && input.position.trim()
      ? { position: input.position.trim().toUpperCase() }
      : {}),
    ...(Number.isSafeInteger(sourceLine) && sourceLine > 0 ? { sourceLine } : {}),
    ...(formulaKind ? { formulaKind } : {}),
  };
}

function mergeContext(
  current: DevAiThreadContext,
  value: unknown
): DevAiThreadContext {
  if (typeof value !== "object" || value === null) return current;
  const input = value as Record<string, unknown>;
  const update = normalizeContext(value);
  const next: DevAiThreadContext = { ...current, ...update };
  const formProvided = "formPath" in input;
  const fieldProvided = "fieldId" in input;
  const positionProvided = "position" in input;
  const kindChanged = Boolean(
    update.formulaKind && update.formulaKind !== current.formulaKind
  );

  if (formProvided && !update.formPath) delete next.formPath;
  if (formProvided && !fieldProvided) delete next.fieldId;
  if (formProvided && !("formulaKind" in input)) delete next.formulaKind;
  if ((formProvided || fieldProvided) && !positionProvided) delete next.position;
  if (
    (formProvided || fieldProvided || positionProvided || kindChanged) &&
    !("sourceLine" in input)
  ) {
    delete next.sourceLine;
  }
  return next;
}

function ensureEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new HttpError(403, "Dev AI 對話紀錄未啟用", "DEV_AI_CONVERSATION_DISABLED");
  }
}

function ensureActor(ownerActor: string): string {
  const normalized = ownerActor.trim();
  if (!normalized) throw new HttpError(401, "缺少 Dev 使用者身分", "DEV_ACTOR_MISSING");
  return normalized;
}

function ensureActiveThread(thread: DevAiThread): void {
  if (thread.archivedAt) {
    throw new HttpError(
      409,
      "這個 Dev AI 對話已刪除，請開始新對話",
      "DEV_AI_THREAD_ARCHIVED"
    );
  }
}

function ensureClientMessageId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new HttpError(
      400,
      "缺少 clientMessageId",
      "DEV_AI_CLIENT_MESSAGE_ID_REQUIRED"
    );
  }
  if (!CLIENT_MESSAGE_ID_PATTERN.test(normalized)) {
    throw new HttpError(
      400,
      "clientMessageId 格式不正確",
      "DEV_AI_CLIENT_MESSAGE_ID_INVALID"
    );
  }
  return normalized;
}

function messageRequestErrorCode(error: unknown): string | null {
  if (error instanceof HttpError) return error.code;
  return error instanceof Error ? error.name : null;
}

function buildThreadMemoryPrefix(messages: Array<{ role: string; content: string }>): string {
  if (!messages.length) return "";
  return [
    "以下是同一個 Dev AI thread 的最近對話，僅作為目前回答的上下文；不要把它當成全域 RAG knowledge：",
    ...messages.map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`),
    "",
    "目前使用者問題：",
  ].join("\n");
}

function inferIntent(
  request: DevAiSendMessageRequest,
  threadMode: DevAiThreadMode,
  context: DevAiThreadContext
): DevAiMessageIntent {
  const mode = normalizeMode(request.mode ?? threadMode);
  if (mode === "formula") return "formula";
  if (mode === "definitions") return "definitions";
  if (mode === "general") return "general";
  const text = request.message.toLowerCase();
  const hasFormulaTarget = Boolean(context.formPath && context.fieldId && context.formulaKind);
  const formulaWords = /公式|草案|dry[- ]?run|計算|回傳|改成|修改|formula|欄位/.test(text);
  if (hasFormulaTarget && formulaWords) return "formula";
  if (formPathsFromQuestion(text).length || asksAboutForm(text) || (context.formPath && isContextualFormFollowUp(text))) {
    return "definitions";
  }
  if (/definitions?|ragic|欄位|表單|workflow|\.nui|依賴|公式/.test(text)) return "definitions";
  return "general";
}

function buildFormulaAssistantText(result: {
  proposedFormula: string;
  explanation: string;
  dryRun: { allowed: boolean; blockers: string[]; warnings: string[] };
  confidence: string;
}): string {
  const status = result.dryRun.allowed && result.dryRun.blockers.length === 0
    ? "dry-run 通過"
    : "dry-run 有阻擋";
  const blockers = result.dryRun.blockers.length
    ? `\n阻擋：${result.dryRun.blockers.join("；")}`
    : "";
  const warnings = result.dryRun.warnings.length
    ? `\n警告：${result.dryRun.warnings.join("；")}`
    : "";
  return [
    `建議公式（${status}，${result.confidence} confidence）：`,
    result.proposedFormula,
    result.explanation ? `說明：${result.explanation}` : "",
    blockers,
    warnings,
  ].filter(Boolean).join("\n");
}

function buildRollingSummary(
  existingSummary: string | null | undefined,
  messages: Array<{ role: string; content: string }>
): string {
  const head = existingSummary?.trim()
    ? [`既有摘要：${existingSummary.trim()}`]
    : ["本 thread 重點摘要："];
  const tail = messages.slice(-8).map((message) => {
    const speaker = message.role === "assistant" ? "AI" : "使用者";
    return `- ${speaker}: ${compactText(message.content, 180)}`;
  });
  return compactText([...head, ...tail].join("\n"), 2_000);
}

function buildKnowledgeCandidate(params: {
  kind: "chat-answer" | "formula-suggestion";
  userMessage: string;
  assistantText: string;
  intent: DevAiMessageIntent;
  context: DevAiThreadContext;
  sourceIds?: string[];
  dryRunAllowed?: boolean;
  blockers?: string[];
}): Record<string, unknown> {
  const keyPoints = [
    compactText(params.userMessage, 260),
    compactText(params.assistantText, 420),
  ].filter(Boolean);
  const tags = [
    "pending",
    params.kind === "formula-suggestion" ? "formula" : "chat",
    params.intent,
    params.context.formPath ? "definitions" : "",
  ].filter(Boolean);
  return {
    status: "pending",
    kind: params.kind,
    title: titleFromMessage(params.userMessage),
    summary: compactText(params.assistantText, 700),
    keyPoints,
    tags,
    context: params.context,
    sourceIds: params.sourceIds ?? [],
    dryRunAllowed: params.dryRunAllowed ?? null,
    blockers: params.blockers ?? [],
    note: "候選重點只供人工檢視；不會自動進入 RAG，需手動收錄範例才會寫入 approved knowledge。",
  };
}

export function createDevAiThreadService(
  deps: DevAiThreadServiceDeps = {}
): DevAiThreadService {
  const enabled = deps.enabled ?? env.DEV_AI_CONVERSATION_HISTORY_ENABLED;
  const threadListLimit = Math.max(1, deps.threadListLimit ?? env.DEV_AI_THREAD_LIST_LIMIT);
  const threadDetailMessageLimit = Math.max(
    1,
    deps.threadDetailMessageLimit ?? env.DEV_AI_THREAD_DETAIL_MESSAGE_LIMIT
  );
  const threadDetailArtifactLimit = Math.max(
    1,
    deps.threadDetailArtifactLimit ?? env.DEV_AI_THREAD_DETAIL_ARTIFACT_LIMIT
  );
  const threadContextMessages = Math.max(
    0,
    deps.threadContextMessages ?? env.DEV_AI_THREAD_CONTEXT_MESSAGES
  );
  const maxThreadsPerActor = Math.max(
    1,
    deps.maxThreadsPerActor ?? env.DEV_AI_MAX_THREADS_PER_ACTOR
  );
  const maxMessagesPerThread = Math.max(
    1,
    deps.maxMessagesPerThread ?? env.DEV_AI_MAX_MESSAGES_PER_THREAD
  );
  const maxArtifactsPerThread = Math.max(
    1,
    deps.maxArtifactsPerThread ?? env.DEV_AI_MAX_ARTIFACTS_PER_THREAD
  );
  const threadRetentionDays = Math.max(
    1,
    deps.threadRetentionDays ?? env.DEV_AI_THREAD_RETENTION_DAYS
  );
  const archivedThreadRetentionDays = Math.max(
    1,
    deps.archivedThreadRetentionDays ?? env.DEV_AI_ARCHIVED_THREAD_RETENTION_DAYS
  );
  const repository = deps.repository ?? devAiThreadRepository;
  const chatService = deps.chatService ?? devAiChatService;
  const definitionsService = deps.definitionsService ?? ragicDefinitionsReadService;
  const formulaService = deps.formulaService ?? ragicFormulaAiSuggestionService;
  const now = deps.now ?? (() => new Date());
  const summaryEnabled = deps.summaryEnabled ?? env.DEV_AI_THREAD_SUMMARY_ENABLED;
  const summaryAfterMessages = Math.max(
    2,
    deps.summaryAfterMessages ?? env.DEV_AI_THREAD_SUMMARY_AFTER_MESSAGES
  );
  const messageQueue = createKeyedSerialQueue();

  const service: DevAiThreadService = {
    async createThread(ownerActor, request = {}) {
      ensureEnabled(enabled);
      const actor = ensureActor(ownerActor);
      const createdAt = now().toISOString();
      return repository.createThread({
        ownerActor: actor,
        title: compactText(request.title, 80) || DEFAULT_DEV_AI_THREAD_TITLE,
        mode: normalizeMode(request.mode),
        context: normalizeContext(request.context),
        now: createdAt,
      });
    },

    async listThreads(ownerActor) {
      ensureEnabled(enabled);
      const actor = ensureActor(ownerActor);
      await pruneActor(actor, now().toISOString());
      return repository.listThreads(actor, threadListLimit);
    },

    async getThreadDetail(ownerActor, threadId) {
      ensureEnabled(enabled);
      const actor = ensureActor(ownerActor);
      const thread = await repository.getThread(actor, threadId);
      if (!thread) throw new HttpError(404, "找不到 Dev AI 對話", "DEV_AI_THREAD_NOT_FOUND");
      ensureActiveThread(thread);
      return {
        thread,
        messages: await repository.listMessages(actor, threadId, threadDetailMessageLimit),
        artifacts: await repository.listArtifacts(actor, threadId, threadDetailArtifactLimit),
        summaryUsed: Boolean(thread.summary),
      };
    },

    async sendMessage(ownerActor, threadId, request, options = {}) {
      ensureEnabled(enabled);
      const actor = ensureActor(ownerActor);
      const message = compactText(request.message, 8_000);
      if (!message) throw new HttpError(400, "缺少 message", "DEV_AI_THREAD_MESSAGE_REQUIRED");
      const thread = await repository.getThread(actor, threadId);
      if (!thread) throw new HttpError(404, "找不到 Dev AI 對話", "DEV_AI_THREAD_NOT_FOUND");

      const sentAt = now().toISOString();
      let context = mergeContext(normalizeContext(thread.context), request.context);
      const history = (
        await repository.listMessages(actor, threadId, Math.max(threadContextMessages, 40))
      ).filter((item) => item.status === "completed");
      const lastUserMessage = [...history].reverse().find((item) => item.role === "user");
      const suppliedPaths = formPathsFromQuestion(message);
      if (suppliedPaths.length > 1) {
        throw new HttpError(
          400,
          "本次提供了多張表單，請先指定要查看哪一張，或分開提問。",
          "DEV_AI_FORM_AMBIGUOUS"
        );
      }
      const requestIncludesFormPath =
        typeof request.context === "object" &&
        request.context !== null &&
        "formPath" in request.context;
      const previousPaths = !requestIncludesFormPath && !context.formPath && suppliedPaths.length === 0
        && lastUserMessage && isFormPathOnly(lastUserMessage.content)
        && (asksAboutForm(message) || isContextualFormFollowUp(message))
        ? formPathsFromQuestion(lastUserMessage.content)
        : undefined;
      const paths = suppliedPaths.length ? suppliedPaths : previousPaths;
      if (paths?.length === 1 && paths[0] !== context.formPath) {
        context = mergeContext(context, { formPath: paths[0] });
      }
      let formClarification: { formNumber: string; candidates: Array<{ formPath: string; formName: string }> } | undefined;
      if (!suppliedPaths.length) {
        const numbers = formNumbersFromQuestion(message);
        if (numbers.length > 1) throw new HttpError(400, "本次提到多張表單，請分開提問。", "DEV_AI_FORM_AMBIGUOUS");
        if (numbers.length === 1) {
          const listing = await definitionsService.listForms({ limit: 200 }).catch(() => {
            throw new HttpError(503, "Demo 表單目錄目前無法讀取，請稍後再試。", "DEV_AI_FORM_CATALOG_UNAVAILABLE");
          });
          if (listing.meta.truncated) throw new HttpError(503, "表單目錄未完整載入，請提供完整表單路徑。", "DEV_AI_FORM_CATALOG_INCOMPLETE");
          const candidates = listing.data.filter((form) => form.formPath.split("/").at(-1) === numbers[0]);
          if (!candidates.length) throw new HttpError(404, `Demo 找不到編號 ${numbers[0]} 的表單，請確認編號。`, "DEV_AI_FORM_NOT_FOUND");
          if (candidates.length > 1) {
            context = mergeContext(context, { formPath: null });
            formClarification = { formNumber: numbers[0], candidates: candidates.map(({ formPath, formName }) => ({ formPath, formName })) };
          } else context = mergeContext(context, { formPath: candidates[0].formPath });
        }
      }
      const intent = formClarification || suppliedPaths.length || formNumbersFromQuestion(message).length
        ? "definitions" : inferIntent(request, thread.mode, context);

      const recent = threadContextMessages > 0
        ? history.slice(-threadContextMessages)
            .map((item) => ({ role: item.role, content: item.content }))
        : [];
      const previousQuestionForForm = context.formPath
        ? [...history].reverse().find((item) => item.role === "user" && !isFormPathOnly(item.content)
          && (item.metadata.retrievalFormPath === context.formPath
            || formPathsFromQuestion(item.content).includes(context.formPath!)))?.content
        : undefined;
      const priorFormQuestion = isFormPathOnly(message) && context.formPath
        ? previousQuestionForForm
        : undefined;
      const earlierFormQuestion = context.formPath && isContextualFormFollowUp(message)
        ? previousQuestionForForm : undefined;
      const retrievalQuery = priorFormQuestion ?? (earlierFormQuestion ? `${earlierFormQuestion}\n${message}` : undefined);
      const clarifySync = Boolean(context.formPath && /同步|沒更新|未更新/.test(message)
        && !/WO-\d+|entry\s*id|紀錄\s*id|工令\s*(?:號|編號)?\s*[:：#]?\s*[A-Za-z]*-?\d{4,}|欄位.{0,20}(?:從|由).{0,20}(?:改成|變成)/i.test(message)
        && recent.some((item) => item.role === "user" && asksAboutForm(item.content)));
      const formRelated = Boolean(formClarification || suppliedPaths.length || formNumbersFromQuestion(message).length
        || requestIncludesFormPath || asksAboutForm(message)
        || (context.formPath && isContextualFormFollowUp(message))
        || (context.fieldId && /欄位|公式|此欄/.test(message)));
      const summaryPrefix = thread.summary
        ? `以下是同一個 Dev AI thread 的摘要，僅作為目前回答的 thread-local memory；不要把它當成全域 RAG knowledge：\n${thread.summary}\n\n`
        : "";
      const memoryPrefix = `${summaryPrefix}${buildThreadMemoryPrefix(recent)}`;

      if (intent === "formula") {
        const { formPath, fieldId, position, sourceLine, formulaKind } = context;
        if (!formPath || !fieldId || !formulaKind) {
          throw new HttpError(
            400,
            "公式需求需要先選取 definitions 公式欄位",
            "DEV_AI_FORMULA_CONTEXT_REQUIRED"
          );
        }
        const formula = await formulaService.suggestFormula(
          {
            formPath,
            fieldId,
            ...(position ? { position } : {}),
            ...(sourceLine ? { sourceLine } : {}),
            formulaKind,
            objective: message,
            includeSiblings: true,
            includeSimilarFormulas: true,
          },
          {
            actor,
            clientId: options.clientId,
            tabId: options.tabId,
            signal: options.signal,
          }
        );
        const answeredAt = now().toISOString();
        const userMessage = await repository.appendMessage({
          threadId,
          ownerActor: actor,
          role: "user",
          content: maskSecrets(message),
          intent,
          now: sentAt,
          metadata: { mode: normalizeMode(request.mode ?? thread.mode), context },
        });
        const assistantText = buildFormulaAssistantText(formula);
        const assistantMessage = await repository.appendMessage({
          threadId,
          ownerActor: actor,
          role: "assistant",
          content: maskSecrets(assistantText),
          intent: "formula",
          model: formula.model,
          now: answeredAt,
          metadata: {
            suggestionId: formula.suggestionId,
            answerFormat: "plain",
            contextPreview: formula.contextPreview,
          },
        });
        const formulaArtifact = await repository.appendArtifact({
          threadId,
          messageId: assistantMessage.id,
          type: "formula-suggestion",
          payload: formula as unknown as Record<string, unknown>,
          now: answeredAt,
        });
        const dryRunArtifact = await repository.appendArtifact({
          threadId,
          messageId: assistantMessage.id,
          type: "dry-run",
          payload: formula.dryRun as unknown as Record<string, unknown>,
          now: answeredAt,
        });
        const candidateArtifact = await repository.appendArtifact({
          threadId,
          messageId: assistantMessage.id,
          type: "knowledge-candidate",
          payload: buildKnowledgeCandidate({
            kind: "formula-suggestion",
            userMessage: message,
            assistantText,
            intent,
            context,
            sourceIds: formula.referencedFields.map((field) => field.fieldId),
            dryRunAllowed: formula.dryRun.allowed,
            blockers: formula.dryRun.blockers,
          }),
          now: answeredAt,
        });
        const updatedThread = await repository.updateThreadAfterMessage({
          ownerActor: actor,
          threadId,
          preview: compactText(message, 120),
          updatedAt: answeredAt,
          ...(shouldApplyGeneratedDevAiThreadTitle(thread.title) && formula.threadTitle
            ? { title: formula.threadTitle }
            : {}),
          context,
        });
        const nextThread = await maybeUpdateSummary(
          actor,
          threadId,
          updatedThread ?? thread,
          answeredAt,
          assistantMessage.id
        );
        await pruneAfterMutation(actor, threadId, answeredAt);
        log.info({
          event: "thread-message-created",
          threadId,
          actor,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          model: formula.model,
          intent,
        });
        return {
          thread: nextThread ?? updatedThread ?? thread,
          userMessage,
          assistantMessage,
          artifacts: [formulaArtifact, dryRunArtifact, candidateArtifact],
          intent,
          formula,
          summaryUsed: Boolean(thread.summary),
        };
      }

      const chat = await chatService.ask(
        {
          question: message,
          ...(retrievalQuery ? { retrievalQuery } : {}),
          ...(formClarification ? { formClarification } : {}),
          ...(clarifySync ? { clarifySync: true } : {}),
          ...(memoryPrefix.trim() ? { conversationContext: memoryPrefix.trim() } : {}),
          mode: intent === "definitions" && formRelated ? "definitions" : "general",
          speedMode: request.speedMode ?? "fast",
          ...(context.formPath && formRelated
            ? { formPath: context.formPath } : {}),
          ...(context.fieldId && formRelated ? { fieldId: context.fieldId } : {}),
          includeKnowledge: request.includeKnowledge !== false,
          includeDefinitions: formRelated && (request.includeDefinitions === true || intent === "definitions"),
          maxSources: request.speedMode === "deep" ? 10 : request.speedMode === "balanced" ? 8 : 6,
        },
        {
          actor,
          clientId: options.clientId,
          tabId: options.tabId,
          signal: options.signal,
          previousUserQuestions: recent
            .filter((item) => item.role === "user")
            .map((item) => item.content),
        }
      );

      const answeredAt = now().toISOString();
      const userMessage = await repository.appendMessage({
        threadId,
        ownerActor: actor,
        role: "user",
        content: maskSecrets(message),
        intent,
        now: sentAt,
        metadata: { mode: normalizeMode(request.mode ?? thread.mode), context,
          ...(context.formPath && formRelated ? { retrievalFormPath: context.formPath } : {}),
          ...(retrievalQuery ? { retrievalQuery: maskSecrets(retrievalQuery) } : {}) },
      });
      const assistantMessage = await repository.appendMessage({
        threadId,
        ownerActor: actor,
        role: "assistant",
        content: maskSecrets(chat.answer),
        intent: chat.mode === "definitions" ? "definitions" : "general",
        model: chat.model,
        now: answeredAt,
        metadata: {
          chatId: chat.chatId,
          answerFormat: chat.answerFormat ?? "markdown",
          speedMode: chat.speedMode,
          contextPreview: chat.contextPreview,
          providerAttempts: chat.providerAttempts,
          outputFallbackApplied: chat.outputFallbackApplied,
          outputTokenLimit: chat.outputTokenLimit,
        },
      });
      const artifact = await repository.appendArtifact({
        threadId,
        messageId: assistantMessage.id,
        type: "chat-result",
        payload: {
          contextSources: chat.contextSources,
          citedEvidence: chat.citedEvidence,
          sources: chat.citedEvidence,
          assumptions: chat.assumptions,
          followUps: chat.followUps,
          contextPreview: chat.contextPreview,
          providerAttempts: chat.providerAttempts,
          outputFallbackApplied: chat.outputFallbackApplied,
          outputTokenLimit: chat.outputTokenLimit,
        },
        now: answeredAt,
      });
      const candidateArtifact = await repository.appendArtifact({
        threadId,
        messageId: assistantMessage.id,
        type: "knowledge-candidate",
        payload: buildKnowledgeCandidate({
          kind: "chat-answer",
          userMessage: message,
          assistantText: chat.answer,
          intent: chat.mode === "definitions" ? "definitions" : "general",
          context,
          sourceIds: chat.citedEvidence.map((source) => source.sourceId),
        }),
        now: answeredAt,
      });
      const updatedThread = await repository.updateThreadAfterMessage({
        ownerActor: actor,
        threadId,
        preview: compactText(message, 120),
        updatedAt: answeredAt,
        ...(shouldApplyGeneratedDevAiThreadTitle(thread.title) && chat.threadTitle
          ? { title: chat.threadTitle }
          : {}),
        context,
      });
      const nextThread = await maybeUpdateSummary(
        actor,
        threadId,
        updatedThread ?? thread,
        answeredAt,
        assistantMessage.id
      );
      await pruneAfterMutation(actor, threadId, answeredAt);

      log.info({
        event: "thread-message-created",
        threadId,
        actor,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        model: chat.model,
        intent,
      });

      return {
        thread: nextThread ?? updatedThread ?? thread,
        userMessage,
        assistantMessage,
        artifacts: [artifact, candidateArtifact],
        intent,
        chat,
        summaryUsed: Boolean(thread.summary),
      };
    },

    async archiveThread(ownerActor, threadId) {
      ensureEnabled(enabled);
      const actor = ensureActor(ownerActor);
      let archived: DevAiThread | null = null;
      await messageQueue.enqueue(
        JSON.stringify([actor, threadId]),
        async () => {
          archived = await repository.archiveThread(actor, threadId, now().toISOString());
          if (!archived) {
            throw new HttpError(404, "找不到 Dev AI 對話", "DEV_AI_THREAD_NOT_FOUND");
          }
        }
      );
      if (!archived) throw new HttpError(404, "找不到 Dev AI 對話", "DEV_AI_THREAD_NOT_FOUND");
      return archived;
    },
  };

  const executeSendMessage = service.sendMessage.bind(service);
  service.sendMessage = async (ownerActor, threadId, request, options = {}) => {
    ensureEnabled(enabled);
    const actor = ensureActor(ownerActor);
    const clientMessageId = ensureClientMessageId(request.clientMessageId);
    const normalizedMessage = compactText(request.message, 8_000);
    if (!normalizedMessage) {
      throw new HttpError(400, "缺少 message", "DEV_AI_THREAD_MESSAGE_REQUIRED");
    }
    const requestFingerprint = createStableJsonFingerprint({
      message: normalizedMessage,
      mode: request.mode,
      speedMode: request.speedMode,
      context: normalizeContext(request.context),
      includeKnowledge: request.includeKnowledge,
      includeDefinitions: request.includeDefinitions,
    });
    let result: DevAiSendMessageResult | undefined;
    await messageQueue.enqueue(
      JSON.stringify([actor, threadId]),
      async () => {
        const thread = await repository.getThread(actor, threadId);
        if (!thread) {
          throw new HttpError(404, "找不到 Dev AI 對話", "DEV_AI_THREAD_NOT_FOUND");
        }
        ensureActiveThread(thread);
        const existing = await repository.getMessageRequest({
          ownerActor: actor,
          threadId,
          clientMessageId,
        });
        if (existing && existing.requestFingerprint !== requestFingerprint) {
          throw new HttpError(
            409,
            "相同 clientMessageId 已用於不同訊息內容",
            "DEV_AI_CLIENT_MESSAGE_ID_CONFLICT"
          );
        }
        if (existing?.status === "completed") {
          if (!existing.result) {
            throw new HttpError(
              500,
              "既有 Dev AI 訊息結果無法讀取",
              "DEV_AI_MESSAGE_RESULT_INVALID"
            );
          }
          result = existing.result;
          return;
        }
        if (existing?.status === "pending") {
          const pendingAtMs = Date.parse(existing.updatedAt);
          if (
            Number.isFinite(pendingAtMs) &&
            now().getTime() - pendingAtMs < PENDING_REQUEST_STALE_MS
          ) {
            throw new HttpError(
              409,
              "這則 Dev AI 訊息仍在處理中",
              "DEV_AI_MESSAGE_REQUEST_IN_PROGRESS"
            );
          }
        }

        const startedAt = now().toISOString();
        await repository.startMessageRequest({
          ownerActor: actor,
          threadId,
          clientMessageId,
          requestFingerprint,
          now: startedAt,
        });
        try {
          result = await executeSendMessage(actor, threadId, request, options);
        } catch (error) {
          try {
            await repository.failMessageRequest({
              ownerActor: actor,
              threadId,
              clientMessageId,
              requestFingerprint,
              errorCode: messageRequestErrorCode(error),
              now: now().toISOString(),
            });
          } catch (persistError) {
            log.warn({
              event: "thread-message-request-failure-persist-failed",
              actor,
              threadId,
              clientMessageId,
              error: persistError instanceof Error ? persistError.message : String(persistError),
            });
          }
          throw error;
        }
        await repository.completeMessageRequest({
          ownerActor: actor,
          threadId,
          clientMessageId,
          requestFingerprint,
          result,
          now: now().toISOString(),
        });
      },
      { signal: options.signal }
    );
    if (!result) {
      throw new HttpError(
        500,
        "Dev AI 訊息結果遺失",
        "DEV_AI_MESSAGE_RESULT_MISSING"
      );
    }
    return result;
  };

  return service;

  async function pruneActor(actor: string, currentTime: string): Promise<void> {
    await repository.pruneActorThreads({
      ownerActor: actor,
      now: currentTime,
      maxThreads: maxThreadsPerActor,
      activeRetentionDays: threadRetentionDays,
      archivedRetentionDays: archivedThreadRetentionDays,
    });
  }

  async function pruneAfterMutation(
    actor: string,
    threadId: string,
    currentTime: string
  ): Promise<void> {
    await repository.pruneThreadItems({
      ownerActor: actor,
      threadId,
      maxMessages: maxMessagesPerThread,
      maxArtifacts: maxArtifactsPerThread,
    });
    await pruneActor(actor, currentTime);
  }

  async function maybeUpdateSummary(
    actor: string,
    threadId: string,
    currentThread: DevAiThread,
    updatedAt: string,
    lastMessageId: string
  ): Promise<DevAiThread | null> {
    if (!summaryEnabled) return null;
    const messages = await repository.listMessages(actor, threadId, summaryAfterMessages + 1);
    if (messages.length < summaryAfterMessages) return null;
    if (currentThread.summaryMessageId === lastMessageId) return null;
    const summary = buildRollingSummary(
      currentThread.summary,
      messages.map((item) => ({ role: item.role, content: item.content }))
    );
    return repository.updateThreadSummary({
      ownerActor: actor,
      threadId,
      summary,
      summaryUpdatedAt: updatedAt,
      summaryMessageId: lastMessageId,
    });
  }
}

export const devAiThreadService = createDevAiThreadService();
