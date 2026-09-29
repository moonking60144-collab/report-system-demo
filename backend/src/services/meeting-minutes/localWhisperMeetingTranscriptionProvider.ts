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
  beamSize?: unknown;
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
  beamSize?: number;
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
    if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"].includes(error.code ?? "")) {
      return new MeetingTranscriptionError(
        "語音轉文字服務暫時無法連線。",
        "MEETING_TRANSCRIPTION_LOCAL_UNAVAILABLE"
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
      if (error.response?.data?.detail === "STT_BEAM_SIZE_MISMATCH") {
        return new MeetingTranscriptionError("Whisper 解碼設定與 Backend 不一致，請同步設定 beam。", "MEETING_TRANSCRIPTION_LOCAL_PROFILE_MISMATCH");
      }
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
  readonly inferenceProfile: string;
  private readonly beamSize: number;
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly phrases: string[];
  private readonly client: MeetingLocalWhisperHttpClient;

  constructor(deps: LocalWhisperMeetingTranscriptionProviderDeps = {}) {
    this.beamSize = deps.beamSize ?? env.MEETING_TRANSCRIPTION_BEAM_SIZE;
    this.inferenceProfile = `whisper-decoder-v1:beam=${this.beamSize}`;
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

  async checkReady(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const url = new URL(this.url);
      url.pathname = "/health";
      url.search = "";
      const response = await this.client.request<{ status?: string; model?: string; beamSize?: number }>({
        method: "GET", url: url.toString(), timeout: 1_500,
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
      return response.status === 200 && response.data.status === "ok" &&
        response.data.model === this.model && response.data.beamSize === this.beamSize;
    } catch { return false; }
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
      form.append("durationMs", String(Math.ceil(input.durationMs)));
      form.append("model", this.model);
      form.append("expectedBeamSize", String(this.beamSize));
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
      if (response.data.beamSize !== this.beamSize) {
        throw new MeetingTranscriptionError("Whisper 解碼設定與 Backend 不一致，請同步更新 STT service。", "MEETING_TRANSCRIPTION_LOCAL_PROFILE_MISMATCH");
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
