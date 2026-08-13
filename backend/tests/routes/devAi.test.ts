import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDevAiRouter } from "../../src/routes/devAi";
import { errorHandler } from "../../src/middleware/errorHandler";
import { HttpError } from "../../src/utils/httpError";
import type { DevAiThreadService } from "../../src/services/dev/ai/devAiThreadService";
import type {
  DevAiSendMessageResult,
  DevAiThread,
  DevAiThreadDetail,
} from "@shared-types/ragicDefinitions";

const VALID_TOKEN = "test-token-valid";

function verifyToken(header: string | undefined) {
  const raw = String(header ?? "").trim();
  if (!raw) throw new HttpError(401, "no token", "NOTICE_TOKEN_MISSING");
  const [scheme, token] = raw.split(/\s+/, 2);
  if (scheme.toLowerCase() !== "bearer" || token !== VALID_TOKEN) {
    throw new HttpError(401, "bad token", "NOTICE_TOKEN_INVALID");
  }
  return { username: "dev-user" };
}

function thread(patch: Partial<DevAiThread> = {}): DevAiThread {
  return {
    id: "thread-1",
    ownerActor: "dev-user",
    title: "Thread",
    mode: "auto",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    archivedAt: null,
    context: {},
    lastMessagePreview: "",
    summary: null,
    summaryUpdatedAt: null,
    summaryMessageId: null,
    ...patch,
  };
}

async function withServer(
  service: DevAiThreadService,
  run: (baseUrl: string) => Promise<void>
) {
  const app = express();
  app.use(express.json());
  app.use("/api/dev/ai", createDevAiRouter({ threadService: service, verifyToken }));
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const next = app.listen(0, () => resolve(next));
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("Dev AI route 無 token 會先被 Dev auth 擋下", async () => {
  let called = false;
  const service: DevAiThreadService = {
    async createThread() { called = true; return thread(); },
    async listThreads() { called = true; return []; },
    async getThreadDetail() { called = true; throw new Error("unused"); },
    async sendMessage() { called = true; throw new Error("unused"); },
    async archiveThread() { called = true; return thread(); },
  };

  await withServer(service, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ai/threads`);
    assert.equal(res.status, 401);
  });
  assert.equal(called, false);
});

test("Dev AI route 可建立 thread 並送 message", async () => {
  const calls: string[] = [];
  const detail: DevAiThreadDetail = {
    thread: thread(),
    messages: [],
    artifacts: [],
  };
  const result: DevAiSendMessageResult = {
    thread: thread({ lastMessagePreview: "你好" }),
    userMessage: {
      id: "msg-user",
      threadId: "thread-1",
      role: "user",
      content: "你好",
      intent: "general",
      model: null,
      status: "completed",
      createdAt: "2026-07-03T00:00:01.000Z",
      metadata: {},
    },
    assistantMessage: {
      id: "msg-ai",
      threadId: "thread-1",
      role: "assistant",
      content: "回答",
      intent: "general",
      model: "gemini",
      status: "completed",
      createdAt: "2026-07-03T00:00:02.000Z",
      metadata: {},
    },
    artifacts: [],
    intent: "general",
  };
  const service: DevAiThreadService = {
    async createThread(actor, request) {
      calls.push(`create:${actor}:${request?.mode ?? ""}`);
      return thread({ mode: request?.mode ?? "auto" });
    },
    async listThreads(actor) {
      calls.push(`list:${actor}`);
      return [thread()];
    },
    async getThreadDetail(actor, threadId) {
      calls.push(`get:${actor}:${threadId}`);
      return detail;
    },
    async sendMessage(actor, threadId, request) {
      calls.push(
        `send:${actor}:${threadId}:${request.clientMessageId}:${request.message}`
      );
      return result;
    },
    async archiveThread(actor, threadId) {
      calls.push(`archive:${actor}:${threadId}`);
      return thread({ archivedAt: "2026-07-03T00:00:03.000Z" });
    },
  };

  await withServer(service, async (baseUrl) => {
    const headers = {
      Authorization: `Bearer ${VALID_TOKEN}`,
      "Content-Type": "application/json",
    };
    const createRes = await fetch(`${baseUrl}/api/dev/ai/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "auto" }),
    });
    assert.equal(createRes.status, 201);

    const sendRes = await fetch(`${baseUrl}/api/dev/ai/threads/thread-1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientMessageId: "message-route-001",
        message: "你好",
      }),
    });
    assert.equal(sendRes.status, 200);
    assert.equal((await sendRes.json()).data.intent, "general");
  });

  assert.deepEqual(calls, [
    "create:dev-user:auto",
    "send:dev-user:thread-1:message-route-001:你好",
  ]);
});

test("Dev AI message route 缺 clientMessageId 時不呼叫 service", async () => {
  let sendCalled = false;
  const service: DevAiThreadService = {
    async createThread() { return thread(); },
    async listThreads() { return []; },
    async getThreadDetail() { throw new Error("unused"); },
    async sendMessage() {
      sendCalled = true;
      throw new Error("must not be called");
    },
    async archiveThread() { return thread(); },
  };

  await withServer(service, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/dev/ai/threads/thread-1/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "缺少冪等鍵" }),
      }
    );
    assert.equal(response.status, 400);
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "DEV_AI_CLIENT_MESSAGE_ID_REQUIRED");
  });
  assert.equal(sendCalled, false);
});

test("Dev AI message request 中斷時會 abort 尚未完成的 provider 工作", async () => {
  let observedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const service: DevAiThreadService = {
    async createThread() { return thread(); },
    async listThreads() { return []; },
    async getThreadDetail() { throw new Error("unused"); },
    async sendMessage(_actor, _threadId, _request, options) {
      observedSignal = options?.signal;
      markStarted();
      if (!observedSignal) throw new Error("missing abort signal");
      return new Promise<DevAiSendMessageResult>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => {
            markAborted();
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true }
        );
      });
    },
    async archiveThread() { return thread(); },
  };

  await withServer(service, async (baseUrl) => {
    const url = new URL(`${baseUrl}/api/dev/ai/threads/thread-1/messages`);
    const body = JSON.stringify({
      clientMessageId: "message-route-abort-001",
      message: "請產生長回答",
    });
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    });
    request.on("error", () => {});
    request.end(body);

    await started;
    assert.ok(observedSignal);
    request.destroy();
    await aborted;
    assert.equal(observedSignal.aborted, true);
  });
});
