import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDevAiKnowledgeBaseService } from "../../../src/services/dev/ai/devAiKnowledgeBaseService";
import { createDevAiChatService } from "../../../src/services/dev/ai/devAiChatService";
import { createDevAiThreadRepository } from "../../../src/services/dev/ai/devAiThreadRepository";
import { createDevAiThreadService } from "../../../src/services/dev/ai/devAiThreadService";
import { createRagicDefinitionsReadService } from "../../../src/services/dev/ragicDefinitionsReadService";
import { createDevAiVectorIndex } from "../../../src/services/dev/ai/devAiVectorIndex";

test("合成繁中規則的連續詞組進入前六名，欄位識別碼仍優先", async () => {
  const knowledgeDir = path.resolve("../docs/dev-ai-evals/r1/fixtures");
  const legacy = createDevAiKnowledgeBaseService({ knowledgeDir, retrievalMode: "lexical", lexicalProfile: "legacy" });
  const phrase = createDevAiKnowledgeBaseService({ knowledgeDir, retrievalMode: "lexical", lexicalProfile: "phrase" });
  try {
    const question = "合成工令取消結案的操作限制是什麼？";
    assert.equal((await legacy.search({ query: question, maxItems: 6 })).some((source) => source.sourceId === "phrase-rule.md"), false);
    const improved = await phrase.search({ query: question, maxItems: 6 });
    assert.equal(improved[0]?.sourceId, "phrase-rule.md");
    assert.match(improved[0].excerpt, /必須由主管覆核原結案紀錄/);
  } finally { await legacy.dispose?.(); await phrase.dispose?.(); }

  const root = await mkdtemp(path.join(tmpdir(), "demo-rag-identifier-"));
  await writeFile(path.join(root, "field.md"), "# 123456 欄位\n取消結案限制需覆核。", "utf8");
  await writeFile(path.join(root, "similar.md"), "# 取消結案限制\n沒有指定欄位。", "utf8");
  const service = createDevAiKnowledgeBaseService({ knowledgeDir: root, retrievalMode: "lexical" });
  try { assert.equal((await service.search({ query: "123456 的取消結案限制" }))[0]?.sourceId, "field.md"); }
  finally { await service.dispose?.(); }
});

test("章節切塊保留同一段條件與例外，程式區塊標題不切段", async () => {
  const content = "# 合成規則\n## 啟動條件\nRULE_CONDITION：先檢查許可。\n"
    + "背景。".repeat(65) + "\n```text\n# 程式輸出，不是標題\n```\nRULE_EXCEPTION：暫停時不可啟動。\n";
  const index = createDevAiVectorIndex({ dbFile: ":memory:", embeddingProvider: {
    profile: "demo-section-fixture", dimensions: 2,
    async embed(texts) { return texts.map((text) => text === "條件與例外"
      || (text.includes("RULE_CONDITION") && text.includes("RULE_EXCEPTION")) ? [1, 0] : [0, 1]); },
  } });
  try {
    const hits = await index.search([{ sourceId: "rule.md", title: "合成規則", path: "rule.md", kind: "curated", content }],
      "條件與例外", new Set(["rule.md"]));
    assert.equal(hits[0]?.similarity, 1);
    assert.match(content.slice(hits[0].start, hits[0].end), /RULE_CONDITION[\s\S]*RULE_EXCEPTION/);
  } finally { await index.dispose(); }
});

