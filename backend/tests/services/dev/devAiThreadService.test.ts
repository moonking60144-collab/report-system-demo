import test from "node:test";
import assert from "node:assert/strict";
import { createDevAiThreadRepository } from "../../../src/services/dev/ai/devAiThreadRepository";
import { createDevAiThreadService } from "../../../src/services/dev/ai/devAiThreadService";
import { HttpError } from "../../../src/utils/httpError";
import {
  createDevAiChatService,
  type DevAiChatService,
} from "../../../src/services/dev/ai/devAiChatService";
import type { RagicFormulaAiSuggestionService } from "../../../src/services/dev/ai/ragicFormulaAiSuggestionService";
import type { DevAiChatResult, RagicFormulaAiSuggestResult } from "@shared-types/ragicDefinitions";

function idFactory() {
  let seq = 0;
  return () => `id-${++seq}`;
}

function chatResult(patch: Partial<DevAiChatResult> = {}): DevAiChatResult {
  const { contextSources, citedEvidence, sources, ...rest } = patch;
  return {
    chatId: "chat-1",
    provider: "google",
    model: "gemini-fast",
    threadTitle: "Ragic 問答",
    mode: "general",
    speedMode: "fast",
    answer: "這是回答",
    assumptions: [],
    followUps: [],
    contextPreview: { knowledgeItems: 0, definitionItems: 0, chars: 0 },
    latencyMs: 10,
    ...rest,
    contextSources: contextSources ?? [],
    citedEvidence: citedEvidence ?? [],
    sources: sources ?? [],
  };
}

function formulaResult(patch: Partial<RagicFormulaAiSuggestResult> = {}): RagicFormulaAiSuggestResult {
  return {
    suggestionId: "suggestion-1",
    provider: "google",
    model: "gemini",
    threadTitle: "Ragic 公式調整",
    formPath: "default/devtest/51",
    fieldId: "9001106",
    position: "C6",
    sourceLine: 1,
    formulaKind: "formula",
    proposedFormula: "A1+1",
    explanation: "測試公式",
    assumptions: [],
    referencedFields: [],
    risks: [],
    confidence: "medium",
    dryRun: {
      allowed: true,
      mode: "dry-run",
      formPath: "default/devtest/51",
      formName: "luo test",
      fieldId: "9001106",
      fieldName: "規格",
      position: "C6",
      formulaKind: "formula",
      sourceRelativePath: "default/devtest/51.nui",
      oldFormula: "",
      newFormula: "A1+1",
      builderFilePath: "/tmp/test.nui",
      sourceLine: 1,
      oldLinePreview: null,
      newLinePreview: null,
      gitClean: true,
      warnings: [],
      blockers: [],
    },
    contextPreview: { fields: 1, formulas: 1, siblings: 0, similarItems: 0, chars: 100 },
    ...patch,
  };
}

test("Dev AI thread service disabled 時不寫 DB 也不呼叫模型", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let called = false;
  const service = createDevAiThreadService({
    enabled: false,
    repository: repo,
    chatService: {
      async ask() {
        called = true;
        return chatResult();
      },
    },
  });

  await assert.rejects(
    () => service.createThread("dev", { title: "x" }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_CONVERSATION_DISABLED"
  );
  assert.equal(called, false);
  assert.equal((await repo.listThreads("dev", 10)).length, 0);
  await repo.close();
});

