import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function runPreflight(content: string) {
  const root = mkdtempSync(path.join(tmpdir(), "provider-env-preflight-"));
  const envFile = path.join(root, ".env");
  writeFileSync(envFile, content);
  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/validate-provider-env.js"), envFile],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  rmSync(root, { recursive: true, force: true });
  return result;
}

test("provider env preflight 在舊 provider 值時於部署停機前失敗", () => {
  const result = runPreflight([
    "MEETING_TRANSCRIPTION_PROVIDER=google-gemini",
    "MEETING_MINUTES_PROVIDER=anthropic-claude",
    "DEV_AI_ENABLED=false",
  ].join("\n"));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /MEETING_TRANSCRIPTION_PROVIDER/);
  assert.match(result.stderr, /MEETING_MINUTES_PROVIDER/);
});

test("provider env preflight 接受 local Whisper 加 MiniMax 的正式設定", () => {
  const result = runPreflight([
    "MEETING_TRANSCRIPTION_PROVIDER=local-whisper",
    "MEETING_TRANSCRIPTION_LOCAL_URL=http://whisper.internal.test/v1/transcriptions",
    "MEETING_TRANSCRIPTION_LOCAL_TOKEN=local-token",
    "MEETING_MINUTES_PROVIDER=minimax",
    "MINIMAX_API_BASE_URL=https://api.minimax.io/anthropic",
    "MINIMAX_API_KEY=minimax-key",
    "MINIMAX_MODEL=MiniMax-M2.7",
    "DEV_AI_ENABLED=true",
    "DEV_AI_PROVIDER=minimax",
  ].join("\n"));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /provider-env-ok/);
});

test("provider env preflight 拒絕非 HTTP local Whisper URL", () => {
  const result = runPreflight([
    "MEETING_TRANSCRIPTION_PROVIDER=local-whisper",
    "MEETING_TRANSCRIPTION_LOCAL_URL=ftp://whisper.internal.test/v1/transcriptions",
    "MEETING_MINUTES_PROVIDER=disabled",
    "DEV_AI_ENABLED=false",
  ].join("\n"));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /只支援 http 或 https/);
});

test("provider env preflight 拒絕沒有 token 的跨主機 local Whisper URL", () => {
  const result = runPreflight([
    "MEETING_TRANSCRIPTION_PROVIDER=local-whisper",
    "MEETING_TRANSCRIPTION_LOCAL_URL=http://whisper.internal.test/v1/transcriptions",
    "MEETING_MINUTES_PROVIDER=disabled",
    "DEV_AI_ENABLED=false",
  ].join("\n"));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /需要 token/);
});

test("provider env preflight 阻擋未通過結構化輸出驗證的 MiniMax model", () => {
  const result = runPreflight([
    "MEETING_TRANSCRIPTION_PROVIDER=disabled",
    "MEETING_MINUTES_PROVIDER=minimax",
    "MINIMAX_API_BASE_URL=https://api.minimax.io/anthropic",
    "MINIMAX_API_KEY=minimax-key",
    "MINIMAX_MODEL=MiniMax-M3",
    "DEV_AI_ENABLED=true",
    "DEV_AI_PROVIDER=minimax",
  ].join("\n"));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /MiniMax-M2\.7/);
  assert.match(result.stderr, /MINIMAX_MODEL=MiniMax-M3/);
});

test("provider env preflight 對空白 Dev AI provider 套用 runtime fallback", () => {
  const result = runPreflight([
    "MEETING_TRANSCRIPTION_PROVIDER=disabled",
    "MEETING_MINUTES_PROVIDER=disabled",
    "MINIMAX_API_BASE_URL=https://api.minimax.io/anthropic",
    "MINIMAX_API_KEY=minimax-key",
    "MINIMAX_MODEL=MiniMax-M3",
    "DEV_AI_ENABLED=true",
    "DEV_AI_PROVIDER=   ",
  ].join("\n"));

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /DEV_AI_PROVIDER 不支援/);
  assert.match(result.stderr, /MiniMax-M2\.7/);
  assert.match(result.stderr, /MINIMAX_MODEL=MiniMax-M3/);
});

test("provider env preflight 的空白 MiniMax URL 與 model 對齊 runtime 預設", () => {
  const result = runPreflight([
    "MEETING_TRANSCRIPTION_PROVIDER=disabled",
    "MEETING_MINUTES_PROVIDER=disabled",
    "MINIMAX_API_KEY=minimax-key",
    "MINIMAX_API_BASE_URL=   ",
    "MINIMAX_MODEL=   ",
    "DEV_AI_ENABLED=true",
    "DEV_AI_PROVIDER=   ",
  ].join("\n"));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /provider-env-ok/);
});
