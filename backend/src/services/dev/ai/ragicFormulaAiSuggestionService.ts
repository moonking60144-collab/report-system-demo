import { randomUUID } from "node:crypto";
import { env } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import { HttpError } from "../../../utils/httpError";
import type { RagicFormulaPatchDryRunService } from "../ragicFormulaPatchDryRunService";
import {
  createRagicFormulaPatchDryRunService,
  maskSecrets,
} from "../ragicFormulaPatchDryRunService";
import { tokenizeFormula } from "../ragicFormulaPositionTranslator";
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
  createRagicFormulaAiContextBuilder,
  type RagicFormulaAiContextBuilder,
} from "./ragicFormulaAiContextBuilder";
import type {
  RagicFormulaAiConfidence,
  RagicFormulaAiReferencedField,
  RagicFormulaAiSuggestRequest,
  RagicFormulaAiSuggestResult,
  RagicFormulaPatchDryRunResult,
} from "@shared-types/ragicDefinitions";

const log = createLogger("dev-ai-formula");

export interface RagicFormulaAiRuntimeConfig {
  enabled: boolean;
  provider: string;
  model: string;
  effort: DevAiEffort;
  maxOutputTokens: number;
  maxConcurrentRequests: number;
  suggestRateLimitPerMinute: number;
  storeInteractions: boolean;
  storeRawOutput: boolean;
}

export interface RagicFormulaAiSuggestionServiceDeps {
  config?: Partial<RagicFormulaAiRuntimeConfig>;
  providerClient?: DevAiJsonProvider;
  contextBuilder?: RagicFormulaAiContextBuilder;
  dryRunService?: RagicFormulaPatchDryRunService;
  suggestionIdFactory?: () => string;
  now?: () => number;
}

export interface RagicFormulaAiSuggestOptions {
  actor?: string | null;
  clientId?: string | null;
  tabId?: string | null;
  signal?: AbortSignal;
}

export interface RagicFormulaAiSuggestionService {
  suggestFormula(
    request: RagicFormulaAiSuggestRequest,
    options?: RagicFormulaAiSuggestOptions
  ): Promise<RagicFormulaAiSuggestResult>;
}

interface AiFormulaModelOutput {
  proposedFormula: string;
  explanation: string;
  assumptions: string[];
  referencedFields: RagicFormulaAiReferencedField[];
  risks: string[];
  confidence: RagicFormulaAiConfidence;
}

const FORMULA_SUGGESTION_SCHEMA = {
  type: "object",
  properties: {
    proposedFormula: { type: "string" },
    explanation: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    referencedFields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fieldId: { type: "string" },
          position: { type: "string" },
          name: { type: "string" },
          reason: { type: "string" },
        },
        required: ["fieldId", "position", "name", "reason"],
      },
    },
    risks: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "proposedFormula",
    "explanation",
    "assumptions",
    "referencedFields",
    "risks",
    "confidence",
  ],
};

function runtimeConfig(
  override: Partial<RagicFormulaAiRuntimeConfig> = {}
): RagicFormulaAiRuntimeConfig {
  const provider = override.provider ?? env.DEV_AI_PROVIDER;
  const profile = getDevAiProviderProfile(provider);
  return {
    enabled: env.DEV_AI_ENABLED,
    provider,
    model: profile.model,
    effort: profile.deepEffort,
    maxOutputTokens: profile.maxOutputTokens,
    maxConcurrentRequests: env.DEV_AI_MAX_CONCURRENT_REQUESTS,
    suggestRateLimitPerMinute: env.DEV_AI_SUGGEST_RATE_LIMIT_PER_MINUTE,
    storeInteractions: profile.storeInteractions,
    storeRawOutput: env.DEV_AI_STORE_RAW_OUTPUT,
    ...override,
  };
}

