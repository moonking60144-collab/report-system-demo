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
}

export interface DevAiChatServiceDeps {
  config?: Partial<DevAiChatRuntimeConfig>;
  providerClient?: DevAiJsonProvider;
  definitionsService?: Pick<RagicDefinitionsReadService, "search">;
  knowledgeService?: DevAiKnowledgeBaseService;
  chatIdFactory?: () => string;
  now?: () => number;
}

export interface DevAiChatService {
  ask(request: DevAiChatRequest, options?: DevAiChatOptions): Promise<DevAiChatResult>;
}

interface AiChatModelOutput {
  answer: string;
  assumptions: string[];
  followUps: string[];
  sourceIds: string[];
}

const CHAT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } },
    sourceIds: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "assumptions", "followUps", "sourceIds"],
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
    answer,
    assumptions: requireDevAiStringArray(object, "assumptions"),
    followUps: requireDevAiStringArray(object, "followUps"),
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

function outputTokensForSpeed(config: DevAiChatRuntimeConfig, speedMode: DevAiSpeedMode): number {
  if (speedMode === "fast") return Math.min(config.maxOutputTokens, 768);
  if (speedMode === "deep") return Math.max(config.maxOutputTokens, 1_536);
  return config.maxOutputTokens;
}

function contextCharsForSpeed(config: DevAiChatRuntimeConfig, speedMode: DevAiSpeedMode): number {
  if (speedMode === "fast") return Math.min(config.maxContextChars, 8_000);
  if (speedMode === "deep") return Math.max(config.maxContextChars, 24_000);
  return config.maxContextChars;
}

function trimContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 120))}\n...[context trimmed to ${maxChars} chars]`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function buildPrompt(params: {
  mode: DevAiChatMode;
  question: string;
  context: string;
  maxOutputTokens: number;
}): string {
  return [
    "你是 Funda Dev AI 助手，服務對象是內部開發與營運維護者。",
    "只輸出符合 schema 的 JSON；不要輸出 Markdown。",
    "回答必須優先依據提供的 Context。Context 不足時，請明確說目前本地知識不足，並列出需要補的資料，不要編造 Funda 公司事實。",
    "如果問題涉及 Ragic definitions、公式、欄位或 workflow，請引用 context 中的 sourceIds。",
    `回答請控制在 ${params.maxOutputTokens} tokens 以內。`,
    "",
    "Context:",
    params.context,
    "",
    "Mode:",
    params.mode,
    "",
    "User question:",
    params.question,
  ].join("\n");
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

function fieldIdFromQuestion(question: string): string {
  return question.match(
    /(?:\bfield\s*id\b|欄位\s*(?:id|編號))\s*[:：#]?\s*(\d{5,10})(?!\d)/i
  )?.[1] ?? "";
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
        log.warn({
          event: "knowledge-search-degraded",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const includeDefinitions = request.includeDefinitions === true || mode === "definitions" || Boolean(request.formPath);
    if (includeDefinitions) {
      try {
        const requestedFieldId = request.fieldId?.trim() || fieldIdFromQuestion(question);
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
        const mapped = result.data.map((item) =>
          compactDefinitionSource(item, result.meta.revision, score)
        );
        sources.push(...mapped);
      } catch {
        // definitions context 是輔助資料；失敗時讓模型明確看到 sources 不足即可。
      }
    }
    const deduped = Array.from(new Map(sources.map((source) => [source.sourceId, source])).values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSources);
    const context = trimContext(
      maskSecrets(JSON.stringify(deduped.map((source) => ({
        sourceId: source.sourceId,
        title: source.title,
        kind: source.kind,
        excerpt: source.excerpt,
        revision: source.revision,
        sourceType: source.sourceType,
        formPath: source.formPath,
        fieldId: source.fieldId,
      })), null, 2)),
      contextCharsForSpeed(config, normalizeSpeedMode(request.speedMode))
    );
    return {
      sources: deduped,
      context,
      preview: {
        knowledgeItems: deduped.filter((source) => source.kind === "curated" || source.kind === "official").length,
        definitionItems: deduped.filter((source) => source.kind === "definitions").length,
        chars: context.length,
      },
    };
  }

  return {
    async ask(request, options = {}) {
      assertEnabled();
      const question = request.question.trim();
      if (!question) throw new HttpError(400, "缺少 question", "MISSING_QUESTION");
      const mode = normalizeMode(request.mode);
      const speedMode = normalizeSpeedMode(request.speedMode);
      const release = claimRequestSlot();
      const chatId = chatIdFactory();
      const startedAt = now();
      try {
        const context = await collectSources(request, mode, options.signal);
        const model = modelForSpeed(config, speedMode);
        const maxOutputTokens = outputTokensForSpeed(config, speedMode);
        const client = getProviderClient();
        const prompt = buildPrompt({
          mode,
          question,
          context: context.context,
          maxOutputTokens,
        });
        const raw = await client.generateJsonText({
          prompt,
          schema: CHAT_SCHEMA,
          model,
          effort: effortForSpeed(config, speedMode),
          maxOutputTokens,
          storeInteraction: config.storeInteractions,
          signal: options.signal,
        });
        const output = normalizeModelOutput(raw);
        const sourceIds = new Set(output.sourceIds);
        const usedSources = sourceIds.size
          ? context.sources.filter((source) => sourceIds.has(source.sourceId))
          : context.sources;
        const result: DevAiChatResult = {
          chatId,
          provider: client.name,
          model,
          mode,
          speedMode,
          answer: output.answer,
          assumptions: output.assumptions,
          followUps: output.followUps,
          sources: usedSources,
          contextPreview: context.preview,
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
          sources: result.sources.length,
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
