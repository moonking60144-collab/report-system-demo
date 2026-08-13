import assert from "node:assert/strict";
import test from "node:test";
import { getMeetingProviderReadiness } from "../../src/config/meetingProviderReadiness";

const baseConfig = {
  MEETING_TRANSCRIPTION_PROVIDER: "disabled",
  MEETING_TRANSCRIPTION_LOCAL_URL: "",
  MEETING_TRANSCRIPTION_LOCAL_TOKEN: "",
  MEETING_TRANSCRIPTION_LOCAL_MODEL: "large-v3",
  MEETING_MINUTES_PROVIDER: "disabled",
  MEETING_MINUTES_GOOGLE_API_KEY: "",
  DEV_AI_ENABLED: false,
  DEV_AI_PROVIDER: "minimax",
  GOOGLE_GEMINI_API_KEY: "",
  MINIMAX_API_KEY: "",
};

test("provider readiness 會揭露被 normalize 成 disabled 的舊 provider 值", () => {
  const readiness = getMeetingProviderReadiness(baseConfig, {
    MEETING_TRANSCRIPTION_PROVIDER: "google-gemini",
    MEETING_MINUTES_PROVIDER: "anthropic-claude",
  });

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.issues, [
    "MEETING_TRANSCRIPTION_PROVIDER_UNSUPPORTED",
    "MEETING_MINUTES_PROVIDER_UNSUPPORTED",
  ]);
  assert.equal(readiness.transcription.runtimeProvider, "disabled");
  assert.equal(readiness.minutes.runtimeProvider, "disabled");
});

test("provider readiness 只要求已啟用 provider 的 credential", () => {
  const readiness = getMeetingProviderReadiness(
    {
      ...baseConfig,
      MEETING_TRANSCRIPTION_PROVIDER: "local-whisper",
      MEETING_MINUTES_PROVIDER: "minimax",
      DEV_AI_ENABLED: true,
    },
    {
      MEETING_TRANSCRIPTION_PROVIDER: "local-whisper",
      MEETING_MINUTES_PROVIDER: "minimax",
      DEV_AI_PROVIDER: "minimax",
    }
  );

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.issues, [
    "MEETING_TRANSCRIPTION_LOCAL_URL_MISSING",
    "MEETING_MINUTES_CREDENTIAL_MISSING",
    "DEV_AI_CREDENTIAL_MISSING",
  ]);
});

test("provider readiness 與 runtime adapter 一致拒絕非 HTTP local Whisper URL", () => {
  const readiness = getMeetingProviderReadiness(
    {
      ...baseConfig,
      MEETING_TRANSCRIPTION_PROVIDER: "local-whisper",
      MEETING_TRANSCRIPTION_LOCAL_URL: "ftp://whisper.internal.test/v1/transcriptions",
      MEETING_TRANSCRIPTION_LOCAL_TOKEN: "test-token",
    },
    {
      MEETING_TRANSCRIPTION_PROVIDER: "local-whisper",
      MEETING_MINUTES_PROVIDER: "disabled",
    }
  );

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.issues, [
    "MEETING_TRANSCRIPTION_LOCAL_CONFIG_INVALID",
  ]);
  assert.equal(readiness.transcription.enabled, false);
});

test("provider readiness 拒絕沒有 token 的跨主機 local Whisper URL", () => {
  const readiness = getMeetingProviderReadiness(
    {
      ...baseConfig,
      MEETING_TRANSCRIPTION_PROVIDER: "local-whisper",
      MEETING_TRANSCRIPTION_LOCAL_URL: "http://whisper.internal.test/v1/transcriptions",
    },
    {
      MEETING_TRANSCRIPTION_PROVIDER: "local-whisper",
      MEETING_MINUTES_PROVIDER: "disabled",
    }
  );

  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.issues, [
    "MEETING_TRANSCRIPTION_LOCAL_TOKEN_MISSING",
  ]);
  assert.equal(readiness.transcription.enabled, false);
});
