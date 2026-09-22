const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function provider(value, fallback = "disabled") {
  return String(value ?? "").trim().toLowerCase() || fallback;
}

function isLoopbackUrl(url) {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname.startsWith("127.") ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_STRUCTURED_OUTPUT_MODEL = "MiniMax-M2.7";

function isOfficialMiniMaxAnthropicUrl(value) {
  const url = new URL(value);
  return (
    url.hostname.toLowerCase() === "api.minimax.io" &&
    url.pathname.replace(/\/+$/, "") === "/anthropic"
  );
}

function validateMiniMaxStructuredOutputEnv(values) {
  const errors = [];
  const minutes = provider(values.MEETING_MINUTES_PROVIDER);
  const devAi = provider(values.DEV_AI_PROVIDER, "minimax");
  const minimaxInUse =
    minutes === "minimax" || (enabled(values.DEV_AI_ENABLED) && devAi === "minimax");
  if (!minimaxInUse) return errors;

  const baseUrl =
    String(values.MINIMAX_API_BASE_URL ?? "").trim() || MINIMAX_ANTHROPIC_BASE_URL;
  const model =
    String(values.MINIMAX_MODEL ?? "").trim() || MINIMAX_STRUCTURED_OUTPUT_MODEL;
  try {
    if (
      isOfficialMiniMaxAnthropicUrl(baseUrl) &&
      model !== MINIMAX_STRUCTURED_OUTPUT_MODEL
    ) {
      errors.push(
        `目前 MiniMax 結構化輸出已驗證模型為 ${MINIMAX_STRUCTURED_OUTPUT_MODEL}；收到 MINIMAX_MODEL=${model}`
      );
    }
  } catch {
    errors.push(`MINIMAX_API_BASE_URL 不是有效 URL：${baseUrl}`);
  }
  return errors;
}

function validateProviderEnv(values) {
  const errors = [];
  const transcription = provider(values.MEETING_TRANSCRIPTION_PROVIDER);
  const minutes = provider(values.MEETING_MINUTES_PROVIDER);
  const devAi = provider(values.DEV_AI_PROVIDER, "minimax");

  if (!["disabled", "local-whisper"].includes(transcription)) {
    errors.push(`MEETING_TRANSCRIPTION_PROVIDER 不支援目前值：${transcription}`);
  } else if (
    transcription === "local-whisper" &&
    !values.MEETING_TRANSCRIPTION_LOCAL_URL
  ) {
    errors.push("MEETING_TRANSCRIPTION_PROVIDER=local-whisper 需要 service URL");
  } else if (transcription === "local-whisper") {
    try {
      const localUrl = new URL(values.MEETING_TRANSCRIPTION_LOCAL_URL);
      if (!["http:", "https:"].includes(localUrl.protocol)) {
        errors.push("MEETING_TRANSCRIPTION_LOCAL_URL 只支援 http 或 https");
      } else if (
        !isLoopbackUrl(localUrl) &&
        !String(values.MEETING_TRANSCRIPTION_LOCAL_TOKEN ?? "").trim()
      ) {
        errors.push("跨主機 MEETING_TRANSCRIPTION_LOCAL_URL 需要 token");
      }
    } catch {
      errors.push("MEETING_TRANSCRIPTION_LOCAL_URL 不是有效 URL");
    }
  }

  if (!["disabled", "minimax", "google-gemini"].includes(minutes)) {
    errors.push(`MEETING_MINUTES_PROVIDER 不支援目前值：${minutes}`);
  } else if (minutes === "minimax" && !values.MINIMAX_API_KEY) {
    errors.push("MEETING_MINUTES_PROVIDER=minimax 需要 MINIMAX_API_KEY");
  } else if (minutes === "google-gemini") {
    const sharedGoogleKey =
      enabled(values.MEETING_ALLOW_SHARED_GEMINI_CREDENTIAL) &&
      values.GOOGLE_GEMINI_API_KEY;
    if (!values.MEETING_MINUTES_GOOGLE_API_KEY && !sharedGoogleKey) {
      errors.push("MEETING_MINUTES_PROVIDER=google-gemini 缺少可用的 Google API key");
    }
  }

  if (enabled(values.DEV_AI_ENABLED)) {
    if (!["minimax", "google", "google-gemini"].includes(devAi)) {
      errors.push(`DEV_AI_PROVIDER 不支援目前值：${devAi}`);
    } else if (devAi === "minimax" && !values.MINIMAX_API_KEY) {
      errors.push("DEV_AI_PROVIDER=minimax 需要 MINIMAX_API_KEY");
    } else if (
      (devAi === "google" || devAi === "google-gemini") &&
      !values.GOOGLE_GEMINI_API_KEY
    ) {
      errors.push("DEV_AI_PROVIDER=google 需要 GOOGLE_GEMINI_API_KEY");
    }
  }

  errors.push(...validateMiniMaxStructuredOutputEnv(values));

  return errors;
}

if (require.main === module) {
  const envPath = path.resolve(process.argv[2] || path.join(process.cwd(), ".env"));
  if (!fs.existsSync(envPath)) {
    console.error(`[provider-env-invalid] 找不到 ${envPath}`);
    process.exitCode = 1;
  } else {
    const errors = validateProviderEnv(dotenv.parse(fs.readFileSync(envPath)));
    if (errors.length > 0) {
      for (const error of errors) console.error(`[provider-env-invalid] ${error}`);
      process.exitCode = 1;
    } else {
      console.log("[provider-env-ok] Meeting 與 Dev AI provider 設定可啟動");
    }
  }
}

module.exports = { validateMiniMaxStructuredOutputEnv, validateProviderEnv };