test("Dev AI thread service 會保存 chat 對話與 artifact，並隔離 actor", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const contextSource = {
    sourceId: "guide:operations",
    title: "操作指南",
    kind: "curated" as const,
    excerpt: "這是提供給模型的完整 context。",
    score: 8,
  };
  const citedSource = {
    sourceId: "guide:verified",
    title: "已引用規則",
    kind: "curated" as const,
    excerpt: "這是模型實際引用的證據。",
    score: 9,
  };
  const chatService: DevAiChatService = {
    async ask(request, options) {
      assert.equal(options?.actor, "alice");
      assert.match(request.question, /系統用途/);
      return chatResult({
        answer: "這是示範系統。",
        contextSources: [contextSource, citedSource],
        citedEvidence: [citedSource],
        sources: [citedSource],
      });
    },
  };
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService,
    threadContextMessages: 4,
  });

  const thread = await service.createThread("alice", { title: "問答" });
  const result = await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-001",
    message: "這個系統用途是什麼？",
  });

  assert.equal(result.intent, "general");
  assert.equal(result.chat?.answer, "這是示範系統。");
  assert.equal(result.artifacts[0].type, "chat-result");
  assert.deepEqual(result.artifacts[0].payload.contextSources, [contextSource, citedSource]);
  assert.deepEqual(result.artifacts[0].payload.citedEvidence, [citedSource]);
  assert.deepEqual(result.artifacts[0].payload.sources, [citedSource]);
  assert.equal(result.artifacts[1].type, "knowledge-candidate");
  assert.equal(result.artifacts[1].payload.status, "pending");
  assert.deepEqual(result.artifacts[1].payload.sourceIds, ["guide:verified"]);
  assert.match(String(result.artifacts[1].payload.note), /不會自動進入 RAG/);
  assert.equal((await service.getThreadDetail("alice", thread.id)).messages.length, 2);
  await assert.rejects(
    () => service.getThreadDetail("bob", thread.id),
    (error) => error instanceof HttpError && error.code === "DEV_AI_THREAD_NOT_FOUND"
  );
  await repo.close();
});

test("Dev AI thread 第一輪完成後採用模型產生的標題", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        return chatResult({ threadTitle: "Ragic 欄位來源" });
      },
    },
  });
  const thread = await service.createThread("alice");

  const result = await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-title-001",
    message: "這個欄位從哪裡來？",
  });

  assert.equal(thread.title, "新的 Dev AI 對話");
  assert.equal(result.thread.title, "Ragic 欄位來源", "THREAD_TITLE_CONTRACT");
  assert.equal((await repo.getThread("alice", thread.id))?.title, "Ragic 欄位來源");
  await repo.close();
});

test("Dev AI thread 問題回顧只計當前使用者的 user 訊息", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const chatService = createDevAiChatService({
    config: { enabled: true, provider: "minimax" },
    providerClient: {
      name: "minimax",
      model: "fixture",
      async generateJsonText() { assert.fail("RECALL_MUST_NOT_CALL_MODEL"); },
    },
    knowledgeService: {
      invalidateCache() {},
      async search() { assert.fail("RECALL_MUST_NOT_RETRIEVE"); },
    },
    definitionsService: {
      async search() { assert.fail("RECALL_MUST_NOT_SEARCH_DEFINITIONS"); },
    },
  });
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService,
    threadContextMessages: 8,
  });
  const thread = await service.createThread("alice", { title: "問題回顧" });
  for (const content of ["Ragic 是什麼？", "公式會自動重算嗎？", "Workflow 能用 setTimeout 嗎？"]) {
    await repo.appendMessage({
      threadId: thread.id,
      ownerActor: "alice",
      role: "user",
      content,
      now: "2026-09-22T00:00:00.000Z",
    });
    await repo.appendMessage({
      threadId: thread.id,
      ownerActor: "alice",
      role: "assistant",
      content: "這是助手回答，不是使用者問題。",
      now: "2026-09-22T00:00:01.000Z",
    });
  }

  const result = await service.sendMessage("alice", thread.id, {
    clientMessageId: "recall-message-001",
    message: "我上上個問題是問什麼？",
  });

  assert.equal(result.assistantMessage.content, "你的上上個問題是：「公式會自動重算嗎？」");
  assert.equal(result.chat?.provider, "local");
  assert.equal(result.chat?.providerAttempts, 0);
  await repo.close();
});

