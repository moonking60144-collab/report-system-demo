import assert from "node:assert/strict";
import test from "node:test";
import { createMiniMaxClient } from "../../../src/services/dev/ai/minimaxClient";
import { normalizeDevAiProviderName } from "../../../src/services/dev/ai/devAiProviderFactory";
import { MiniMaxRequestQueueTimeoutError } from "../../../src/infra/minimaxRequestScheduler";
import { HttpError } from "../../../src/utils/httpError";

const immediateScheduler = {
  run<T>(worker: () => Promise<T>): Promise<T> {
    return worker();
  },
};

test("MiniMax client 以強制 tool use 送出 schema 並回傳 JSON 文字", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = createMiniMaxClient(
    {
      apiKey: "minimax-key",
      model: "MiniMax-M3",
      timeoutMs: 1_000,
      maxOutputTokens: 2_048,
      baseUrl: "https://minimax.example/anthropic/",
      queueTimeoutMs: 1_000,
    },
    (async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "submit_structured_result",
              input: { answer: "ok", items: [], detail: { reason: "test" } },
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 }
      );
    }) as typeof fetch,
    immediateScheduler
  );

  const output = await client.generateJsonText({
    prompt: "test prompt",
    schema: {
      type: "object",
      properties: {
        answer: { type: "string", maxLength: 100 },
        items: { type: "array", maxItems: 5, items: { type: "string" } },
        detail: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
      },
      required: ["answer", "items", "detail"],
    },
    effort: "medium",
    maxOutputTokens: 321,
  });

  assert.equal(client.name, "minimax");
  assert.deepEqual(JSON.parse(output), {
    answer: "ok",
    items: [],
    detail: { reason: "test" },
  });
  assert.equal(capturedUrl, "https://minimax.example/anthropic/v1/messages");
  assert.ok(capturedInit);
  const headers = capturedInit.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "minimax-key");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(String(capturedInit.body)) as Record<string, unknown>;
  assert.equal(body.model, "MiniMax-M3");
  assert.equal(body.max_tokens, 321);
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "test prompt" }] },
  ]);
  assert.deepEqual(body.tool_choice, {
    type: "tool",
    name: "submit_structured_result",
  });
  const tools = body.tools as Array<{
    name: string;
    input_schema: {
      properties: Record<string, Record<string, unknown>>;
    };
  }>;
  assert.equal(tools[0]?.name, "submit_structured_result");
  assert.equal(tools[0]?.input_schema.properties.answer.maxLength, 100);
  assert.equal(tools[0]?.input_schema.properties.items.maxItems, 5);
});

test("MiniMax client 的低 effort 會明確關閉 thinking", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const client = createMiniMaxClient(
    {
      apiKey: "minimax-key",
      model: "MiniMax-M3",
      timeoutMs: 1_000,
      maxOutputTokens: 2_048,
      baseUrl: "https://minimax.example/anthropic",
      queueTimeoutMs: 1_000,
    },
    (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "submit_structured_result",
              input: { answer: "ok" },
            },
          ],
          stop_reason: "tool_use",
        }),
        { status: 200 }
      );
    }) as typeof fetch,
    immediateScheduler
  );

  await client.generateJsonText({
    prompt: "x",
    schema: { type: "object" },
    effort: "low",
  });

  assert.ok(capturedBody);
  assert.deepEqual((capturedBody as Record<string, unknown>).thinking, {
    type: "disabled",
  });
});

test("MiniMax client 將授權、model、配額與服務錯誤分類", async () => {
  for (const [status, code] of [
    [401, "DEV_AI_MINIMAX_AUTH_FAILED"],
    [404, "DEV_AI_MINIMAX_MODEL_NOT_FOUND"],
    [429, "DEV_AI_MINIMAX_RATE_LIMITED"],
    [503, "DEV_AI_MINIMAX_UNAVAILABLE"],
  ] as const) {
    const client = createMiniMaxClient(
      {
        apiKey: "minimax-key",
        model: "MiniMax-M3",
        timeoutMs: 1_000,
        maxOutputTokens: 2_048,
        baseUrl: "https://minimax.example/anthropic",
        queueTimeoutMs: 1_000,
      },
      (async () => new Response("{}", { status })) as typeof fetch,
      immediateScheduler
    );
    await assert.rejects(
      () => client.generateJsonText({ prompt: "x", schema: { type: "object" } }),
      (error) => error instanceof HttpError && error.code === code
    );
  }
});

test("MiniMax client 明確區分輸出截斷與 timeout", async () => {
  const truncatedClient = createMiniMaxClient(
    {
      apiKey: "minimax-key",
      model: "MiniMax-M3",
      timeoutMs: 1_000,
      maxOutputTokens: 2_048,
      baseUrl: "https://minimax.example/anthropic",
      queueTimeoutMs: 1_000,
    },
    (async () =>
      new Response(
        JSON.stringify({ content: [], stop_reason: "max_tokens" }),
        { status: 200 }
      )) as typeof fetch,
    immediateScheduler
  );
  await assert.rejects(
    () =>
      truncatedClient.generateJsonText({
        prompt: "x",
        schema: { type: "object" },
      }),
    (error) =>
      error instanceof HttpError &&
      error.code === "DEV_AI_MINIMAX_OUTPUT_TRUNCATED"
  );

  const timeoutClient = createMiniMaxClient(
    {
      apiKey: "minimax-key",
      model: "MiniMax-M3",
      timeoutMs: 5,
      maxOutputTokens: 2_048,
      baseUrl: "https://minimax.example/anthropic",
      queueTimeoutMs: 1_000,
    },
    (async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch,
    immediateScheduler
  );
  await assert.rejects(
    () => timeoutClient.generateJsonText({ prompt: "x", schema: { type: "object" } }),
    (error) =>
      error instanceof HttpError && error.code === "DEV_AI_MINIMAX_TIMEOUT"
  );
});

test("MiniMax client 缺少 tool input 或排隊逾時時 fail-closed", async () => {
  const config = {
    apiKey: "minimax-key",
    model: "MiniMax-M3",
    timeoutMs: 1_000,
    maxOutputTokens: 2_048,
    baseUrl: "https://minimax.example/anthropic",
    queueTimeoutMs: 1_000,
  };
  const missingTool = createMiniMaxClient(
    config,
    (async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "not a tool result" }],
          stop_reason: "end_turn",
        }),
        { status: 200 }
      )) as typeof fetch,
    immediateScheduler
  );
  await assert.rejects(
    () => missingTool.generateJsonText({ prompt: "x", schema: { type: "object" } }),
    (error) =>
      error instanceof HttpError && error.code === "DEV_AI_MINIMAX_BAD_RESPONSE"
  );

  const busy = createMiniMaxClient(config, fetch, {
    async run<T>(): Promise<T> {
      throw new MiniMaxRequestQueueTimeoutError();
    },
  });
  await assert.rejects(
    () => busy.generateJsonText({ prompt: "x", schema: { type: "object" } }),
    (error) =>
      error instanceof HttpError && error.code === "DEV_AI_MINIMAX_QUEUE_TIMEOUT"
  );
});

test("Dev AI provider 名稱只接受 MiniMax 與明確 Gemini fallback", () => {
  assert.equal(normalizeDevAiProviderName("minimax"), "minimax");
  assert.equal(normalizeDevAiProviderName("google"), "google");
  assert.equal(normalizeDevAiProviderName("google-gemini"), "google");
  assert.equal(normalizeDevAiProviderName("anthropic-claude"), null);
  assert.equal(normalizeDevAiProviderName("unknown"), null);
});
