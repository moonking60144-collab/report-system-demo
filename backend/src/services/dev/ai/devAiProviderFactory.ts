import { env } from "../../../config/env";
import { HttpError } from "../../../utils/httpError";
import type {
  DevAiEffort,
  DevAiJsonProvider,
  DevAiProviderName,
} from "./devAiJsonProvider";
import { createGoogleGeminiClient } from "./googleGeminiClient";
import { createMiniMaxClient } from "./minimaxClient";

export interface DevAiProviderProfile {
  provider: string;
  name: DevAiProviderName | null;
  model: string;
  fastModel: string;
  fastEffort: DevAiEffort;
  balancedEffort: DevAiEffort;
  deepEffort: DevAiEffort;
  maxOutputTokens: number;
  chatMaxOutputTokens: number;
  storeInteractions: boolean;
}

export function normalizeDevAiProviderName(value: string): DevAiProviderName | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "google" || normalized === "google-gemini") return "google";
  if (normalized === "minimax") return "minimax";
  return null;
}

function normalizeEffort(value: string, fallback: DevAiEffort): DevAiEffort {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  return fallback;
}

export function getDevAiProviderProfile(
  provider: string = env.DEV_AI_PROVIDER
): DevAiProviderProfile {
  const name = normalizeDevAiProviderName(provider);
  if (name === "minimax") {
    return {
      provider,
      name,
      model: env.MINIMAX_MODEL,
      fastModel: env.MINIMAX_MODEL,
      fastEffort: "low",
      balancedEffort: "medium",
      deepEffort: "high",
      maxOutputTokens: env.DEV_AI_MAX_OUTPUT_TOKENS,
      chatMaxOutputTokens: env.DEV_AI_CHAT_MAX_OUTPUT_TOKENS,
      storeInteractions: false,
    };
  }
  return {
    provider,
    name,
    model: env.GOOGLE_GEMINI_MODEL,
    fastModel: env.GOOGLE_GEMINI_FAST_MODEL,
    fastEffort: "minimal",
    balancedEffort: normalizeEffort(env.GOOGLE_GEMINI_THINKING_LEVEL, "minimal"),
    deepEffort: "high",
    maxOutputTokens: env.DEV_AI_MAX_OUTPUT_TOKENS,
    chatMaxOutputTokens: env.DEV_AI_CHAT_MAX_OUTPUT_TOKENS,
    storeInteractions: env.GOOGLE_GEMINI_STORE_INTERACTIONS,
  };
}

export function createDevAiJsonProvider(provider: string): DevAiJsonProvider {
  const name = normalizeDevAiProviderName(provider);
  if (name === "google") return createGoogleGeminiClient();
  if (name === "minimax") return createMiniMaxClient();
  throw new HttpError(400, "不支援的 Dev AI provider", "DEV_AI_BAD_PROVIDER");
}
