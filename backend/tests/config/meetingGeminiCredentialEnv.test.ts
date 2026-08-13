import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

function loadMeetingProviderConfig(overrides: Record<string, string>) {
  const envModule = path.resolve(".tmp-test-dist/src/config/env.js");
  const transcriptionFactoryModule = path.resolve(
    ".tmp-test-dist/src/services/meeting-minutes/meetingTranscriptionProviderFactory.js"
  );
  const minutesFactoryModule = path.resolve(
    ".tmp-test-dist/src/services/meeting-minutes/meetingMinutesProviderFactory.js"
  );
  const script = `
    const { env } = require(${JSON.stringify(envModule)});
    const { meetingTranscriptionProvider } = require(${JSON.stringify(
      transcriptionFactoryModule
    )});
    const { meetingMinutesProvider } = require(${JSON.stringify(minutesFactoryModule)});
    process.stdout.write(JSON.stringify({
      allowShared: env.MEETING_ALLOW_SHARED_GEMINI_CREDENTIAL,
      transcriptionProvider: env.MEETING_TRANSCRIPTION_PROVIDER,
      minutesProvider: env.MEETING_MINUTES_PROVIDER,
      minutesGoogleKey: env.MEETING_MINUTES_GOOGLE_API_KEY,
      localUrl: env.MEETING_TRANSCRIPTION_LOCAL_URL,
      localToken: env.MEETING_TRANSCRIPTION_LOCAL_TOKEN,
      localModel: env.MEETING_TRANSCRIPTION_LOCAL_MODEL,
      transcriptionPhrases: env.MEETING_TRANSCRIPTION_PHRASES,
      language: env.MEETING_TRANSCRIPTION_LANGUAGE,
      minimaxBaseUrl: env.MINIMAX_API_BASE_URL,
      minimaxKey: env.MINIMAX_API_KEY,
      minimaxModel: env.MINIMAX_MODEL,
      minimaxConcurrency: env.MINIMAX_REQUEST_CONCURRENCY,
      minimaxMaxOutputTokens: env.MEETING_MINUTES_MINIMAX_MAX_OUTPUT_TOKENS,
      providerMigrationRetryGraceMs: env.MEETING_AI_PROVIDER_MIGRATION_RETRY_GRACE_MS,
      transcriptionRuntimeProvider: meetingTranscriptionProvider.name,
      transcriptionRuntimeEnabled: meetingTranscriptionProvider.enabled,
      minutesRuntimeProvider: meetingMinutesProvider.name,
      minutesRuntimeEnabled: meetingMinutesProvider.enabled
    }));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DOTENV_CONFIG_QUIET: "true",
      GOOGLE_GEMINI_API_KEY: "shared-key",
      MEETING_MINUTES_GOOGLE_API_KEY: "",
      MEETING_TRANSCRIPTION_PROVIDER: "disabled",
      MEETING_MINUTES_PROVIDER: "disabled",
      MINIMAX_API_KEY: "",
      ...overrides,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    allowShared: boolean;
    transcriptionProvider: string;
    minutesProvider: string;
    minutesGoogleKey: string;
    localUrl: string;
    localToken: string;
    localModel: string;
    transcriptionPhrases: string[];
    language: string;
    minimaxBaseUrl: string;
    minimaxKey: string;
    minimaxModel: string;
    minimaxConcurrency: number;
    minimaxMaxOutputTokens: number;
    providerMigrationRetryGraceMs: number;
    transcriptionRuntimeProvider: string;
    transcriptionRuntimeEnabled: boolean;
    minutesRuntimeProvider: string;
    minutesRuntimeEnabled: boolean;
  };
}

test("Meeting Gemini credential 預設不會隱式沿用 Dev AI key", () => {
  const config = loadMeetingProviderConfig({
    MEETING_ALLOW_SHARED_GEMINI_CREDENTIAL: "false",
    MEETING_MINUTES_PROVIDER: "google-gemini",
  });
  assert.equal(config.allowShared, false);
  assert.equal(config.minutesGoogleKey, "");
  assert.equal(config.minutesRuntimeProvider, "google-gemini");
  assert.equal(config.minutesRuntimeEnabled, false);
});

test("Meeting Gemini fallback 只有明確 opt-in 才沿用 shared key", () => {
  const config = loadMeetingProviderConfig({
    MEETING_ALLOW_SHARED_GEMINI_CREDENTIAL: "true",
    MEETING_MINUTES_PROVIDER: "google-gemini",
  });
  assert.equal(config.minutesGoogleKey, "shared-key");
  assert.equal(config.minutesRuntimeEnabled, true);
});

test("Meeting 專用 Gemini credential 永遠優先於 shared key", () => {
  const config = loadMeetingProviderConfig({
    MEETING_ALLOW_SHARED_GEMINI_CREDENTIAL: "true",
    MEETING_MINUTES_PROVIDER: "google-gemini",
    MEETING_MINUTES_GOOGLE_API_KEY: "minutes-key",
  });
  assert.equal(config.minutesGoogleKey, "minutes-key");
});

test("Meeting 正式 provider 為 local Whisper 與 MiniMax-M2.7", () => {
  const config = loadMeetingProviderConfig({
    MEETING_TRANSCRIPTION_PROVIDER: "local-whisper",
    MEETING_TRANSCRIPTION_LOCAL_URL: "http://whisper.internal.test/v1/transcriptions",
    MEETING_TRANSCRIPTION_LOCAL_TOKEN: "local-token",
    MEETING_TRANSCRIPTION_LOCAL_MODEL: "large-v3",
    MEETING_TRANSCRIPTION_PHRASES: "螺帽, Funda, 品管",
    MEETING_TRANSCRIPTION_LANGUAGE: "",
    MEETING_MINUTES_PROVIDER: "minimax",
    MINIMAX_API_BASE_URL: "https://minimax.example/anthropic/",
    MINIMAX_API_KEY: "minimax-key",
    MINIMAX_MODEL: "MiniMax-M2.7",
    MINIMAX_REQUEST_CONCURRENCY: "1",
    MEETING_MINUTES_MINIMAX_MAX_OUTPUT_TOKENS: "12000",
    MEETING_AI_PROVIDER_MIGRATION_RETRY_GRACE_MS: "30000",
  });

  assert.equal(config.transcriptionProvider, "local-whisper");
  assert.equal(config.transcriptionRuntimeProvider, "local-whisper");
  assert.equal(config.transcriptionRuntimeEnabled, true);
  assert.equal(config.localUrl, "http://whisper.internal.test/v1/transcriptions");
  assert.equal(config.localToken, "local-token");
  assert.equal(config.localModel, "large-v3");
  assert.deepEqual(config.transcriptionPhrases, ["螺帽", "Funda", "品管"]);
  assert.equal(config.language, "zh-TW");
  assert.equal(config.minutesProvider, "minimax");
  assert.equal(config.minutesRuntimeProvider, "minimax");
  assert.equal(config.minutesRuntimeEnabled, true);
  assert.equal(config.minimaxBaseUrl, "https://minimax.example/anthropic/");
  assert.equal(config.minimaxKey, "minimax-key");
  assert.equal(config.minimaxModel, "MiniMax-M2.7");
  assert.equal(config.minimaxConcurrency, 1);
  assert.equal(config.minimaxMaxOutputTokens, 12_000);
  assert.equal(config.providerMigrationRetryGraceMs, 60_000);
});

test("Claude 與 Gemini transcription 舊值會 fail-closed 成 disabled", () => {
  const config = loadMeetingProviderConfig({
    MEETING_TRANSCRIPTION_PROVIDER: "google-gemini",
    MEETING_MINUTES_PROVIDER: "anthropic-claude",
    MINIMAX_API_KEY: "minimax-key",
  });
  assert.equal(config.transcriptionProvider, "disabled");
  assert.equal(config.transcriptionRuntimeProvider, "disabled");
  assert.equal(config.minutesProvider, "disabled");
  assert.equal(config.minutesRuntimeProvider, "disabled");
});
