import { randomUUID } from "node:crypto";
import { env } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import { HttpError } from "../../../utils/httpError";
import {
  ragicDefinitionsReadService,
  type RagicDefinitionsReadService,
} from "../ragicDefinitionsReadService";
import { maskSecrets } from "../ragicFormulaPatchDryRunService";
import type { DevAiEffort, DevAiJsonProvider } from "./devAiJsonProvider";
import {
  createDevAiJsonProvider,
  getDevAiProviderProfile,
  normalizeDevAiProviderName,
} from "./devAiProviderFactory";
import {
  parseDevAiJsonObject,
  requireDevAiString,
  requireDevAiStringArray,
} from "./devAiJsonValidation";
import {
  devAiKnowledgeBaseService,
  type DevAiKnowledgeBaseService,
} from "./devAiKnowledgeBaseService";
import { trimKnowledgeEvidence } from "./devAiKnowledgeEvidence";
import { formEvidence } from "./devAiFormEvidence";
import {
  asksAboutForm,
  asksForWorkflow,
  formPathsFromQuestion,
  normalizeExplicitFormPath,
} from "./devAiFormContext";
import {
  normalizeDevAiTraditionalText,
  normalizeGeneratedDevAiThreadTitle,
} from "./devAiThreadTitle";
import type {
  DevAiChatContextPreview,
  DevAiChatMode,
  DevAiChatRequest,
  DevAiChatResult,
  DevAiKnowledgeSource,
  DevAiSpeedMode,
  RagicDefinitionSearchItem,
} from "@shared-types/ragicDefinitions";

const log = createLogger("dev-ai-chat");

export interface DevAiChatRuntimeConfig {
  enabled: boolean;
  provider: string;
  model: string;
  fastModel: string;
  fastEffort: DevAiEffort;
  balancedEffort: DevAiEffort;
  deepEffort: DevAiEffort;
  maxContextChars: number;
  maxOutputTokens: number;
  maxConcurrentRequests: number;
  rateLimitPerMinute: number;
  storeInteractions: boolean;
  storeRawOutput: boolean;
}

export interface DevAiChatOptions {
  actor?: string | null;
  clientId?: string | null;
  tabId?: string | null;
  signal?: AbortSignal;
  previousUserQuestions?: string[];
}

export interface DevAiChatServiceDeps {
  config?: Partial<DevAiChatRuntimeConfig>;
  providerClient?: DevAiJsonProvider;
  definitionsService?: Pick<RagicDefinitionsReadService, "search"> &
    Partial<Pick<RagicDefinitionsReadService, "readForm">>;
  knowledgeService?: DevAiKnowledgeBaseService;
  chatIdFactory?: () => string;
  now?: () => number;
}

export interface DevAiChatService {
  ask(request: DevAiChatRequest, options?: DevAiChatOptions): Promise<DevAiChatResult>;
}

interface AiChatModelOutput {
  threadTitle: string;
  answer: string;
  assumptions: string[];
  followUps: string[];
  sourceIds: string[];
}

const CHAT_SCHEMA = {
  type: "object",
  properties: {
    threadTitle: { type: "string" },
    answer: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } },
    sourceIds: { type: "array", items: { type: "string" } },
  },
  required: ["threadTitle", "answer", "assumptions", "followUps", "sourceIds"],
};

function runtimeConfig(override: Partial<DevAiChatRuntimeConfig> = {}): DevAiChatRuntimeConfig {
  const provider = override.provider ?? env.DEV_AI_PROVIDER;
  const profile = getDevAiProviderProfile(provider);
  return {
    enabled: env.DEV_AI_ENABLED,
    provider,
    model: profile.model,
    fastModel: profile.fastModel,
    fastEffort: profile.fastEffort,
    balancedEffort: profile.balancedEffort,
    deepEffort: profile.deepEffort,
    maxContextChars: env.DEV_AI_CHAT_MAX_CONTEXT_CHARS,
    maxOutputTokens: profile.chatMaxOutputTokens,
    maxConcurrentRequests: env.DEV_AI_MAX_CONCURRENT_REQUESTS,
    rateLimitPerMinute: env.DEV_AI_SUGGEST_RATE_LIMIT_PER_MINUTE,
    storeInteractions: profile.storeInteractions,
    storeRawOutput: env.DEV_AI_STORE_RAW_OUTPUT,
    ...override,
  };
}

