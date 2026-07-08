import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../../src/utils/httpError";
import {
  createDevAiChatService,
  type DevAiChatRuntimeConfig,
} from "../../../src/services/dev/ai/devAiChatService";
import type { GoogleGeminiClient } from "../../../src/services/dev/ai/googleGeminiClient";
import type { DevAiKnowledgeBaseService } from "../../../src/services/dev/ai/devAiKnowledgeBaseService";
import type { RagicDefinitionSearchItem } from "@shared-types/ragicDefinitions";

const enabledConfig: DevAiChatRuntimeConfig = {
  enabled: true,
  provider: "google",
  model: "gemini-balanced",
  fastModel: "gemini-fast",
  thinkingLevel: "minimal",
  maxContextChars: 12_000,
  maxOutputTokens: 1_024,
  maxConcurrentRequests: 2,
  rateLimitPerMinute: 6,
  storeInteractions: false,
  storeRawOutput: false,
};

function emptySearchResult() {
  return {
    data: [] as RagicDefinitionSearchItem[],
    meta: {
      count: 0,
      limit: 0,
      truncated: false,
      q: "",
      fieldId: "",
      formPath: "",
      type: "all" as const,
    },
  };
}

test("Dev AI chat 會組 RAG context 並用 fast model / minimal thinking", async () => {
  const knowledgeService: DevAiKnowledgeBaseService = {
    invalidateCache() {},
    async search() {
      return [
        {
          sourceId: "curated:funda",
          title: "Funda 內部口徑",
          kind: "curated",
          excerpt: "Funda 問答必須以內部文件為準。",
          score: 9,
          path: "funda.md",
        },
      ];
    },
  };
  const googleClient: GoogleGeminiClient = {
    model: "gemini-balanced",
    async generateJsonText(request) {
      assert.equal(request.model, "gemini-fast");
      assert.equal(request.thinkingLevel, "minimal");
      assert.equal(request.maxOutputTokens, 768);
      assert.equal(request.storeInteraction, false);
      assert.match(request.prompt, /curated:funda/);
      assert.match(request.prompt, /Funda 是什麼/);
      return JSON.stringify({
        answer: "目前只能依據內部口徑回答。",
        assumptions: ["本地知識庫只有一筆資料"],
        followUps: ["請補更多 Funda 文件"],
        sourceIds: ["curated:funda"],
      });
    },
  };
  const service = createDevAiChatService({
    config: enabledConfig,
    googleClient,
    knowledgeService,
    definitionsService: {
      async readForm() {
        throw new Error("should not read form");
      },
      async search() {
        throw new Error("should not search definitions");
      },
    },
    chatIdFactory: () => "chat-1",
    now: () => 1000,
  });

  const result = await service.ask({ question: "Funda 是什麼？", speedMode: "fast" });

  assert.equal(result.chatId, "chat-1");
  assert.equal(result.model, "gemini-fast");
  assert.equal(result.speedMode, "fast");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].sourceId, "curated:funda");
  assert.equal(result.contextPreview.knowledgeItems, 1);
});

test("Dev AI chat definitions mode 會帶 definitions source", async () => {
  const googleClient: GoogleGeminiClient = {
    model: "gemini-balanced",
    async generateJsonText(request) {
      assert.equal(request.model, "gemini-balanced");
      assert.equal(request.thinkingLevel, "high");
      assert.match(request.prompt, /definitions:default\/devtest\/51/);
      return JSON.stringify({
        answer: "這張表有 2 個欄位。",
        assumptions: [],
        followUps: [],
        sourceIds: ["definitions:default/devtest/51"],
      });
    },
  };
  const service = createDevAiChatService({
    config: enabledConfig,
    googleClient,
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: {
      async readForm() {
        return {
          form: {
            schemaVersion: 1,
            formPath: "default/devtest/51",
            formName: "luo test",
            nuiFile: "51.nui",
            sourceEncoding: "utf-8",
            sourceRelativePath: "default/devtest/51.nui",
            counts: { fields: 2, formulas: 1, workflows: 0 },
          },
          fields: [
            { fieldId: "1", fieldName: "規格", kind: "D", position: "A6", sourceLine: 1, attrs: {} },
            { fieldId: "2", fieldName: "數量", kind: "D", position: "B6", sourceLine: 2, attrs: {} },
          ],
          formulas: [
            {
              fieldId: "2",
              fieldName: "數量",
              position: "B6",
              formulaKind: "formula",
              nuiFormula: "A6+1",
              displayFormula: "A6+1",
              sourceLine: 2,
            },
          ],
          workflows: [],
        };
      },
      async search() {
        return emptySearchResult();
      },
    },
  });

  const result = await service.ask({
    question: "這張表有哪些欄位？",
    mode: "definitions",
    speedMode: "deep",
    formPath: "default/devtest/51",
  });

  assert.equal(result.mode, "definitions");
  assert.equal(result.sources[0].kind, "definitions");
  assert.equal(result.contextPreview.definitionItems, 1);
});

test("Dev AI chat disabled 時不呼叫 Google", async () => {
  let googleCalled = false;
  const service = createDevAiChatService({
    config: { ...enabledConfig, enabled: false },
    googleClient: {
      model: "gemini-balanced",
      async generateJsonText() {
        googleCalled = true;
        return "{}";
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: {
      async readForm() { throw new Error("unused"); },
      async search() { return emptySearchResult(); },
    },
  });

  await assert.rejects(
    () => service.ask({ question: "hi" }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_DISABLED"
  );
  assert.equal(googleCalled, false);
});

test("Dev AI chat knowledge search 失敗時降級成空 knowledge context", async () => {
  let googleCalled = false;
  const service = createDevAiChatService({
    config: enabledConfig,
    googleClient: {
      model: "gemini-balanced",
      async generateJsonText(request) {
        googleCalled = true;
        assert.doesNotMatch(request.prompt, /curated:funda/);
        return JSON.stringify({
          answer: "本地 knowledge 暫時不可用，但仍可回答。",
          assumptions: ["knowledge search degraded"],
          followUps: [],
          sourceIds: [],
        });
      },
    },
    knowledgeService: {
      invalidateCache() {},
      async search() {
        throw new Error("knowledge file permission denied");
      },
    },
    definitionsService: {
      async readForm() { throw new Error("unused"); },
      async search() { return emptySearchResult(); },
    },
  });

  const result = await service.ask({ question: "Funda 是什麼？", includeKnowledge: true });

  assert.equal(googleCalled, true);
  assert.equal(result.sources.length, 0);
  assert.equal(result.contextPreview.knowledgeItems, 0);
  assert.match(result.answer, /knowledge/);
});
