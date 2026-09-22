import { env } from "../../../config/env";
import {
  MiniMaxRequestQueueAbortedError,
  MiniMaxRequestQueueTimeoutError,
  minimaxRequestScheduler,
  type MiniMaxRequestSchedulerLike,
} from "../../../infra/minimaxRequestScheduler";
import { HttpError } from "../../../utils/httpError";
import type {
  DevAiJsonProvider,
  DevAiJsonRequest,
} from "./devAiJsonProvider";

interface MiniMaxClientConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  baseUrl: string;
  queueTimeoutMs: number;
}

interface MiniMaxMessageResponse {
  content?: unknown;
  stop_reason?: unknown;
}

type FetchLike = typeof fetch;
const MINIMAX_JSON_TOOL_NAME = "submit_structured_result";

function requestSignal(params: {
  timeoutMs: number;
  parent?: AbortSignal;
}): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, params.timeoutMs);
  const onParentAbort = () => controller.abort();
  params.parent?.addEventListener("abort", onParentAbort, { once: true });
  if (params.parent?.aborted) onParentAbort();
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timeout);
      params.parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function extractToolInputJson(value: MiniMaxMessageResponse): string {
  if (value.stop_reason === "max_tokens") {
    throw new HttpError(
      502,
      "MiniMax 輸出超過 token 上限",
      "DEV_AI_MINIMAX_OUTPUT_TRUNCATED"
    );
  }
  if (value.stop_reason === "refusal") {
    throw new HttpError(502, "MiniMax 未產生結果", "DEV_AI_MINIMAX_REFUSED");
  }
  if (!Array.isArray(value.content)) {
    throw new HttpError(
      502,
      "MiniMax API 回傳格式無法解析",
      "DEV_AI_MINIMAX_BAD_RESPONSE"
    );
  }
  const tool = value.content.find(
    (item): item is { type: "tool_use"; name: string; input: unknown } =>
      Boolean(
        item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "tool_use" &&
          (item as { name?: unknown }).name === MINIMAX_JSON_TOOL_NAME
      )
  );
  if (
    !tool ||
    !tool.input ||
    typeof tool.input !== "object" ||
    Array.isArray(tool.input)
  ) {
    throw new HttpError(
      502,
      "MiniMax API 沒有回傳結構化 tool input",
      "DEV_AI_MINIMAX_BAD_RESPONSE"
    );
  }
  return JSON.stringify(tool.input);
}

function mapMiniMaxStatus(status: number): HttpError {
  if (status === 401 || status === 403) {
    return new HttpError(
      502,
      "MiniMax API key 無效或權限不足",
      "DEV_AI_MINIMAX_AUTH_FAILED"
    );
  }
  if (status === 400) {
    return new HttpError(
      502,
      "MiniMax API 請求格式無效",
      "DEV_AI_MINIMAX_INVALID_REQUEST"
    );
  }
  if (status === 404) {
    return new HttpError(
      502,
      "MiniMax model 或 API endpoint 不存在",
      "DEV_AI_MINIMAX_MODEL_NOT_FOUND"
    );
  }
  if (status === 413) {
    return new HttpError(
      502,
      "MiniMax 輸入內容超過服務上限",
      "DEV_AI_MINIMAX_INPUT_TOO_LARGE"
    );
  }
  if (status === 429) {
    return new HttpError(
      429,
      "MiniMax API 配額或速率限制，請稍後再試",
      "DEV_AI_MINIMAX_RATE_LIMITED"
    );
  }
  if (status >= 500) {
    return new HttpError(
      503,
      `MiniMax API 暫時無法使用（HTTP ${status}）`,
      "DEV_AI_MINIMAX_UNAVAILABLE"
    );
  }
  return new HttpError(
    502,
    `MiniMax API 呼叫失敗（HTTP ${status}）`,
    "DEV_AI_MINIMAX_FAILED"
  );
}

export function createMiniMaxClient(
  config: MiniMaxClientConfig = {
    apiKey: env.MINIMAX_API_KEY,
    model: env.MINIMAX_MODEL,
    timeoutMs: env.DEV_AI_REQUEST_TIMEOUT_MS,
    maxOutputTokens: env.DEV_AI_MAX_OUTPUT_TOKENS,
    baseUrl: env.MINIMAX_API_BASE_URL,
    queueTimeoutMs: env.MINIMAX_QUEUE_TIMEOUT_MS,
  },
  fetchImpl: FetchLike = fetch,
  scheduler: MiniMaxRequestSchedulerLike = minimaxRequestScheduler
): DevAiJsonProvider {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  return {
    name: "minimax",
    model: config.model,
    async generateJsonText(request: DevAiJsonRequest) {
      if (!config.apiKey.trim()) {
        throw new HttpError(
          503,
          "Dev AI 尚未設定 MiniMax API key",
          "DEV_AI_MINIMAX_KEY_MISSING"
        );
      }
      try {
        return await scheduler.run(
          async () => {
            const abort = requestSignal({
              timeoutMs: config.timeoutMs,
              parent: request.signal,
            });
            try {
              const response = await fetchImpl(`${baseUrl}/v1/messages`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": config.apiKey,
                  "anthropic-version": "2023-06-01",
                },
                signal: abort.signal,
                body: JSON.stringify({
                  model: request.model ?? config.model,
                  max_tokens: request.maxOutputTokens ?? config.maxOutputTokens,
                  thinking: {
                    type:
                      request.effort === "medium" || request.effort === "high"
                        ? "adaptive"
                        : "disabled",
                  },
                  messages: [
                    {
                      role: "user",
                      content: [{ type: "text", text: request.prompt }],
                    },
                  ],
                  tools: [
                    {
                      name: MINIMAX_JSON_TOOL_NAME,
                      description: "提交完全符合 input schema 的 JSON 結果",
                      input_schema: request.schema,
                    },
                  ],
                  tool_choice: { type: "tool", name: MINIMAX_JSON_TOOL_NAME },
                }),
              });
              if (!response.ok) throw mapMiniMaxStatus(response.status);
              return extractToolInputJson(
                (await response.json()) as MiniMaxMessageResponse
              );
            } catch (error) {
              if (error instanceof HttpError) throw error;
              if (
                (error instanceof DOMException && error.name === "AbortError") ||
                (error instanceof Error && error.name === "AbortError")
              ) {
                if (abort.timedOut()) {
                  throw new HttpError(
                    504,
                    "MiniMax API 請求逾時",
                    "DEV_AI_MINIMAX_TIMEOUT"
                  );
                }
                throw new HttpError(499, "Dev AI 產生已取消", "DEV_AI_ABORTED");
              }
              throw new HttpError(
                502,
                `MiniMax API 呼叫失敗：${
                  error instanceof Error ? error.message : String(error)
                }`,
                "DEV_AI_MINIMAX_FAILED"
              );
            } finally {
              abort.cleanup();
            }
          },
          { signal: request.signal, queueTimeoutMs: config.queueTimeoutMs }
        );
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof MiniMaxRequestQueueTimeoutError) {
          throw new HttpError(
            503,
            "MiniMax 目前忙碌，請稍後再試",
            "DEV_AI_MINIMAX_QUEUE_TIMEOUT"
          );
        }
        if (error instanceof MiniMaxRequestQueueAbortedError) {
          throw new HttpError(499, "Dev AI 產生已取消", "DEV_AI_ABORTED");
        }
        throw error;
      }
    },
  };
}