function normalizeModelOutput(raw: string): AiChatModelOutput {
  const object = parseDevAiJsonObject(raw);
  const answer = requireDevAiString(object, "answer");
  if (!answer) throw new HttpError(502, "AI provider 沒有回傳 answer", "DEV_AI_MISSING_ANSWER");
  return {
    threadTitle: normalizeGeneratedDevAiThreadTitle(object.threadTitle),
    answer: normalizeDevAiTraditionalText(answer),
    assumptions: requireDevAiStringArray(object, "assumptions").map(normalizeDevAiTraditionalText),
    followUps: requireDevAiStringArray(object, "followUps").map(normalizeDevAiTraditionalText),
    sourceIds: requireDevAiStringArray(object, "sourceIds"),
  };
}

function normalizeMode(value: unknown): DevAiChatMode {
  return value === "definitions" ? "definitions" : "general";
}

function normalizeSpeedMode(value: unknown): DevAiSpeedMode {
  if (value === "balanced" || value === "deep") return value;
  return "fast";
}

function modelForSpeed(config: DevAiChatRuntimeConfig, speedMode: DevAiSpeedMode): string {
  if (speedMode === "fast" && config.fastModel.trim()) return config.fastModel.trim();
  return config.model;
}

function effortForSpeed(
  config: DevAiChatRuntimeConfig,
  speedMode: DevAiSpeedMode
): DevAiEffort {
  if (speedMode === "fast") return config.fastEffort;
  if (speedMode === "deep") return config.deepEffort;
  return config.balancedEffort;
}

function technicalIdentityCount(question: string): number {
  return question.match(
    /(?:\/forms\d+\/\d+(?:\/\d+)?|\b\d{5,10}\b|\b[A-Z]{2,}[A-Z0-9-]*\d[A-Z0-9-]*\b)/g
  )?.length ?? 0;
}

function outputTokensForRequest(
  config: DevAiChatRuntimeConfig,
  speedMode: DevAiSpeedMode,
  question: string
): number {
  if (speedMode === "fast") {
    if (question.length >= 230) return Math.max(config.maxOutputTokens, 2_048);
    if (question.length >= 180 || technicalIdentityCount(question) >= 3) {
      return Math.max(config.maxOutputTokens, 1_536);
    }
    return config.maxOutputTokens;
  }
  if (speedMode === "deep") return Math.max(config.maxOutputTokens, 1_536);
  return config.maxOutputTokens;
}

function fallbackOutputTokens(
  config: DevAiChatRuntimeConfig,
  initialOutputTokens: number
): number {
  return Math.min(
    Math.max(config.maxOutputTokens, 2_048),
    Math.max(initialOutputTokens + 512, 1_536)
  );
}

function contextCharsForSpeed(config: DevAiChatRuntimeConfig, speedMode: DevAiSpeedMode): number {
  if (speedMode === "fast") return Math.min(config.maxContextChars, 8_000);
  if (speedMode === "deep") return Math.max(config.maxContextChars, 24_000);
  return config.maxContextChars;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const object = error as { code?: unknown; reasonCode?: unknown };
  if (typeof object.reasonCode === "string" && object.reasonCode) return object.reasonCode;
  return typeof object.code === "string" && object.code ? object.code : null;
}

function isOutputTruncatedError(error: unknown): boolean {
  return errorCode(error) === "DEV_AI_MINIMAX_OUTPUT_TRUNCATED";
}