test("Dev AI thread 會把目前 formPath 與 fieldId 傳給 definitions retrieval", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const chatService: DevAiChatService = {
    async ask(request) {
      assert.equal(request.mode, "definitions");
      assert.equal(request.formPath, "default/devtest/7");
      assert.equal(request.fieldId, "9001111");
      return chatResult({ mode: "definitions" });
    },
  };
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService,
  });
  const thread = await service.createThread("alice", {
    mode: "definitions",
    context: { formPath: "default/devtest/7", fieldId: "9001111" },
  });

  const result = await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-002",
    message: "這個 Name 欄位來源是什麼？",
  });

  assert.equal(result.intent, "definitions");
  await repo.close();
});

test("Dev AI thread 從當前提問辨識表單路徑並持久化", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask(request) {
        assert.equal(request.mode, "definitions");
        assert.equal(request.formPath, "default/forms999/9002");
        return chatResult({ mode: "definitions" });
      },
    },
  });
  const thread = await service.createThread("alice");

  const result = await service.sendMessage("alice", thread.id, {
    clientMessageId: "form-message-001",
    message: "請說明 https://demo.example/default/forms999/9002/123?PAGEID=demo 的欄位",
  });

  assert.equal(result.thread.context.formPath, "default/forms999/9002");
  assert.equal((await repo.getThread("alice", thread.id))?.context.formPath, "default/forms999/9002");
  await repo.close();
});

test("Dev AI thread 不把日期或程式路徑留在表單 context", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask(request) {
        assert.equal(request.formPath, undefined);
        assert.equal(request.fieldId, "7654321");
        return chatResult({ mode: "definitions" });
      },
    },
  });
  const invalid = await service.createThread("alice", {
    context: {
      formPath: "2026/09/22",
      fieldId: "1234567",
      position: "f25",
      sourceLine: 25,
      formulaKind: "formula",
    },
  });
  assert.deepEqual(invalid.context, {
    fieldId: "1234567",
    position: "F25",
    sourceLine: 25,
    formulaKind: "formula",
  });

  const selected = await service.createThread("alice", {
    context: {
      formPath: "default/forms999/9002",
      fieldId: "1234567",
      position: "F25",
      sourceLine: 25,
    },
  });
  const result = await service.sendMessage("alice", selected.id, {
    clientMessageId: "invalid-form-update-001",
    message: "這個欄位是什麼？",
    context: {
      formPath: "backend/src/example",
      fieldId: "7654321",
      position: "f26",
      sourceLine: 26,
    },
  });
  assert.deepEqual(result.thread.context, {
    fieldId: "7654321",
    position: "F26",
    sourceLine: 26,
  });
  await repo.close();
});

test("Dev AI thread 同一題出現多張表單時要求先釐清", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: { async ask() { assert.fail("AMBIGUOUS_FORM_MUST_NOT_CALL_CHAT"); } },
  });
  const thread = await service.createThread("alice");

  await assert.rejects(
    () => service.sendMessage("alice", thread.id, {
      clientMessageId: "ambiguous-form-001",
      message: "比較 default/forms999/9001 與 default/forms999/9002",
    }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_FORM_AMBIGUOUS"
  );
  assert.equal((await repo.listMessages("alice", thread.id)).length, 0);
  await repo.close();
});

test("Dev AI thread 切換 occurrence 時不沿用舊 sourceLine", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const formulaService: RagicFormulaAiSuggestionService = {
    async suggestFormula(request) {
      assert.equal(request.position, "D6");
      assert.equal(request.sourceLine, undefined);
      return formulaResult({ position: "D6", sourceLine: 2 });
    },
  };
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: { async ask() { return chatResult(); } },
    formulaService,
  });
  const thread = await service.createThread("alice", {
    mode: "formula",
    context: {
      formPath: "default/devtest/51",
      fieldId: "9001106",
      position: "C6",
      sourceLine: 1,
      formulaKind: "formula",
    },
  });

  await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-occurrence-001",
    message: "切換到另一個位置",
    context: { position: "D6" },
  });

  assert.deepEqual((await repo.getThread("alice", thread.id))?.context, {
    formPath: "default/devtest/51",
    fieldId: "9001106",
    position: "D6",
    formulaKind: "formula",
  });
  await repo.close();
});

