import axios, { type AxiosRequestConfig } from "axios";
import { env } from "../../config/env";
import {
  MiniMaxRequestQueueAbortedError,
  MiniMaxRequestQueueTimeoutError,
  minimaxRequestScheduler,
  type MiniMaxRequestSchedulerLike,
} from "../../infra/minimaxRequestScheduler";
import {
  MEETING_RECORD_JSON_SCHEMA,
  type MeetingMinutesProviderInput,
  type MeetingRecord,
  validateMeetingRecord,
} from "./meetingMinutesSchema";
import {
  MeetingMinutesProviderError,
  type MeetingMinutesProviderLike,
} from "./meetingMinutesProvider";
import {
  buildMeetingMinutesProviderInput,
  MEETING_MINUTES_SYSTEM_INSTRUCTION,
} from "./meetingMinutesProviderPrompt";

interface MiniMaxMessageResponse {
  content?: unknown;
  stop_reason?: unknown;
}

const MINIMAX_MEETING_TOOL_NAME = "submit_meeting_record";

interface MeetingMiniMaxHttpResponse<T> {
  data: T;
  status: number;
  headers: Record<string, unknown>;
}

export interface MeetingMiniMaxHttpClient {
  request<T>(config: AxiosRequestConfig): Promise<MeetingMiniMaxHttpResponse<T>>;
}

interface MiniMaxMeetingMinutesProviderDeps {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxInputCharacters?: number;
  maxOutputTokens?: number;
  queueTimeoutMs?: number;
  baseUrl?: string;
  client?: MeetingMiniMaxHttpClient;
  scheduler?: MiniMaxRequestSchedulerLike;
}

function extractMiniMaxToolInput(value: MiniMaxMessageResponse): unknown {
  if (value.stop_reason === "max_tokens") {
    throw new MeetingMinutesProviderError(
      "MiniMax 會議紀錄輸出超過 token 上限。",
      "MEETING_MINUTES_MINIMAX_OUTPUT_TRUNCATED"
    );
  }
  if (value.stop_reason === "refusal") {
    throw new MeetingMinutesProviderError(
      "MiniMax 未產生會議紀錄。",
      "MEETING_MINUTES_MINIMAX_REFUSED"
    );
  }
  if (!Array.isArray(value.content)) {
    throw new MeetingMinutesProviderError(
      "MiniMax 會議紀錄回傳格式無法解析。",
      "MEETING_MINUTES_MINIMAX_BAD_RESPONSE"
    );
  }
  const tool = value.content.find(
    (item): item is { type: "tool_use"; name: string; input: unknown } =>
      Boolean(
        item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "tool_use" &&
          (item as { name?: unknown }).name === MINIMAX_MEETING_TOOL_NAME
      )
  );
  if (
    !tool ||
    !tool.input ||
    typeof tool.input !== "object" ||
    Array.isArray(tool.input)
  ) {
    throw new MeetingMinutesProviderError(
      "MiniMax 會議紀錄沒有回傳結構化 tool input。",
      "MEETING_MINUTES_MINIMAX_BAD_RESPONSE"
    );
  }
  return tool.input;
}

function mapMiniMaxError(error: unknown): MeetingMinutesProviderError {
  if (error instanceof MeetingMinutesProviderError) return error;
  if (error instanceof MiniMaxRequestQueueTimeoutError) {
    return new MeetingMinutesProviderError(
      "MiniMax 目前忙碌，稍後會自動重試。",
      "MEETING_MINUTES_MINIMAX_QUEUE_TIMEOUT"
    );
  }
  if (error instanceof MiniMaxRequestQueueAbortedError) {
    return new MeetingMinutesProviderError(
      "會議紀錄產生已中止。",
      "MEETING_MINUTES_ABORTED"
    );
  }
  if (axios.isAxiosError(error)) {
    if (error.code === "ERR_CANCELED") {
      return new MeetingMinutesProviderError(
        "會議紀錄產生已中止。",
        "MEETING_MINUTES_ABORTED"
      );
    }
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return new MeetingMinutesProviderError(
        "MiniMax 會議紀錄請求逾時。",
        "MEETING_MINUTES_MINIMAX_TIMEOUT"
      );
    }
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return new MeetingMinutesProviderError(
        "Meeting MiniMax API key 無效或權限不足。",
        "MEETING_MINUTES_MINIMAX_AUTH_FAILED"
      );
    }
    if (status === 400) {
      return new MeetingMinutesProviderError(
        "MiniMax 會議紀錄請求格式無效。",
        "MEETING_MINUTES_MINIMAX_INVALID_REQUEST"
      );
    }
    if (status === 404) {
      return new MeetingMinutesProviderError(
        "MiniMax model 或 API endpoint 不存在。",
        "MEETING_MINUTES_MINIMAX_MODEL_NOT_FOUND"
      );
    }
    if (status === 413) {
      return new MeetingMinutesProviderError(
        "MiniMax 會議紀錄輸入內容超過服務上限。",
        "MEETING_MINUTES_MINIMAX_INPUT_TOO_LARGE"
      );
    }
    if (status === 429) {
      return new MeetingMinutesProviderError(
        "MiniMax 配額或速率限制，稍後會自動重試。",
        "MEETING_MINUTES_MINIMAX_RATE_LIMITED"
      );
    }
    if (typeof status === "number" && status >= 500) {
      return new MeetingMinutesProviderError(
        "MiniMax 暫時無法完成會議紀錄。",
        "MEETING_MINUTES_MINIMAX_UNAVAILABLE"
      );
    }
  }
  return new MeetingMinutesProviderError(
    error instanceof Error ? error.message : String(error),
    "MEETING_MINUTES_MINIMAX_FAILED"
  );
}