function buildPrompt(params: {
  mode: DevAiChatMode;
  question: string;
  conversationContext?: string;
  context: string;
  definitionsStatus: DevAiChatContextPreview["definitionsStatus"];
  definitionsErrorCode: string | null;
  maxOutputTokens: number;
  requestTime: string;
  retryAfterTruncation?: boolean;
}): string {
  return [
    "你是開發與營運維護助手。",
    `伺服器請求時間（UTC）：${params.requestTime}。這是目前時間依據，不代表參考資料已在此時間重新查核。`,
    "只輸出符合 schema 的 JSON，不得在 JSON 外加上文字或 code fence；answer 字串可使用基本 Markdown。",
    "所有中文敘述必須使用繁體中文與台灣慣用詞；使用者以英文提問時可使用英文回答。",
    "threadTitle 請根據本次問題與回答產生 4 到 24 字的短標題，只能使用繁體中文或英文；不得使用簡體字、日文、韓文、emoji、引號或 Markdown。",
    "對話記憶只用於理解追問，不是已驗證 evidence；若與目前使用者訊息衝突，以目前訊息為準。",
    "回答必須優先依據提供的本次參考資料。資料不足時，請明確說明缺少什麼，不要編造公司事實、欄位、表單、流程或資料狀態。",
    "如果問題涉及 Ragic definitions、公式、欄位或 workflow，請引用 context 中的 sourceIds。",
    params.definitionsStatus === "unavailable"
      ? `Definitions 本次不可用（${params.definitionsErrorCode ?? "UNKNOWN"}）；不得宣稱已核對目前表單。`
      : params.definitionsStatus === "ready"
        ? "Definitions 本次已完成檢索；仍只能引用參考資料實際包含的內容。"
        : "本次未要求 definitions；不得宣稱已核對目前表單。",
    params.retryAfterTruncation
      ? "前一次輸出因 token 上限被截斷。本次請縮短敘述，優先輸出結論、必要證據、限制與下一個可驗證步驟。"
      : "回答優先輸出結論、必要證據、限制與下一個可驗證步驟。",
    `回答請控制在 ${params.maxOutputTokens} tokens 以內。`,
    "",
    "Thread-local conversation memory:",
    params.conversationContext?.trim() || "(none)",
    "",
    "本次參考資料:",
    params.context,
    "",
    "Mode:",
    params.mode,
    "",
    "Current user request:",
    params.question,
  ].join("\n");
}

function recallOffset(question: string): number | null {
  const normalized = question.trim().replace(/[？?。.!！]+$/, "").trim();
  if (
    /^(?:我(?:的)?\s*)?(?:上上個|倒數第二個)(?:問題|提問)(?:是)?(?:問(?:了)?什麼|什麼)$/.test(normalized) ||
    /^what (?:was|is) my (?:second-to-last|second previous) question$/i.test(normalized)
  ) return 2;
  if (
    /^(?:我(?:的)?\s*)?(?:上一個|前一個|上一題)(?:問題|提問)?(?:是)?(?:問(?:了)?什麼|什麼)$/.test(normalized) ||
    /^(?:我剛剛|剛剛我|我剛才|剛才我)(?:問(?:了)?什麼|的問題是什麼)$/.test(normalized) ||
    /^what (?:was|is) my (?:previous|last) question$/i.test(normalized) ||
    /^what did i (?:just|last) ask$/i.test(normalized)
  ) return 1;
  return null;
}