test("Dev AI thread service auto intent 命中公式時只走 suggestion/dry-run，不呼叫 chat", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let chatCalled = false;
  let formulaCalled = false;
  const chatService: DevAiChatService = {
    async ask() {
      chatCalled = true;
      return chatResult();
    },
  };
  const formulaService: RagicFormulaAiSuggestionService = {
    async suggestFormula(request) {
      formulaCalled = true;
      assert.equal(request.formPath, "default/devtest/51");
      assert.equal(request.fieldId, "9001106");
      assert.equal(request.objective, "幫我把公式改成空值回傳 0");
      return formulaResult();
    },
  };
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService,
    formulaService,
  });

  const thread = await service.createThread("alice", {
    mode: "auto",
    context: { formPath: "default/devtest/51", fieldId: "9001106", formulaKind: "formula" },
  });
  const result = await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-003",
    message: "幫我把公式改成空值回傳 0",
  });

  assert.equal(result.intent, "formula");
  assert.equal(result.formula?.proposedFormula, "A1+1");
  assert.deepEqual(result.artifacts.map((item) => item.type), [
    "formula-suggestion",
    "dry-run",
    "knowledge-candidate",
  ]);
  assert.equal(result.artifacts[2].payload.status, "pending");
  assert.equal(result.artifacts[2].payload.kind, "formula-suggestion");
  assert.equal(formulaCalled, true);
  assert.equal(chatCalled, false);
  await repo.close();
});

test("Dev AI thread service 公式缺 context 時不寫入失敗 user message", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let formulaCalled = false;
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: { async ask() { return chatResult(); } },
    formulaService: {
      async suggestFormula() {
        formulaCalled = true;
        return formulaResult();
      },
    },
  });
  const thread = await service.createThread("alice", { mode: "formula" });

  await assert.rejects(
    () =>
      service.sendMessage("alice", thread.id, {
        clientMessageId: "message-004",
        message: "幫我改公式",
      }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_FORMULA_CONTEXT_REQUIRED"
  );

  assert.equal(formulaCalled, false);
  assert.equal((await repo.listMessages("alice", thread.id)).length, 0);
  await repo.close();
});

test("Dev AI thread service 下游 chat 失敗時不留下 completed user message", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        throw new HttpError(429, "Google API 配額或速率限制", "DEV_AI_PROVIDER_RATE_LIMITED");
      },
    },
  });
  const thread = await service.createThread("alice", { title: "失敗測試" });

  await assert.rejects(
    () =>
      service.sendMessage("alice", thread.id, {
        clientMessageId: "message-005",
        message: "這句會失敗",
      }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_PROVIDER_RATE_LIMITED"
  );

  assert.equal((await repo.listMessages("alice", thread.id)).length, 0);
  assert.equal((await repo.getThread("alice", thread.id))?.lastMessagePreview, "");
  await repo.close();
});

test("Dev AI thread service 不把 failed message 帶進 thread memory", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const chatService: DevAiChatService = {
    async ask(request) {
      assert.equal(request.question, "下一題");
      assert.match(request.conversationContext ?? "", /有效上下文/);
      assert.doesNotMatch(request.conversationContext ?? "", /失敗上下文/);
      return chatResult();
    },
  };
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService,
    threadContextMessages: 10,
  });
  const thread = await service.createThread("alice", { title: "memory filter" });
  await repo.appendMessage({
    ownerActor: "alice",
    threadId: thread.id,
    role: "user",
    content: "失敗上下文",
    intent: "general",
    status: "failed",
    now: "2026-07-03T00:00:01.000Z",
  });
  await repo.appendMessage({
    ownerActor: "alice",
    threadId: thread.id,
    role: "assistant",
    content: "有效上下文",
    intent: "general",
    now: "2026-07-03T00:00:02.000Z",
  });

  await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-006",
    message: "下一題",
  });
  await repo.close();
});