function normalizeModelOutput(raw: string): AiFormulaModelOutput {
  const object = parseDevAiJsonObject(raw);
  const proposedFormula = requireDevAiString(object, "proposedFormula");
  if (!proposedFormula) {
    throw new HttpError(502, "AI provider 沒有回傳 proposedFormula", "DEV_AI_MISSING_FORMULA");
  }
  if (
    object.confidence !== "low" &&
    object.confidence !== "medium" &&
    object.confidence !== "high"
  ) {
    throw new HttpError(502, "AI provider 回傳欄位 confidence 無效", "DEV_AI_BAD_JSON");
  }
  if (!Array.isArray(object.referencedFields)) {
    throw new HttpError(
      502,
      "AI provider 回傳欄位 referencedFields 不是陣列",
      "DEV_AI_BAD_JSON"
    );
  }
  const referencedFields = object.referencedFields.flatMap(
    (item): RagicFormulaAiReferencedField[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new HttpError(
          502,
          "AI provider 回傳 referencedFields 項目不是物件",
          "DEV_AI_BAD_JSON"
        );
      }
      const entry = item as Record<string, unknown>;
      const field = {
        fieldId: requireDevAiString(entry, "fieldId"),
        position: requireDevAiString(entry, "position"),
        name: requireDevAiString(entry, "name"),
        reason: requireDevAiString(entry, "reason"),
      };
      return field.fieldId || field.position || field.name ? [field] : [];
    }
  );
  return {
    proposedFormula,
    explanation: requireDevAiString(object, "explanation"),
    assumptions: requireDevAiStringArray(object, "assumptions"),
    referencedFields,
    risks: requireDevAiStringArray(object, "risks"),
    confidence: object.confidence,
  };
}

function buildPrompt(params: {
  request: RagicFormulaAiSuggestRequest;
  promptContext: string;
  maxOutputTokens: number;
}): string {
  return [
    "你是 Ragic 公式助手。你只能產生公式草案，不可以要求系統直接套用。",
    "只輸出符合 schema 的 JSON；不要輸出 Markdown。",
    "proposedFormula 必須是單行 Ragic .nui 公式字串。",
    "只能使用 context 內存在的欄位 position / fieldId；不確定就寫進 assumptions / risks。",
    "不要發明替代欄位，也不要把「欄位不存在」誤寫成 ISBLANK(猜測位置)；欄位不存在與欄位值空白是不同情境。",
    "如果需求需要的欄位不在 context 內，請保守說明限制與風險，公式只能使用已知欄位。",
    `輸出請控制在 ${params.maxOutputTokens} tokens 以內。`,
    "",
    "目標：",
    JSON.stringify({
      formPath: params.request.formPath,
      fieldId: params.request.fieldId,
      formulaKind: params.request.formulaKind,
    }, null, 2),
    "",
    "Definitions context：",
    params.promptContext,
    "",
    "使用者需求：",
    params.request.objective.trim(),
    params.request.userNotes?.trim()
      ? `\n補充說明：\n${params.request.userNotes.trim()}`
      : "",
  ].filter(Boolean).join("\n");
}

function missingFormulaRefs(formula: string, knownPositions: Set<string>): string[] {
  const missing = new Set<string>();
  for (const token of tokenizeFormula(formula)) {
    if (token.isCellRef && !knownPositions.has(token.text)) {
      missing.add(token.text);
    }
  }
  return [...missing];
}