export class MiniMaxMeetingMinutesProvider implements MeetingMinutesProviderLike {
  readonly enabled: boolean;
  readonly name = "minimax";
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxInputCharacters: number;
  private readonly maxOutputTokens: number;
  private readonly queueTimeoutMs: number;
  private readonly baseUrl: string;
  private readonly client: MeetingMiniMaxHttpClient;
  private readonly scheduler: MiniMaxRequestSchedulerLike;

  constructor(deps: MiniMaxMeetingMinutesProviderDeps = {}) {
    this.apiKey = deps.apiKey ?? env.MINIMAX_API_KEY;
    this.model = deps.model ?? env.MINIMAX_MODEL;
    this.timeoutMs = deps.timeoutMs ?? env.MEETING_MINUTES_REQUEST_TIMEOUT_MS;
    this.maxInputCharacters =
      deps.maxInputCharacters ?? env.MEETING_MINUTES_MAX_INPUT_CHARACTERS;
    this.maxOutputTokens =
      deps.maxOutputTokens ?? env.MEETING_MINUTES_MINIMAX_MAX_OUTPUT_TOKENS;
    this.queueTimeoutMs = deps.queueTimeoutMs ?? env.MINIMAX_QUEUE_TIMEOUT_MS;
    this.baseUrl = (deps.baseUrl ?? env.MINIMAX_API_BASE_URL).replace(/\/$/, "");
    this.client = deps.client ?? (axios as MeetingMiniMaxHttpClient);
    this.scheduler = deps.scheduler ?? minimaxRequestScheduler;
    this.enabled = Boolean(this.apiKey.trim());
  }

  async summarize(
    input: MeetingMinutesProviderInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<MeetingRecord> {
    if (!this.enabled) {
      throw new MeetingMinutesProviderError(
        "Meeting 尚未設定 MiniMax API key。",
        "MEETING_MINUTES_MINIMAX_KEY_MISSING"
      );
    }
    const serializedInput = buildMeetingMinutesProviderInput(input);
    if (serializedInput.length > this.maxInputCharacters) {
      throw new MeetingMinutesProviderError(
        `逐字稿與補充資料總長度超過 ${this.maxInputCharacters} 字元。`,
        "MEETING_MINUTES_INPUT_TOO_LARGE"
      );
    }
    try {
      const response = await this.scheduler.run(
        () =>
          this.client.request<MiniMaxMessageResponse>({
            method: "POST",
            url: `${this.baseUrl}/v1/messages`,
            headers: {
              "Content-Type": "application/json",
              "x-api-key": this.apiKey,
              "anthropic-version": "2023-06-01",
            },
            timeout: this.timeoutMs,
            signal: options.signal,
            data: {
              model: this.model,
              max_tokens: this.maxOutputTokens,
              thinking: { type: "adaptive" },
              system: MEETING_MINUTES_SYSTEM_INSTRUCTION,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: serializedInput }],
                },
              ],
              tools: [
                {
                  name: MINIMAX_MEETING_TOOL_NAME,
                  description: "提交完全符合 schema 的會議紀錄",
                  input_schema: MEETING_RECORD_JSON_SCHEMA,
                },
              ],
              tool_choice: { type: "tool", name: MINIMAX_MEETING_TOOL_NAME },
            },
          }),
        { signal: options.signal, queueTimeoutMs: this.queueTimeoutMs }
      );
      return validateMeetingRecord(extractMiniMaxToolInput(response.data));
    } catch (error) {
      throw mapMiniMaxError(error);
    }
  }
}