test("Dev AI thread service summary 只更新 thread-local summary", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const service = createDevAiThreadService({
    enabled: true,
    summaryEnabled: true,
    summaryAfterMessages: 4,
    repository: repo,
    chatService: { async ask() { return chatResult(); } },
  });
  const thread = await service.createThread("alice", { title: "長對話" });

  await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-007",
    message: "第一句",
  });
  const final = await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-008",
    message: "第二句",
  });

  assert.ok(final.thread.summary?.includes("第一句"));
  assert.equal(final.summaryUsed, false);
  const detail = await service.getThreadDetail("alice", thread.id);
  assert.equal(detail.summaryUsed, true);
  await repo.close();
});

test("Dev AI thread service 預設一問一答後會建立 thread summary", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  const service = createDevAiThreadService({
    enabled: true,
    summaryEnabled: true,
    summaryAfterMessages: 2,
    repository: repo,
    chatService: { async ask() { return chatResult({ answer: "這是可整理的回答" }); } },
  });
  const thread = await service.createThread("alice", { title: "summary" });

  const result = await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-009",
    message: "請整理 Dev AI 流程",
  });

  assert.match(result.thread.summary ?? "", /請整理 Dev AI 流程/);
  assert.match(result.thread.summary ?? "", /這是可整理的回答/);
  assert.equal(result.summaryUsed, false);
  await repo.close();
});

test("Dev AI thread service 寫入後會裁剪 thread messages 與 artifacts", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let tick = 0;
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: { async ask() { return chatResult(); } },
    maxMessagesPerThread: 3,
    maxArtifactsPerThread: 2,
    threadDetailMessageLimit: 10,
    threadDetailArtifactLimit: 10,
    now: () => new Date(Date.UTC(2026, 6, 3, 0, 0, tick++)),
  });
  const thread = await service.createThread("alice", { title: "retention" });

  await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-010",
    message: "第一句",
  });
  await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-011",
    message: "第二句",
  });

  const detail = await service.getThreadDetail("alice", thread.id);
  assert.deepEqual(
    detail.messages.map((message) => message.content),
    ["這是回答", "第二句", "這是回答"]
  );
  assert.equal(detail.artifacts.length, 2);
  await repo.close();
});

test("Dev AI thread service 同 clientMessageId 的併發請求只呼叫 provider 一次", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let askCalls = 0;
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        askCalls += 1;
        markStarted();
        await gate;
        return chatResult({ answer: "只產生一次" });
      },
    },
  });
  const thread = await service.createThread("alice", { title: "dedupe" });
  const request = {
    clientMessageId: "message-dedupe-001",
    message: "同一題",
  };

  const first = service.sendMessage("alice", thread.id, request);
  await started;
  const second = service.sendMessage("alice", thread.id, request);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(askCalls, 1);
  assert.equal(firstResult.userMessage.id, secondResult.userMessage.id);
  assert.equal(firstResult.assistantMessage.id, secondResult.assistantMessage.id);
  assert.equal((await repo.listMessages("alice", thread.id)).length, 2);
  await repo.close();
});

test("Dev AI thread service 相同 clientMessageId 搭配不同 payload 會回 409", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let askCalls = 0;
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        askCalls += 1;
        return chatResult();
      },
    },
  });
  const thread = await service.createThread("alice", { title: "conflict" });

  await service.sendMessage("alice", thread.id, {
    clientMessageId: "message-conflict-001",
    message: "第一題",
  });
  await assert.rejects(
    () =>
      service.sendMessage("alice", thread.id, {
        clientMessageId: "message-conflict-001",
        message: "不同題",
      }),
    (error) =>
      error instanceof HttpError && error.code === "DEV_AI_CLIENT_MESSAGE_ID_CONFLICT"
  );

  assert.equal(askCalls, 1);
  await repo.close();
});