test("Demo 同一對話能依編號找合成表單，補路徑仍承接流程問題，模糊同步先釐清", async () => {
  const definitions = createRagicDefinitionsReadService({ definitionsRoot: path.resolve("../ragic-definitions") });
  const repository = createDevAiThreadRepository({ dbFile: ":memory:" });
  const prompts: string[] = [];
  const chat = createDevAiChatService({
    config: { enabled: true, provider: "minimax", rateLimitPerMinute: 100 },
    definitionsService: definitions,
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    providerClient: { name: "minimax", model: "fixture", async generateJsonText(request) {
      prompts.push(request.prompt);
      return JSON.stringify({ threadTitle: "合成表單流程", answer: "只能確認定義中的程式片段。",
        assumptions: [], followUps: [], sourceIds: [] });
    } },
  });
  const threads = createDevAiThreadService({ enabled: true, repository, chatService: chat,
    definitionsService: definitions, summaryEnabled: false });
  try {
    const thread = await threads.createThread("demo-rag");
    const first = await threads.sendMessage("demo-rag", thread.id,
      { clientMessageId: "demo-rag-001", message: "901工令單的業務流程是什麼？" });
    assert.equal(first.thread.context.formPath, "demo/work-report/901");
    assert.ok(first.chat?.contextSources.some((source) => source.sourceType === "workflow" && source.formPath === "demo/work-report/901"));

    const second = await threads.sendMessage("demo-rag", thread.id,
      { clientMessageId: "demo-rag-002", message: "https://demo.example/demo/work-report/901" });
    assert.match(String(second.userMessage.metadata.retrievalQuery), /業務流程/);
    assert.ok(second.chat?.contextSources.some((source) => source.sourceType === "workflow"));
    assert.ok(prompts.at(-1)?.includes("本次檢索承接的問題"));

    const third = await threads.sendMessage("demo-rag", thread.id,
      { clientMessageId: "demo-rag-003", message: "為什麼資料沒同步？" });
    assert.equal(third.chat?.model, "sync-clarification");
    assert.match(third.chat?.answer ?? "", /沒找到 Demo 表單定義.*某筆工令紀錄/);
    assert.equal(prompts.length, 2, "釐清前不呼叫生成模型");

    const switched = await threads.sendMessage("demo-rag", thread.id,
      { clientMessageId: "demo-rag-004", message: "1表單是做什麼的？" });
    assert.equal(switched.thread.context.formPath, "demo/master-data/1");
    const supplied = await threads.sendMessage("demo-rag", thread.id,
      { clientMessageId: "demo-rag-005", message: "https://demo.example/demo/master-data/1" });
    assert.equal(supplied.userMessage.metadata.retrievalQuery, "1表單是做什麼的？");
    assert.equal(supplied.chat?.contextSources.some((source) => source.formPath === "demo/work-report/901"), false,
      "切換表單後不可沿用上一張的證據");
    const unrelated = await threads.sendMessage("demo-rag", thread.id,
      { clientMessageId: "demo-rag-006", message: "今天星期幾？", includeDefinitions: true });
    assert.equal(unrelated.chat?.contextPreview.definitionItems, 0, "預設勾選不應帶入舊表單");
  } finally { await repository.close(); }
});

test("同編號有多張合成表單時先列候選並詢問路徑，不猜第一張", async () => {
  const definitions = createRagicDefinitionsReadService({ definitionsRoot: path.resolve("../ragic-definitions") });
  const repository = createDevAiThreadRepository({ dbFile: ":memory:" });
  let generated = 0;
  const chat = createDevAiChatService({ config: { enabled: true, provider: "minimax" },
    providerClient: { name: "minimax", model: "fixture", async generateJsonText() {
      generated += 1;
      return JSON.stringify({ answer: "不可到達", assumptions: [], followUps: [], sourceIds: [] });
    } } });
  const threads = createDevAiThreadService({ enabled: true, repository, chatService: chat,
    definitionsService: { async listForms() {
      const original = (await definitions.listForms()).data.find((form) => form.formPath.endsWith("/901"))!;
      return { data: [original, { ...original, formPath: "demo/alternate/901", formName: "Second Synthetic Form" }],
        meta: { count: 2, limit: 200, truncated: false, q: "" } };
    } }, summaryEnabled: false });
  try {
    const thread = await threads.createThread("ambiguous-demo");
    const result = await threads.sendMessage("ambiguous-demo", thread.id,
      { clientMessageId: "ambiguous-001", message: "901表單是做什麼的？" });
    assert.equal(result.chat?.model, "form-selection");
    assert.match(result.chat?.answer ?? "", /demo\/work-report\/901[\s\S]*demo\/alternate\/901/);
    assert.equal(result.thread.context.formPath, undefined);
    assert.equal(generated, 0);
  } finally { await repository.close(); }
});
