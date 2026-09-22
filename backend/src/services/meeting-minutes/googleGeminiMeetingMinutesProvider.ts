import axios, { type AxiosRequestConfig } from "axios";
import { env } from "../../config/env";
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

interface GoogleInteractionResponse {
  output_text?: unknown;
  steps?: unknown;
}

interface MeetingGoogleHttpResponse<T> {
  data: T;
  status: number;
  headers: Record<string, unknown>;
}

export interface MeetingMinutesGoogleHttpClient {
  request<T>(config: AxiosRequestConfig): Promise<MeetingGoogleHttpResponse<T>>;
}

interface GoogleGeminiMeetingMinutesProviderDeps {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxInputCharacters?: number;
  baseUrl?: string;
  client?: MeetingMinutesGoogleHttpClient;
}

function buildGoogleStructuredOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(buildGoogleStructuredOutputSchema);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "maxLength")
      .map(([key, child]) => [key, buildGoogleStructuredOutputSchema(child)])
  );
}

// Interactions 目前不接受這組 schema 的 maxLength；array maxItems 仍交給模型與本地 validator 雙重約束。
const GOOGLE_MEETING_RECORD_JSON_SCHEMA = buildGoogleStructuredOutputSchema(
  MEETING_RECORD_JSON_SCHEMA
);

function extractOutputText(value: GoogleInteractionResponse): string {
  if (typeof value.output_text === "string" && value.output_text.trim()) {
    return value.output_text;
  }
  if (Array.isArray(value.steps)) {
    for (const step of value.steps) {
      if (!step || typeof step !== "object") continue;
      const content = (step as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) return text;
      }
    }
  }
  throw new MeetingMinutesProviderError(
    "Google 會議紀錄回傳格式無法解析。",
    "MEETING_MINUTES_GOOGLE_BAD_RESPONSE"
  );
}

function mapGoogleError(error: unknown): MeetingMinutesProviderError {
  if (error instanceof MeetingMinutesProviderError) return error;
  if (axios.isAxiosError(error)) {
    if (error.code === "ERR_CANCELED") {
      return new MeetingMinutesProviderError(
        "會議紀錄產生已中止。",
        "MEETING_MINUTES_ABORTED"
      );
    }
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return new MeetingMinutesProviderError(
        "Google 會議紀錄請求逾時。",
        "MEETING_MINUTES_GOOGLE_TIMEOUT"
      );
    }
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return new MeetingMinutesProviderError(
        "Meeting minutes Google API key 無效或權限不足。",
        "MEETING_MINUTES_GOOGLE_AUTH_FAILED"
      );
    }
    if (status === 400) {
      return new MeetingMinutesProviderError(
        "Google 會議紀錄請求格式無效。",
        "MEETING_MINUTES_GOOGLE_INVALID_REQUEST"
      );
    }
    if (status === 429) {
      return new MeetingMinutesProviderError(
        "Google 會議紀錄配額或速率限制，稍後會自動重試。",
        "MEETING_MINUTES_GOOGLE_RATE_LIMITED"
      );
    }
  }
  return new MeetingMinutesProviderError(
    error instanceof Error ? error.message : String(error),
    "MEETING_MINUTES_GOOGLE_FAILED"
  );
}

export class GoogleGeminiMeetingMinutesProvider implements MeetingMinutesProviderLike {
  readonly enabled: boolean;
  readonly name = "google-gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxInputCharacters: number;
  private readonly baseUrl: string;
  private readonly client: MeetingMinutesGoogleHttpClient;

  constructor(deps: GoogleGeminiMeetingMinutesProviderDeps = {}) {
    this.apiKey = deps.apiKey ?? env.MEETING_MINUTES_GOOGLE_API_KEY;
    this.model = deps.model ?? env.MEETING_MINUTES_GOOGLE_MODEL;
    this.timeoutMs = deps.timeoutMs ?? env.MEETING_MINUTES_REQUEST_TIMEOUT_MS;
    this.maxInputCharacters =
      deps.maxInputCharacters ?? env.MEETING_MINUTES_MAX_INPUT_CHARACTERS;
    this.baseUrl = (deps.baseUrl ?? "https://generativelanguage.googleapis.com").replace(
      /\/$/,
      ""
    );
    this.client = deps.client ?? (axios as MeetingMinutesGoogleHttpClient);
    this.enabled = Boolean(this.apiKey.trim());
  }

  async summarize(
    input: MeetingMinutesProviderInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<MeetingRecord> {
    if (!this.enabled) {
      throw new MeetingMinutesProviderError(
        "Meeting 尚未設定 minutes Google API key。",
        "MEETING_MINUTES_GOOGLE_KEY_MISSING"
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
      const response = await this.client.request<GoogleInteractionResponse>({
        method: "POST",
        url: `${this.baseUrl}/v1beta/interactions`,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        timeout: this.timeoutMs,
        signal: options.signal,
        data: {
          model: this.model,
          store: false,
          system_instruction: MEETING_MINUTES_SYSTEM_INSTRUCTION,
          input: [{ type: "text", text: serializedInput }],
          generation_config: { temperature: 0 },
          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: GOOGLE_MEETING_RECORD_JSON_SCHEMA,
          },
        },
      });
      const parsed = JSON.parse(extractOutputText(response.data)) as unknown;
      return validateMeetingRecord(parsed);
    } catch (error) {
      throw mapGoogleError(error);
    }
  }
}