test("Dev AI thread service provider 失敗後可用原 clientMessageId 重試", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let askCalls = 0;
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        askCalls += 1;
        if (askCalls === 1) {
          throw new HttpError(502, "暫時失敗", "DEV_AI_PROVIDER_FAILED");
        }
        return chatResult({ answer: "重試成功" });
      },
    },
  });
  const thread = await service.createThread("alice", { title: "retry" });
  const request = {
    clientMessageId: "message-retry-001",
    message: "請重試",
  };

  await assert.rejects(
    () => service.sendMessage("alice", thread.id, request),
    (error) => error instanceof HttpError && error.code === "DEV_AI_PROVIDER_FAILED"
  );
  const result = await service.sendMessage("alice", thread.id, request);

  assert.equal(result.assistantMessage.content, "重試成功");
  assert.equal(askCalls, 2);
  assert.equal((await repo.listMessages("alice", thread.id)).length, 2);
  await repo.close();
});

test("Dev AI thread service 不同 clientMessageId 在同一 thread 仍會串行", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let active = 0;
  let maxActive = 0;
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return chatResult();
      },
    },
  });
  const thread = await service.createThread("alice", { title: "serial" });

  await Promise.all([
    service.sendMessage("alice", thread.id, {
      clientMessageId: "message-serial-001",
      message: "第一題",
    }),
    service.sendMessage("alice", thread.id, {
      clientMessageId: "message-serial-002",
      message: "第二題",
    }),
  ]);

  assert.equal(maxActive, 1);
  await repo.close();
});

test("Dev AI thread service 新 instance 會重放 SQLite 已完成結果", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let askCalls = 0;
  const firstService = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        askCalls += 1;
        return chatResult({ answer: "持久結果" });
      },
    },
  });
  const thread = await firstService.createThread("alice", { title: "replay" });
  const request = {
    clientMessageId: "message-replay-001",
    message: "同一題",
  };
  const first = await firstService.sendMessage("alice", thread.id, request);

  const secondService = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        throw new Error("completed request must not call provider again");
      },
    },
  });
  const replayed = await secondService.sendMessage("alice", thread.id, request);

  assert.equal(askCalls, 1);
  assert.equal(replayed.assistantMessage.id, first.assistantMessage.id);
  await repo.close();
});

test("Dev AI thread service 不允許已封存 thread 再呼叫 provider 或寫入訊息", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let askCalls = 0;
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        askCalls += 1;
        return chatResult();
      },
    },
  });
  const thread = await service.createThread("alice", { title: "archive" });
  await service.archiveThread("alice", thread.id);

  await assert.rejects(
    () => service.sendMessage("alice", thread.id, {
      clientMessageId: "message-archived-001",
      message: "封存後不應送出",
    }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_THREAD_ARCHIVED",
    "THREAD_ARCHIVE_CONTRACT"
  );

  assert.equal(askCalls, 0);
  assert.equal((await repo.listMessages("alice", thread.id)).length, 0);
  await repo.close();
});

test("Dev AI thread service 等待進行中的訊息完成後才封存同一 thread", async () => {
  const repo = createDevAiThreadRepository({ dbFile: ":memory:", idFactory: idFactory() });
  let askCalls = 0;
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService: {
      async ask() {
        askCalls += 1;
        markStarted();
        await gate;
        return chatResult({ answer: "完成中的回答" });
      },
    },
  });
  const thread = await service.createThread("alice", { title: "archive-race" });
  const send = service.sendMessage("alice", thread.id, {
    clientMessageId: "message-archive-race-001",
    message: "先完成這題",
  });
  await started;

  let archiveSettled = false;
  const archive = service.archiveThread("alice", thread.id).then((value) => {
    archiveSettled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(archiveSettled, false);

  release();
  await send;
  const archived = await archive;
  assert.ok(archived.archivedAt);
  await assert.rejects(
    () => service.sendMessage("alice", thread.id, {
      clientMessageId: "message-archive-race-002",
      message: "封存後的新訊息",
    }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_THREAD_ARCHIVED"
  );
  assert.equal(askCalls, 1);
  assert.equal((await repo.listMessages("alice", thread.id)).length, 2);
  await repo.close();
});
