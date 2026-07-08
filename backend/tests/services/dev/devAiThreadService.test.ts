import test from "node:test";
import assert from "node:assert/strict";
import { createDevAiThreadRepository } from "../../../src/services/dev/ai/devAiThreadRepository";
import { createDevAiThreadService } from "../../../src/services/dev/ai/devAiThreadService";
import { HttpError } from "../../../src/utils/httpError";
import type { DevAiChatService } from "../../../src/services/dev/ai/devAiChatService";
import type { RagicFormulaAiSuggestionService } from "../../../src/services/dev/ai/ragicFormulaAiSuggestionService";
import type { DevAiChatResult, RagicFormulaAiSuggestResult } from "@shared-types/ragicDefinitions";

function idFactory() {
  let seq = 0;
  return () => `id-${++seq}`;
}

function chatResult(patch: Partial<DevAiChatResult> = {}): DevAiChatResult {
  return {
    chatId: "chat-1",
    provider: "google",
    model: "gemini-fast",
    mode: "general",
    speedMode: "fast",
    answer: "這是回答",
    assumptions: [],
    followUps: [],
    sources: [],
    contextPreview: { knowledgeItems: 0, definitionItems: 0, chars: 0 },
    latencyMs: 10,
    ...patch,
  };
}

function formulaResult(patch: Partial<RagicFormulaAiSuggestResult> = {}): RagicFormulaAiSuggestResult {
  return {
    suggestionId: "suggestion-1",
    provider: "google",
    model: "gemini",
    formPath: "default/devtest/51",
    fieldId: "1036621",
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
      fieldId: "1036621",
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
  const chatService: DevAiChatService = {
    async ask(request, options) {
      assert.equal(options?.actor, "alice");
      assert.match(request.question, /Funda 是什麼/);
      return chatResult({ answer: "Funda 是內部系統" });
    },
  };
  const service = createDevAiThreadService({
    enabled: true,
    repository: repo,
    chatService,
    threadContextMessages: 4,
  });

  const thread = await service.createThread("alice", { title: "問答" });
  const result = await service.sendMessage("alice", thread.id, { message: "Funda 是什麼？" });

  assert.equal(result.intent, "general");
  assert.equal(result.chat?.answer, "Funda 是內部系統");
  assert.equal(result.artifacts[0].type, "chat-result");
  assert.equal(result.artifacts[1].type, "knowledge-candidate");
  assert.equal(result.artifacts[1].payload.status, "pending");
  assert.match(String(result.artifacts[1].payload.note), /不會自動進入 RAG/);
  assert.equal((await service.getThreadDetail("alice", thread.id)).messages.length, 2);
  await assert.rejects(
    () => service.getThreadDetail("bob", thread.id),
    (error) => error instanceof HttpError && error.code === "DEV_AI_THREAD_NOT_FOUND"
  );
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
      assert.equal(request.fieldId, "1036621");
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
    context: { formPath: "default/devtest/51", fieldId: "1036621", formulaKind: "formula" },
  });
  const result = await service.sendMessage("alice", thread.id, {
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
    () => service.sendMessage("alice", thread.id, { message: "幫我改公式" }),
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
    () => service.sendMessage("alice", thread.id, { message: "這句會失敗" }),
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
      assert.match(request.question, /有效上下文/);
      assert.doesNotMatch(request.question, /失敗上下文/);
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

  await service.sendMessage("alice", thread.id, { message: "下一題" });
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

  await service.sendMessage("alice", thread.id, { message: "第一句" });
  const final = await service.sendMessage("alice", thread.id, { message: "第二句" });

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

  const result = await service.sendMessage("alice", thread.id, { message: "請整理 Dev AI 流程" });

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

  await service.sendMessage("alice", thread.id, { message: "第一句" });
  await service.sendMessage("alice", thread.id, { message: "第二句" });

  const detail = await service.getThreadDetail("alice", thread.id);
  assert.deepEqual(
    detail.messages.map((message) => message.content),
    ["這是回答", "第二句", "這是回答"]
  );
  assert.equal(detail.artifacts.length, 2);
  await repo.close();
});