function compactDefinitionSource(
  item: RagicDefinitionSearchItem,
  revision: string | null,
  score: number
): DevAiKnowledgeSource {
  const idParts = [
    item.formPath,
    item.type,
    item.fieldId,
    item.position,
    item.formulaKind,
    item.workflowFileName,
  ]
    .filter(Boolean)
    .join(":");
  const excerpt = [
    item.formName ? `表單：${item.formName}` : "",
    item.fieldId ? `Field ID：${item.fieldId}` : "",
    item.fieldName ? `欄位：${item.fieldName}` : "",
    item.position ? `位置：${item.position}` : "",
    item.attrs ? `欄位設定：${JSON.stringify(item.attrs)}` : "",
    item.fieldReferences.length
      ? `關聯欄位：${item.fieldReferences.map((reference) => [
          `${reference.attribute}=${reference.fieldId}`,
          reference.formPath,
          reference.fieldName,
          reference.position,
        ].filter(Boolean).join(" / ")).join("；")}`
      : "",
    item.nuiFormula ? `公式：${item.nuiFormula}` : "",
    item.workflowFileName ? `Workflow：${item.workflowFileName}` : "",
    item.workflowExcerpt ? `Workflow 片段：${item.workflowExcerpt}` : "",
  ].filter(Boolean).join("；");
  const title = item.type === "workflow"
    ? `${item.formName || item.formPath} · ${item.workflowFileName || "workflow"}`
    : `${item.formName || item.formPath}${item.fieldName ? ` · ${item.fieldName}` : ""}`;
  return {
    sourceId: `definitions:${idParts}`,
    title,
    kind: "definitions",
    excerpt: maskSecrets(excerpt || JSON.stringify(item)),
    score,
    path: item.formPath,
    ...(revision ? { revision } : {}),
    sourceType: item.type,
    formPath: item.formPath,
    ...(item.fieldId ? { fieldId: item.fieldId } : {}),
  };
}

function contextSourcePayload(source: DevAiKnowledgeSource): Record<string, unknown> {
  return {
    sourceId: source.sourceId,
    title: source.title,
    kind: source.kind,
    excerpt: source.excerpt,
    ...(source.path ? { path: source.path } : {}),
    ...(source.revision ? { revision: source.revision } : {}),
    ...(source.formPath ? { formPath: source.formPath } : {}),
    ...(source.fieldId ? { fieldId: source.fieldId } : {}),
    ...(source.sourceType ? { sourceType: source.sourceType } : {}),
  };
}

function serializeContextSources(
  sources: DevAiKnowledgeSource[],
  maxChars: number,
  balance = false
): { context: string; sources: DevAiKnowledgeSource[]; trimmed: boolean } {
  const included: DevAiKnowledgeSource[] = [];
  const sanitized = sources.map((source) => {
    const excerpt = maskSecrets(source.excerpt);
    const { evidenceSpans, ...rest } = source;
    return {
      ...rest,
      title: maskSecrets(source.title),
      excerpt,
      ...(excerpt === source.excerpt && evidenceSpans ? { evidenceSpans } : {}),
      ...(source.path ? { path: maskSecrets(source.path) } : {}),
    };
  });
  const serialize = (items: DevAiKnowledgeSource[]) =>
    JSON.stringify(items.map(contextSourcePayload), null, 2);
  let trimmed = false;
  if (balance) {
    const ordered = [
      ...sanitized.filter((source) => source.kind === "official"),
      ...sanitized.filter((source) => source.kind !== "official"),
    ];
    let remaining = maxChars;
    for (const [index, source] of ordered.entries()) {
      const budget = source.kind === "official"
        ? remaining
        : Math.floor(remaining / (ordered.length - index));
      let candidate = source;
      if (serialize([source]).length > budget) {
        let low = 0;
        let high = source.excerpt.length;
        while (low < high) {
          const length = Math.ceil((low + high) / 2);
          if (serialize([trimKnowledgeEvidence(source, length)]).length <= budget) low = length;
          else high = length - 1;
        }
        candidate = trimKnowledgeEvidence(source, low);
        trimmed = true;
      }
      if (
        (candidate.excerpt.length < 80 && candidate.excerpt.length < source.excerpt.length) ||
        serialize([candidate]).length > budget
      ) {
        trimmed = true;
        continue;
      }
      included.push(candidate);
      remaining -= serialize([candidate]).length;
    }
    return { context: serialize(included), sources: included, trimmed };
  }
  for (const source of sanitized) {
    if (serialize([...included, source]).length <= maxChars) {
      included.push(source);
      continue;
    }
    let low = 0;
    let high = source.excerpt.length;
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      if (serialize([...included, trimKnowledgeEvidence(source, length)]).length <= maxChars) low = length;
      else high = length - 1;
    }
    if (low >= 80) included.push(trimKnowledgeEvidence(source, low));
    trimmed = true;
    break;
  }
  if (included.length < sanitized.length) trimmed = true;
  return { context: serialize(included), sources: included, trimmed };
}

