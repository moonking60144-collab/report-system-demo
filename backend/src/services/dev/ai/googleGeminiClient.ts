import { env } from "../../../config/env";
import { HttpError } from "../../../utils/httpError";
import type {
  DevAiJsonProvider,
  DevAiJsonRequest,
} from "./devAiJsonProvider";

export type GoogleGeminiJsonRequest = DevAiJsonRequest;

export type GoogleGeminiClient = DevAiJsonProvider;

export interface GoogleGeminiClientConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  thinkingLevel?: string;
  storeInteractions?: boolean;
}

type FetchLike = typeof fetch;

function combineAbortSignal(params: {
  timeoutMs: number;
  parent?: AbortSignal;
}): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, params.timeoutMs);

  const onParentAbort = () => controller.abort();
  params.parent?.addEventListener("abort", onParentAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      params.parent?.removeEventListener("abort", onParentAbort);
      if (timedOut) {
        throw new HttpError(504, "AI 產生逾時", "DEV_AI_GOOGLE_TIMEOUT");
      }
    },
  };
}

function extractGeminiOutputText(data: unknown): string {
  if (typeof data === "object" && data !== null) {
    const direct = data as { output_text?: unknown; steps?: unknown };
    if (typeof direct.output_text === "string") {
      return direct.output_text;
    }

    const structured = data as { proposedFormula?: unknown };
    if (typeof structured.proposedFormula === "string") {
      return JSON.stringify(data);
    }

    if (Array.isArray(direct.steps)) {
      for (const step of direct.steps) {
        if (typeof step !== "object" || step === null) continue;
        const content = (step as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
          if (typeof item !== "object" || item === null) continue;
          const text = (item as { text?: unknown }).text;
          if (typeof text === "string" && text.trim()) return text;
        }
      }
    }
  }

  throw new HttpError(502, "Google API 回傳格式無法解析", "DEV_AI_GOOGLE_BAD_RESPONSE");
}

function mapGoogleStatus(status: number): HttpError {
  if (status === 401 || status === 403) {
    return new HttpError(
      502,
      "Google API key 無效或權限不足",
      "DEV_AI_GOOGLE_AUTH_FAILED"
    );
  }
  if (status === 429) {
    return new HttpError(
      429,
      "Google API 配額或速率限制，請稍後再試",
      "DEV_AI_GOOGLE_RATE_LIMITED"
    );
  }
  return new HttpError(
    502,
    `Google API 呼叫失敗（HTTP ${status}）`,
    "DEV_AI_GOOGLE_FAILED"
  );
}

export function createGoogleGeminiClient(
  config: GoogleGeminiClientConfig = {
    apiKey: env.GOOGLE_GEMINI_API_KEY,
    model: env.GOOGLE_GEMINI_MODEL,
    timeoutMs: env.DEV_AI_REQUEST_TIMEOUT_MS,
    thinkingLevel: env.GOOGLE_GEMINI_THINKING_LEVEL,
    storeInteractions: env.GOOGLE_GEMINI_STORE_INTERACTIONS,
  },
  fetchImpl: FetchLike = fetch
): GoogleGeminiClient {
  return {
    name: "google",
    model: config.model,
    async generateJsonText(request) {
      if (!config.apiKey.trim()) {
        throw new HttpError(
          503,
          "Dev AI 尚未設定 Google Gemini API key",
          "DEV_AI_GOOGLE_KEY_MISSING"
        );
      }

      const abort = combineAbortSignal({
        timeoutMs: config.timeoutMs,
        parent: request.signal,
      });
      try {
        const response = await fetchImpl(
          "https://generativelanguage.googleapis.com/v1beta/interactions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": config.apiKey,
            },
            signal: abort.signal,
            body: JSON.stringify({
              model: request.model ?? config.model,
              store: request.storeInteraction ?? config.storeInteractions ?? false,
              input: request.prompt,
              generation_config: {
                ...(request.effort ?? config.thinkingLevel
                  ? { thinking_level: request.effort ?? config.thinkingLevel }
                  : {}),
                ...(request.maxOutputTokens
                  ? { max_output_tokens: request.maxOutputTokens }
                  : {}),
              },
              response_format: {
                type: "text",
                mime_type: "application/json",
                schema: request.schema,
              },
            }),
          }
        );

        if (!response.ok) {
          throw mapGoogleStatus(response.status);
        }

        const data = await response.json();
        return extractGeminiOutputText(data);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (
          error instanceof DOMException && error.name === "AbortError" ||
          error instanceof Error && error.name === "AbortError"
        ) {
          throw new HttpError(504, "AI 產生逾時", "DEV_AI_GOOGLE_TIMEOUT");
        }
        throw new HttpError(
          502,
          `Google API 呼叫失敗：${error instanceof Error ? error.message : String(error)}`,
          "DEV_AI_GOOGLE_FAILED"
        );
      } finally {
        abort.cleanup();
      }
    },
  };
}
