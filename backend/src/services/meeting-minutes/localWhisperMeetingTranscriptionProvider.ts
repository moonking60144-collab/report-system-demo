import { readFile } from "node:fs/promises";
import path from "node:path";
import axios, { type AxiosRequestConfig } from "axios";
import { env } from "../../config/env";
import { isLocalWhisperConfigurationEnabled } from "../../config/meetingTranscriptionLocalConfig";
import {
  MeetingTranscriptionError,
  type MeetingProviderTranscriptSegment,
  type MeetingTranscriptionProviderInput,
  type MeetingTranscriptionProviderLike,
  validateMeetingProviderTranscriptSegments,
} from "./meetingTranscriptionProvider";

interface LocalWhisperResponse {
  model?: unknown;
  segments?: unknown;
}

interface MeetingLocalWhisperHttpResponse<T> {
  data: T;
  status: number;
  headers: Record<string, unknown>;
}

export interface MeetingLocalWhisperHttpClient {
  request<T>(config: AxiosRequestConfig): Promise<MeetingLocalWhisperHttpResponse<T>>;
}

interface LocalWhisperMeetingTranscriptionProviderDeps {
  url?: string;
  token?: string;
  model?: string;
  timeoutMs?: number;
  phrases?: string[];
  client?: MeetingLocalWhisperHttpClient;
}

function mapLocalWhisperError(error: unknown): MeetingTranscriptionError {
  if (error instanceof MeetingTranscriptionError) return error;
  if (axios.isAxiosError(error)) {
    if (error.code === "ERR_CANCELED") {
      return new MeetingTranscriptionError(
        "逐字稿處理已中止。",
        "MEETING_TRANSCRIPTION_ABORTED"
      );
    }
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return new MeetingTranscriptionError(
        "本機 Whisper 逐字稿請求逾時。",
        "MEETING_TRANSCRIPTION_LOCAL_TIMEOUT"
      );
    }
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return new MeetingTranscriptionError(
        "本機 Whisper service token 無效或權限不足。",
        "MEETING_TRANSCRIPTION_LOCAL_AUTH_FAILED"
      );
    }
    if (status === 409) {
      return new MeetingTranscriptionError(
        "本機 Whisper service model 與 Backend 設定不一致。",
        "MEETING_TRANSCRIPTION_LOCAL_MODEL_MISMATCH"
      );
    }
    if (status === 413) {
      return new MeetingTranscriptionError(
        "本機 Whisper 拒絕過大的音訊片段。",
        "MEETING_TRANSCRIPTION_LOCAL_AUDIO_TOO_LARGE"
      );
    }
    if (status === 400 || status === 422) {
      return new MeetingTranscriptionError(
        "本機 Whisper 逐字稿請求格式無效。",
        "MEETING_TRANSCRIPTION_LOCAL_INVALID_REQUEST"
      );
    }
    if (status === 429) {
      return new MeetingTranscriptionError(
        "本機 Whisper 正在處理其他逐字稿，稍後會自動重試。",
        "MEETING_TRANSCRIPTION_LOCAL_BUSY"
      );
    }
    if (typeof status === "number" && status >= 500) {
      return new MeetingTranscriptionError(
        "本機 Whisper service 暫時無法完成逐字稿。",
        "MEETING_TRANSCRIPTION_LOCAL_UNAVAILABLE"
      );
    }
  }
  return new MeetingTranscriptionError(
    error instanceof Error ? error.message : String(error),
    "MEETING_TRANSCRIPTION_LOCAL_FAILED"
  );
}

export class LocalWhisperMeetingTranscriptionProvider
  implements MeetingTranscriptionProviderLike
{
  readonly enabled: boolean;
  readonly name = "local-whisper";
  readonly model: string;
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly phrases: string[];
  private readonly client: MeetingLocalWhisperHttpClient;

  constructor(deps: LocalWhisperMeetingTranscriptionProviderDeps = {}) {
    this.url = (deps.url ?? env.MEETING_TRANSCRIPTION_LOCAL_URL).trim();
    this.token = deps.token ?? env.MEETING_TRANSCRIPTION_LOCAL_TOKEN;
    this.model = (deps.model ?? env.MEETING_TRANSCRIPTION_LOCAL_MODEL).trim();
    this.timeoutMs = deps.timeoutMs ?? env.MEETING_TRANSCRIPTION_REQUEST_TIMEOUT_MS;
    this.phrases = (deps.phrases ?? env.MEETING_TRANSCRIPTION_PHRASES)
      .map((phrase) => phrase.trim())
      .filter(Boolean)
      .slice(0, 500)
      .map((phrase) => phrase.slice(0, 200));
    this.client = deps.client ?? (axios as MeetingLocalWhisperHttpClient);
    this.enabled = isLocalWhisperConfigurationEnabled(
      this.url,
      this.model,
      this.token
    );
  }

  async transcribe(
    input: MeetingTranscriptionProviderInput
  ): Promise<MeetingProviderTranscriptSegment[]> {
    if (!this.enabled) {
      throw new MeetingTranscriptionError(
        "Meeting 尚未設定本機 Whisper service URL 與 model。",
        "MEETING_TRANSCRIPTION_LOCAL_NOT_CONFIGURED"
      );
    }
    try {
      const audio = await readFile(input.audioPath);
      const form = new FormData();
      form.append("audio", new Blob([audio], { type: input.mimeType }), path.basename(input.audioPath));
      form.append("language", input.language);
      form.append("sourceId", input.sourceId);
      form.append("durationMs", String(input.durationMs));
      form.append("model", this.model);
      form.append("phrases", JSON.stringify(this.phrases));
      const headers: Record<string, string> = {};
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const response = await this.client.request<LocalWhisperResponse>({
        method: "POST",
        url: this.url,
        headers,
        timeout: this.timeoutMs,
        signal: input.signal,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        data: form,
      });
      if (response.data.model !== this.model) {
        throw new MeetingTranscriptionError(
          "本機 Whisper service 回傳的 model 與 Backend 設定不一致。",
          "MEETING_TRANSCRIPTION_LOCAL_MODEL_MISMATCH"
        );
      }
      return validateMeetingProviderTranscriptSegments(
        response.data.segments,
        input.durationMs
      );
    } catch (error) {
      throw mapLocalWhisperError(error);
    }
  }
}