function fieldIdFromQuestion(question: string): string {
  return question.match(
    /(?:\bfield\s*id\b|欄位\s*(?:id|編號))\s*[:：#]?\s*(\d{5,10})(?!\d)/i
  )?.[1] ?? "";
}

function shouldIncludeDefinitions(
  request: DevAiChatRequest,
  mode: DevAiChatMode
): boolean {
  if (mode === "definitions") return true;
  if (!request.formPath && !request.fieldId) return request.includeDefinitions === true;
  const question = request.question.trim();
  return asksAboutForm(question) || /\b[A-Z]\d{1,3}\b|此欄/i.test(question)
    || Boolean(request.fieldId && question.includes(request.fieldId));
}

export function createDevAiChatService(deps: DevAiChatServiceDeps = {}): DevAiChatService {
  const config = runtimeConfig(deps.config);
  let providerClient = deps.providerClient;
  const definitionsService = deps.definitionsService ?? ragicDefinitionsReadService;
  const knowledgeService = deps.knowledgeService ?? devAiKnowledgeBaseService;
  const chatIdFactory = deps.chatIdFactory ?? randomUUID;
  const now = deps.now ?? Date.now;
  const recentRequests: number[] = [];
  let activeRequests = 0;

  function assertEnabled(): void {
    if (!config.enabled) throw new HttpError(403, "Dev AI 未啟用", "DEV_AI_DISABLED");
    if (!normalizeDevAiProviderName(config.provider)) {
      throw new HttpError(400, "不支援的 Dev AI provider", "DEV_AI_BAD_PROVIDER");
    }
  }

  function getProviderClient(): DevAiJsonProvider {
    providerClient ??= createDevAiJsonProvider(config.provider);
    return providerClient;
  }

  function claimRequestSlot(): () => void {
    const current = now();
    while (recentRequests.length && current - recentRequests[0] > 60_000) recentRequests.shift();
    if (recentRequests.length >= config.rateLimitPerMinute) {
      throw new HttpError(429, "Dev AI 產生太頻繁，請稍後再試", "DEV_AI_RATE_LIMITED");
    }
    if (activeRequests >= config.maxConcurrentRequests) {
      throw new HttpError(429, "Dev AI 仍有產生作業執行中，請稍後再試", "DEV_AI_BUSY");
    }
    recentRequests.push(current);
    activeRequests += 1;
    return () => {
      activeRequests = Math.max(0, activeRequests - 1);
    };
  }

  async function collectSources(
    request: DevAiChatRequest,
    mode: DevAiChatMode,
    signal?: AbortSignal
  ): Promise<{ sources: DevAiKnowledgeSource[]; preview: DevAiChatContextPreview; context: string }> {
    const question = request.question.trim();
    const maxSources = Math.max(1, Math.min(12, Math.trunc(request.maxSources ?? 8)));
    const sources: DevAiKnowledgeSource[] = [];
    if (request.includeKnowledge !== false) {
      try {
        sources.push(...await knowledgeService.search({ query: question, maxItems: maxSources, signal }));
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof HttpError) throw error;
        log.warn({
          event: "knowledge-search-degraded",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const includeDefinitions = shouldIncludeDefinitions(request, mode);
    let definitionsStatus: NonNullable<DevAiChatContextPreview["definitionsStatus"]> =
      includeDefinitions ? "ready" : "not-requested";
    let definitionsErrorCode: string | null = null;
    if (includeDefinitions) {
      try {
        const requestedFieldId = request.fieldId?.trim() || fieldIdFromQuestion(question);
        if (request.formPath && !requestedFieldId && definitionsService.readForm) {
          sources.push(...formEvidence(await definitionsService.readForm(request.formPath), question));
        } else {
          let result = await definitionsService.search({
            ...(requestedFieldId ? { fieldId: requestedFieldId } : { q: question }),
            ...(request.formPath ? { formPath: request.formPath } : {}),
            type: "all",
            limit: maxSources,
          });
          let score = requestedFieldId ? 10 : request.formPath ? 8 : 5;
          if (!result.data.length && requestedFieldId) {
            result = await definitionsService.search({
              q: question,
              ...(request.formPath ? { formPath: request.formPath } : {}),
              type: "all",
              limit: maxSources,
            });
            score = request.formPath ? 8 : 5;
          }
          if (!result.data.length && request.formPath) {
            result = await definitionsService.search({
              formPath: request.formPath,
              type: "all",
              limit: maxSources,
            });
            score = 8;
          }
          sources.push(...result.data.map((item) =>
            compactDefinitionSource(item, result.meta.revision, score)
          ));
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        definitionsStatus = "unavailable";
        definitionsErrorCode = errorCode(error) ?? "DEFINITIONS_SEARCH_FAILED";
        log.warn({ event: "definitions-search-degraded", reason: definitionsErrorCode });
      }
    }
    const rankedSources = Array.from(
      new Map(sources.map((source) => [source.sourceId, source])).values()
    ).sort((a, b) => b.score - a.score);
    const official = asksForWorkflow(question)
      ? rankedSources.find((source) => source.sourceId === "official:ragic-workflow-es5")
        ?? rankedSources.find((source) => source.kind === "official")
      : rankedSources.find((source) => source.kind === "official");
    const reservedKnowledge = request.formPath && maxSources > 1 && official ? [official] : [];
    const reservedDefinitions = rankedSources
      .filter((source) => source.kind === "definitions")
      .slice(0, request.formPath ? maxSources - reservedKnowledge.length : Math.ceil(maxSources / 2));
    const workflow = request.formPath && asksForWorkflow(question)
      ? rankedSources.find((source) => source.kind === "definitions" && source.sourceType === "workflow")
      : undefined;
    if (workflow && reservedDefinitions.length && !reservedDefinitions.includes(workflow)) {
      reservedDefinitions[reservedDefinitions.length - 1] = workflow;
    }
    const reservedIds = new Set(
      [...reservedKnowledge, ...reservedDefinitions].map((source) => source.sourceId)
    );
    const deduped = [
      ...reservedKnowledge,
      ...reservedDefinitions,
      ...rankedSources.filter((source) => !reservedIds.has(source.sourceId)),
    ].slice(0, maxSources);
    const serialized = serializeContextSources(
      deduped,
      contextCharsForSpeed(config, normalizeSpeedMode(request.speedMode)),
      Boolean(request.formPath)
    );
    return {
      sources: serialized.sources,
      context: serialized.context,
      preview: {
        knowledgeItems: serialized.sources.filter((source) => source.kind === "curated" || source.kind === "official").length,
        definitionItems: serialized.sources.filter((source) => source.kind === "definitions").length,
        chars: serialized.context.length,
        definitionsStatus,
        definitionsErrorCode,
        trimmed: serialized.trimmed,
      },
    };
  }

  return {
    async ask(request, options = {}) {
      assertEnabled();
      if (request.formPath) {
        request = { ...request, formPath: normalizeExplicitFormPath(request.formPath) };
      }
      const suppliedPaths = formPathsFromQuestion(request.question);
      if (suppliedPaths.length > 1) {
        throw new HttpError(
          400,
          "本次提供了多張表單，請先指定要查看哪一張。",
          "DEV_AI_FORM_AMBIGUOUS"
        );
      }
      if (suppliedPaths.length === 1) {
        request = { ...request, formPath: suppliedPaths[0], includeDefinitions: true };
      }
      const question = request.question.trim();
      if (!question) throw new HttpError(400, "缺少 question", "MISSING_QUESTION");
      const mode = normalizeMode(request.mode);
      const speedMode = normalizeSpeedMode(request.speedMode);
      const release = claimRequestSlot();
      const chatId = chatIdFactory();
      const startedAt = now();
      try {
        const recall = recallOffset(question);
        if (recall) {
          const previousQuestion = options.previousUserQuestions?.at(-recall);
          return {
            chatId,
            provider: "local",
            model: "thread-memory",
            threadTitle: "對話問題回顧",
            mode,
            speedMode,
            answerFormat: "plain",
            answer: previousQuestion
              ? /^what/i.test(question)
                ? `Your ${recall === 2 ? "second-to-last" : "previous"} question was: ${maskSecrets(previousQuestion)}`
                : `你的${recall === 2 ? "上上個" : "上一個"}問題是：「${maskSecrets(previousQuestion)}」`
              : /^what/i.test(question)
                ? "There is not enough saved conversation history to identify that question."
                : "目前保存的對話記錄不足，無法確定你指的問題。",
            assumptions: [],
            followUps: [],
            contextSources: [],
            citedEvidence: [],
            sources: [],
            contextPreview: { knowledgeItems: 0, definitionItems: 0, chars: 0, trimmed: false },
            providerAttempts: 0,
            outputFallbackApplied: false,
            outputTokenLimit: 0,
            latencyMs: Math.max(0, now() - startedAt),
          };
        }
        const context = await collectSources(request, mode, options.signal);
        const model = modelForSpeed(config, speedMode);
        const initialOutputTokens = outputTokensForRequest(config, speedMode, question);
        const client = getProviderClient();
        let providerAttempts = 1;
        let outputFallbackApplied = false;
        let outputTokenLimit = initialOutputTokens;
        const generate = (maxOutputTokens: number, retryAfterTruncation = false) =>
          client.generateJsonText({
            prompt: buildPrompt({
              mode,
              question,
              conversationContext: request.conversationContext,
              context: context.context,
              definitionsStatus: context.preview.definitionsStatus,
              definitionsErrorCode: context.preview.definitionsErrorCode ?? null,
              maxOutputTokens,
              requestTime: new Date(startedAt).toISOString(),
              retryAfterTruncation,
            }),
            schema: CHAT_SCHEMA,
            model,
            effort: effortForSpeed(config, speedMode),
            maxOutputTokens,
            storeInteraction: config.storeInteractions,
            signal: options.signal,
          });
        let raw: string;
        try {
          raw = await generate(initialOutputTokens);
        } catch (error) {
          const fallbackTokens = fallbackOutputTokens(config, initialOutputTokens);
          if (!isOutputTruncatedError(error) || fallbackTokens <= initialOutputTokens) throw error;
          providerAttempts = 2;
          outputFallbackApplied = true;
          outputTokenLimit = fallbackTokens;
          log.warn({
            event: "chat-output-retry",
            chatId,
            provider: client.name,
            model,
            initialOutputTokens,
            fallbackOutputTokens: fallbackTokens,
          });
          raw = await generate(fallbackTokens, true);
        }
        const output = normalizeModelOutput(raw);
        const sourceIds = new Set(output.sourceIds);
        const citedEvidence = context.sources.filter((source) => sourceIds.has(source.sourceId));
        const result: DevAiChatResult = {
          chatId,
          provider: client.name,
          model,
          threadTitle: output.threadTitle,
          mode,
          speedMode,
          answer: output.answer,
          answerFormat: "markdown",
          assumptions: output.assumptions,
          followUps: output.followUps,
          contextSources: context.sources,
          citedEvidence,
          sources: citedEvidence,
          contextPreview: context.preview,
          providerAttempts,
          outputFallbackApplied,
          outputTokenLimit,
          latencyMs: Math.max(0, now() - startedAt),
        };
        log.info({
          event: "chat-created",
          chatId,
          actor: options.actor ?? null,
          clientId: options.clientId ?? null,
          tabId: options.tabId ?? null,
          mode,
          speedMode,
          provider: client.name,
          model,
          contextPreview: context.preview,
          contextSources: result.contextSources.length,
          citedEvidence: result.citedEvidence.length,
          rawOutputStored: config.storeRawOutput,
        });
        if (config.storeRawOutput) {
          log.debug({ event: "chat-raw-output", chatId, raw: maskSecrets(raw) });
        }
        return result;
      } finally {
        release();
      }
    },
  };
}

export const devAiChatService = createDevAiChatService();
