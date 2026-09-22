import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDevAiRouter, resolveDevAiReadiness } from "../../src/routes/devAi";
import { errorHandler } from "../../src/middleware/errorHandler";
import { HttpError } from "../../src/utils/httpError";
import type { DevAiThreadService } from "../../src/services/dev/ai/devAiThreadService";
import type { DevAiKnowledgeGovernanceService } from "../../src/services/dev/ai/devAiKnowledgeGovernanceService";
import type {
  DevAiKnowledgeCandidate,
  DevAiKnowledgeRuntimeStatus,
  DevAiReadiness,
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
  run: (baseUrl: string) => Promise<void>,
  knowledgeGovernanceService?: DevAiKnowledgeGovernanceService,
  getReadiness?: () => DevAiReadiness
) {
  const app = express();
  app.use(express.json());
  app.use("/api/dev/ai", createDevAiRouter({
    threadService: service,
    knowledgeGovernanceService,
    verifyToken,
    getReadiness,
  }));
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

test("Dev AI readiness 會如實回報 zero-config 停用狀態且不存取 thread", async () => {
  let threadCalled = false;
  const service: DevAiThreadService = {
    async createThread() { threadCalled = true; throw new Error("unused"); },
    async listThreads() { threadCalled = true; return []; },
    async getThreadDetail() { threadCalled = true; throw new Error("unused"); },
    async sendMessage() { threadCalled = true; throw new Error("unused"); },
    async archiveThread() { threadCalled = true; throw new Error("unused"); },
  };
  const readiness: DevAiReadiness = {
    chatAvailable: false,
    knowledge: { available: true, state: "not-required" },
    conversation: { enabled: false },
    provider: { enabled: false, configured: false, name: "minimax" },
    retrieval: { mode: "lexical" },
    reason: "conversation-disabled",
  };

  await withServer(
    service,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/dev/ai/readiness`, {
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, readiness);
    },
    undefined,
    () => readiness
  );
  assert.equal(threadCalled, false, "READINESS_MUST_NOT_TOUCH_THREAD_STORAGE");
});

test("Dev AI readiness 在 hybrid index 未準備時預設關閉 knowledge 但保留一般聊天", () => {
  const runtime: DevAiKnowledgeRuntimeStatus = {
    retrievalMode: "hybrid",
    documents: 3,
    embedding: {
      required: true,
      state: "not-checked",
      profile: "fixture-profile",
      dimensions: 384,
    },
    index: {
      required: true,
      state: "missing",
      profile: "fixture-profile",
      dimensions: 384,
      expectedFingerprint: "sha256:expected",
      storedFingerprint: null,
      expectedChunks: 11,
      storedChunks: 0,
      updatedAt: null,
      errorCode: null,
    },
  };
  const readiness = resolveDevAiReadiness({
    conversationEnabled: true,
    providerEnabled: true,
    providerName: "minimax",
    providerConfigured: true,
    runtime,
  });
  assert.equal(readiness.chatAvailable, true);
  assert.deepEqual(readiness.knowledge, { available: false, state: "missing" });

  runtime.embedding.state = "prepared";
  runtime.index.state = "ready";
  runtime.index.storedFingerprint = runtime.index.expectedFingerprint;
  assert.deepEqual(
    resolveDevAiReadiness({
      conversationEnabled: true,
      providerEnabled: true,
      providerName: "minimax",
      providerConfigured: true,
      runtime,
    }).knowledge,
    { available: true, state: "ready" }
  );
});

function candidate(patch: Partial<DevAiKnowledgeCandidate> = {}): DevAiKnowledgeCandidate {
  return {
    id: "candidate-1",
    kind: "chat-answer",
    status: "pending",
    domain: "ragic",
    title: "報工問題",
    payload: {
      kind: "chat-answer",
      question: "為什麼不能新增？",
      answer: "先確認工令狀態。",
      sourceIds: [],
    },
    sourceKey: "thread:thread-1:message:msg-ai",
    sourceThreadId: "thread-1",
    sourceMessageId: "msg-ai",
    createdBy: "dev-user",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedBy: "dev-user",
    updatedAt: "2026-08-15T00:00:00.000Z",
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    approvedFeedbackId: null,
    ...patch,
  };
}

function knowledgeService(
  overrides: Partial<DevAiKnowledgeGovernanceService> = {}
): DevAiKnowledgeGovernanceService {
  return {
    async submitCandidate() { return { candidate: candidate(), duplicate: false }; },
    async listCandidates() {
      return {
        items: [candidate()],
        counts: { total: 1, pending: 1, publishing: 0, approved: 0, rejected: 0 },
        hasMore: false,
        nextCursor: null,
      };
    },
    async getCandidate() { return candidate(); },
    async updateCandidate() { return candidate(); },
    async approveCandidate() {
      return candidate({ status: "approved", approvedFeedbackId: "candidate-1" });
    },
    async rejectCandidate() { return candidate({ status: "rejected" }); },
    ...overrides,
  };
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
      assert.deepEqual(request?.context, {
        formPath: "default/demo/1",
        fieldId: "7654321",
        position: "Y31",
        sourceLine: 40,
        formulaKind: "formula",
      });
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
      assert.deepEqual(request.context, {
        formPath: "default/demo/1",
        fieldId: "7654321",
        position: "Y31",
        sourceLine: 40,
        formulaKind: "formula",
      });
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
      body: JSON.stringify({
        mode: "auto",
        context: {
          formPath: "default/demo/1",
          fieldId: "7654321",
          position: "Y31",
          sourceLine: 40,
          formulaKind: "formula",
        },
      }),
    });
    assert.equal(createRes.status, 201);

    const sendRes = await fetch(`${baseUrl}/api/dev/ai/threads/thread-1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientMessageId: "message-route-001",
        message: "你好",
        context: {
          formPath: "default/demo/1",
          fieldId: "7654321",
          position: "Y31",
          sourceLine: 40,
          formulaKind: "formula",
        },
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

test("Dev AI knowledge route 會建立 pending 候選並由核准動作發布", async () => {
  const calls: string[] = [];
  const service = knowledgeService({
    async submitCandidate(request, options) {
      calls.push(`submit:${options.actor}:${request.sourceMessageId}`);
      return { candidate: candidate({ payload: request.payload }), duplicate: false };
    },
    async updateCandidate(candidateId, request, options) {
      calls.push(`update:${options.actor}:${candidateId}:${request.title}`);
      return candidate({ title: request.title ?? "報工問題", updatedBy: options.actor });
    },
    async approveCandidate(candidateId, note, options) {
      calls.push(`approve:${options.actor}:${candidateId}:${note}`);
      return candidate({
        status: "approved",
        reviewedBy: options.actor,
        reviewNote: note ?? null,
        approvedFeedbackId: candidateId,
      });
    },
  });
  const threadService: DevAiThreadService = {
    async createThread() { return thread(); },
    async listThreads() { return []; },
    async getThreadDetail() { throw new Error("unused"); },
    async sendMessage() { throw new Error("unused"); },
    async archiveThread() { return thread(); },
  };

  await withServer(
    threadService,
    async (baseUrl) => {
      const headers = {
        Authorization: `Bearer ${VALID_TOKEN}`,
        "Content-Type": "application/json",
      };
      const submitResponse = await fetch(`${baseUrl}/api/dev/ai/knowledge/candidates`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          payload: candidate().payload,
          sourceMessageId: "msg-ai",
        }),
      });
      assert.equal(submitResponse.status, 201);
      assert.equal((await submitResponse.json()).data.candidate.status, "pending");

      const updateResponse = await fetch(
        `${baseUrl}/api/dev/ai/knowledge/candidates/candidate-1`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "已整理報工問題" }),
        }
      );
      assert.equal(updateResponse.status, 200);
      assert.equal((await updateResponse.json()).data.updatedBy, "dev-user");

      const approveResponse = await fetch(
        `${baseUrl}/api/dev/ai/knowledge/candidates/candidate-1/approve`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ note: "來源已核對" }),
        }
      );
      assert.equal(approveResponse.status, 200);
      assert.equal((await approveResponse.json()).data.status, "approved");
    },
    service
  );

  assert.deepEqual(calls, [
    "submit:dev-user:msg-ai",
    "update:dev-user:candidate-1:已整理報工問題",
    "approve:dev-user:candidate-1:來源已核對",
  ]);
});