function withAiValidationBlockers(
  dryRun: RagicFormulaPatchDryRunResult,
  blockers: string[]
): RagicFormulaPatchDryRunResult {
  return blockers.length
    ? { ...dryRun, allowed: false, blockers: [...dryRun.blockers, ...blockers] }
    : dryRun;
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function confidenceAfterDryRun(
  modelConfidence: RagicFormulaAiConfidence,
  dryRun: RagicFormulaPatchDryRunResult
): RagicFormulaAiConfidence {
  if (!dryRun.allowed || dryRun.blockers.length > 0) {
    return "low";
  }
  if (modelConfidence === "high" && dryRun.warnings.length > 0) {
    return "medium";
  }
  return modelConfidence;
}

function dryRunRisks(dryRun: RagicFormulaPatchDryRunResult): string[] {
  return [
    ...dryRun.blockers.map((blocker) => `Dry-run 阻擋：${blocker}`),
    ...dryRun.warnings.map((warning) => `Dry-run 警告：${warning}`),
  ];
}

export function createRagicFormulaAiSuggestionService(
  deps: RagicFormulaAiSuggestionServiceDeps = {}
): RagicFormulaAiSuggestionService {
  const config = runtimeConfig(deps.config);
  let providerClient = deps.providerClient;
  const contextBuilder = deps.contextBuilder ?? createRagicFormulaAiContextBuilder();
  const dryRunService = deps.dryRunService ?? createRagicFormulaPatchDryRunService();
  const suggestionIdFactory = deps.suggestionIdFactory ?? randomUUID;
  const now = deps.now ?? Date.now;
  const recentRequests: number[] = [];
  let activeRequests = 0;

  function assertEnabled(): void {
    if (!config.enabled) {
      throw new HttpError(403, "Dev AI 未啟用", "DEV_AI_DISABLED");
    }
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
    while (recentRequests.length && current - recentRequests[0] > 60_000) {
      recentRequests.shift();
    }
    if (recentRequests.length >= config.suggestRateLimitPerMinute) {
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

  return {
    async suggestFormula(request, options = {}) {
      assertEnabled();
      const release = claimRequestSlot();
      const suggestionId = suggestionIdFactory();
      try {
        const context = await contextBuilder.buildContext(request, {
          signal: options.signal,
        });
        const prompt = buildPrompt({
          request,
          promptContext: context.promptContext,
          maxOutputTokens: config.maxOutputTokens,
        });
        const client = getProviderClient();
        const raw = await client.generateJsonText({
          prompt,
          schema: FORMULA_SUGGESTION_SCHEMA,
          model: config.model,
          effort: config.effort,
          maxOutputTokens: config.maxOutputTokens,
          storeInteraction: config.storeInteractions,
          signal: options.signal,
        });
        const modelOutput = normalizeModelOutput(raw);

        const invalidReferencedFieldIds = modelOutput.referencedFields
          .map((field) => field.fieldId)
          .filter((fieldId) => fieldId && !context.fieldsById.has(fieldId));
        const missingRefs = missingFormulaRefs(modelOutput.proposedFormula, context.positions);
        const aiBlockers = [
          invalidReferencedFieldIds.length
            ? `AI 引用不存在欄位 ID：${[...new Set(invalidReferencedFieldIds)].join(", ")}`
            : null,
          missingRefs.length
            ? `AI 公式引用目前表單不存在的位置：${missingRefs.join(", ")}`
            : null,
        ].filter((item): item is string => Boolean(item));

        const dryRun = await dryRunService.dryRunFormulaPatch({
          formPath: request.formPath,
          fieldId: request.fieldId,
          formulaKind: request.formulaKind,
          newFormula: modelOutput.proposedFormula,
        });
        const finalDryRun = withAiValidationBlockers(dryRun, aiBlockers);
        const result: RagicFormulaAiSuggestResult = {
          suggestionId,
          provider: client.name,
          model: config.model,
          formPath: request.formPath,
          fieldId: request.fieldId,
          formulaKind: request.formulaKind,
          proposedFormula: finalDryRun.newFormula,
          explanation: modelOutput.explanation,
          assumptions: modelOutput.assumptions,
          referencedFields: modelOutput.referencedFields.filter(
            (field) => !field.fieldId || context.fieldsById.has(field.fieldId)
          ),
          risks: uniqueStrings([
            ...modelOutput.risks,
            ...aiBlockers,
            ...dryRunRisks(finalDryRun),
          ]),
          confidence: confidenceAfterDryRun(modelOutput.confidence, finalDryRun),
          dryRun: finalDryRun,
          contextPreview: context.preview,
        };
        log.info({
          event: "suggestion-created",
          suggestionId,
          actor: options.actor ?? null,
          clientId: options.clientId ?? null,
          tabId: options.tabId ?? null,
          formPath: request.formPath,
          fieldId: request.fieldId,
          formulaKind: request.formulaKind,
          provider: client.name,
          model: config.model,
          contextPreview: context.preview,
          dryRunAllowed: finalDryRun.allowed,
          blockers: finalDryRun.blockers.length,
          rawOutputStored: config.storeRawOutput,
        });
        if (config.storeRawOutput) {
          log.debug({
            event: "suggestion-raw-output",
            suggestionId,
            raw: maskSecrets(raw),
          });
        }
        return result;
      } finally {
        release();
      }
    },
  };
}

export const ragicFormulaAiSuggestionService = createRagicFormulaAiSuggestionService();
