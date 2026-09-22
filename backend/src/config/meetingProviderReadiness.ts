import { env } from "./env";
import {
  isLocalWhisperConfigurationEnabled,
  isLoopbackMeetingTranscriptionLocalUrl,
  isSupportedMeetingTranscriptionLocalUrl,
} from "./meetingTranscriptionLocalConfig";

interface MeetingProviderReadinessConfig {
  MEETING_TRANSCRIPTION_PROVIDER: string;
  MEETING_TRANSCRIPTION_LOCAL_URL: string;
  MEETING_TRANSCRIPTION_LOCAL_TOKEN: string;
  MEETING_TRANSCRIPTION_LOCAL_MODEL: string;
  MEETING_MINUTES_PROVIDER: string;
  MEETING_MINUTES_GOOGLE_API_KEY: string;
  DEV_AI_ENABLED: boolean;
  DEV_AI_PROVIDER: string;
  GOOGLE_GEMINI_API_KEY: string;
  MINIMAX_API_KEY: string;
}

interface ProviderReadinessState {
  configuredProvider: string;
  runtimeProvider: string;
  enabled: boolean;
}

export interface MeetingProviderReadiness {
  ready: boolean;
  issues: string[];
  transcription: ProviderReadinessState;
  minutes: ProviderReadinessState;
  devAi: {
    configuredProvider: string;
    enabled: boolean;
    ready: boolean;
  };
}

function configuredProvider(
  rawEnv: NodeJS.ProcessEnv,
  key: string,
  fallback: string
): string {
  return (rawEnv[key] ?? fallback).trim().toLowerCase();
}

export function getMeetingProviderReadiness(
  config: MeetingProviderReadinessConfig = env,
  rawEnv: NodeJS.ProcessEnv = process.env
): MeetingProviderReadiness {
  const issues: string[] = [];
  const transcriptionConfigured = configuredProvider(
    rawEnv,
    "MEETING_TRANSCRIPTION_PROVIDER",
    config.MEETING_TRANSCRIPTION_PROVIDER
  );
  const minutesConfigured = configuredProvider(
    rawEnv,
    "MEETING_MINUTES_PROVIDER",
    config.MEETING_MINUTES_PROVIDER
  );
  const devAiConfigured = configuredProvider(
    rawEnv,
    "DEV_AI_PROVIDER",
    config.DEV_AI_PROVIDER
  );

  if (!["disabled", "local-whisper"].includes(transcriptionConfigured)) {
    issues.push("MEETING_TRANSCRIPTION_PROVIDER_UNSUPPORTED");
  } else if (
    transcriptionConfigured === "local-whisper" &&
    !config.MEETING_TRANSCRIPTION_LOCAL_URL
  ) {
    issues.push("MEETING_TRANSCRIPTION_LOCAL_URL_MISSING");
  } else if (
    transcriptionConfigured === "local-whisper" &&
    (!isSupportedMeetingTranscriptionLocalUrl(
      config.MEETING_TRANSCRIPTION_LOCAL_URL
    ) ||
      !config.MEETING_TRANSCRIPTION_LOCAL_MODEL.trim())
  ) {
    issues.push("MEETING_TRANSCRIPTION_LOCAL_CONFIG_INVALID");
  } else if (
    transcriptionConfigured === "local-whisper" &&
    !isLoopbackMeetingTranscriptionLocalUrl(
      config.MEETING_TRANSCRIPTION_LOCAL_URL
    ) &&
    !config.MEETING_TRANSCRIPTION_LOCAL_TOKEN
  ) {
    issues.push("MEETING_TRANSCRIPTION_LOCAL_TOKEN_MISSING");
  }

  if (!["disabled", "minimax", "google-gemini"].includes(minutesConfigured)) {
    issues.push("MEETING_MINUTES_PROVIDER_UNSUPPORTED");
  } else if (minutesConfigured === "minimax" && !config.MINIMAX_API_KEY) {
    issues.push("MEETING_MINUTES_CREDENTIAL_MISSING");
  } else if (
    minutesConfigured === "google-gemini" &&
    !config.MEETING_MINUTES_GOOGLE_API_KEY
  ) {
    issues.push("MEETING_MINUTES_CREDENTIAL_MISSING");
  }

  let devAiReady = true;
  if (config.DEV_AI_ENABLED) {
    if (!["minimax", "google", "google-gemini"].includes(devAiConfigured)) {
      issues.push("DEV_AI_PROVIDER_UNSUPPORTED");
      devAiReady = false;
    } else if (
      (devAiConfigured === "minimax" && !config.MINIMAX_API_KEY) ||
      ((devAiConfigured === "google" || devAiConfigured === "google-gemini") &&
        !config.GOOGLE_GEMINI_API_KEY)
    ) {
      issues.push("DEV_AI_CREDENTIAL_MISSING");
      devAiReady = false;
    }
  }

  return {
    ready: issues.length === 0,
    issues,
    transcription: {
      configuredProvider: transcriptionConfigured,
      runtimeProvider: config.MEETING_TRANSCRIPTION_PROVIDER,
      enabled:
        config.MEETING_TRANSCRIPTION_PROVIDER === "local-whisper" &&
        isLocalWhisperConfigurationEnabled(
          config.MEETING_TRANSCRIPTION_LOCAL_URL,
          config.MEETING_TRANSCRIPTION_LOCAL_MODEL,
          config.MEETING_TRANSCRIPTION_LOCAL_TOKEN
        ),
    },
    minutes: {
      configuredProvider: minutesConfigured,
      runtimeProvider: config.MEETING_MINUTES_PROVIDER,
      enabled:
        (config.MEETING_MINUTES_PROVIDER === "minimax" &&
          Boolean(config.MINIMAX_API_KEY)) ||
        (config.MEETING_MINUTES_PROVIDER === "google-gemini" &&
          Boolean(config.MEETING_MINUTES_GOOGLE_API_KEY)),
    },
    devAi: {
      configuredProvider: devAiConfigured,
      enabled: config.DEV_AI_ENABLED,
      ready: devAiReady,
    },
  };
}