test("Dev AI knowledge list 會把 cursor 傳給治理 service", async () => {
  let seenCursor: string | undefined;
  const service = knowledgeService({
    async listCandidates(input) {
      seenCursor = input?.cursor;
      return {
        items: [],
        counts: { total: 0, pending: 0, publishing: 0, approved: 0, rejected: 0 },
        hasMore: false,
        nextCursor: null,
      };
    },
  });
  const threadService: DevAiThreadService = {
    async createThread() { return thread(); },
    async listThreads() { return []; },
    async getThreadDetail() { throw new Error("unused"); },
    async sendMessage() { throw new Error("unused"); },
    async archiveThread() { return thread(); },
  };

  await withServer(
    threadService,
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/dev/ai/knowledge/candidates?cursor=opaque-cursor`,
        { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
      );
      assert.equal(response.status, 200);
    },
    service
  );
  assert.equal(seenCursor, "opaque-cursor");
});

test("Dev AI knowledge list 拒絕不合法 limit", async () => {
  let listed = false;
  const service = knowledgeService({
    async listCandidates() {
      listed = true;
      return {
        items: [],
        counts: { total: 0, pending: 0, publishing: 0, approved: 0, rejected: 0 },
        hasMore: false,
        nextCursor: null,
      };
    },
  });
  const threadService: DevAiThreadService = {
    async createThread() { return thread(); },
    async listThreads() { return []; },
    async getThreadDetail() { throw new Error("unused"); },
    async sendMessage() { throw new Error("unused"); },
    async archiveThread() { return thread(); },
  };

  await withServer(
    threadService,
    async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/dev/ai/knowledge/candidates?limit=not-a-number`,
        { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
      );
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "DEV_AI_KNOWLEDGE_BAD_LIMIT");
    },
    service
  );
  assert.equal(listed, false);
});
