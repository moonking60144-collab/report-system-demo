import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../../src/utils/httpError";
import {
  createDevAiChatService,
  type DevAiChatRuntimeConfig,
} from "../../../src/services/dev/ai/devAiChatService";
import type { DevAiJsonProvider } from "../../../src/services/dev/ai/devAiJsonProvider";
import type { DevAiKnowledgeBaseService } from "../../../src/services/dev/ai/devAiKnowledgeBaseService";
import type { RagicDefinitionsReadService } from "../../../src/services/dev/ragicDefinitionsReadService";
import type { RagicDefinitionSearchItem } from "@shared-types/ragicDefinitions";

const enabledConfig: DevAiChatRuntimeConfig = {
  enabled: true,
  provider: "google",
  model: "gemini-balanced",
  fastModel: "gemini-fast",
  fastEffort: "minimal",
  balancedEffort: "minimal",
  deepEffort: "high",
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
      revision: null,
    },
  };
}

function createDefinitionsSearchChatService(search: RagicDefinitionsReadService["search"]) {
  return createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "google",
      model: "gemini-balanced",
      async generateJsonText() {
        return JSON.stringify({
          answer: "目前沒有找到來源。",
          assumptions: [],
          followUps: [],
          sourceIds: [],
        });
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: { search },
  });
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
  const googleClient: DevAiJsonProvider = {
    name: "google",
    model: "gemini-balanced",
    async generateJsonText(request) {
      assert.equal(request.model, "gemini-fast");
      assert.equal(request.effort, "minimal");
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
    providerClient: googleClient,
    knowledgeService,
    definitionsService: {
      async search() {
        throw new Error("should not search definitions");
      },
    },
    chatIdFactory: () => "chat-1",
    now: () => 1000,
  });

  const result = await service.ask({ question: "Funda 是什麼？", speedMode: "fast" });

  assert.equal(result.chatId, "chat-1");
  assert.equal(result.provider, "google");
  assert.equal(result.model, "gemini-fast");
  assert.equal(result.speedMode, "fast");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].sourceId, "curated:funda");
  assert.equal(result.contextPreview.knowledgeItems, 1);
});

test("Dev AI chat 可由相同契約切換 MiniMax 並映射 speed effort", async () => {
  const providerClient: DevAiJsonProvider = {
    name: "minimax",
    model: "MiniMax-M3",
    async generateJsonText(request) {
      assert.equal(request.model, "MiniMax-M3");
      assert.equal(request.effort, "low");
      return JSON.stringify({
        answer: "MiniMax 已依據相同 Dev AI schema 回答。",
        assumptions: [],
        followUps: [],
        sourceIds: [],
      });
    },
  };
  const service = createDevAiChatService({
    config: {
      ...enabledConfig,
      provider: "minimax",
      model: "MiniMax-M3",
      fastModel: "MiniMax-M3",
      fastEffort: "low",
      balancedEffort: "medium",
      deepEffort: "high",
    },
    providerClient,
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: {
      async search() { return emptySearchResult(); },
    },
  });

  const result = await service.ask({ question: "說明這張表", speedMode: "fast" });

  assert.equal(result.provider, "minimax");
  assert.equal(result.model, "MiniMax-M3");
  assert.match(result.answer, /MiniMax/);
});

test("Dev AI chat 對 provider schema 型別錯誤會 fail-closed", async () => {
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "minimax",
      model: "MiniMax-M3",
      async generateJsonText() {
        return JSON.stringify({
          answer: { text: "不應被轉成字串" },
          assumptions: [],
          followUps: [],
          sourceIds: [],
        });
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: {
      async search() { return emptySearchResult(); },
    },
  });

  await assert.rejects(
    () => service.ask({ question: "說明這張表" }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_BAD_JSON"
  );
});

test("Dev AI chat 以目前欄位精確檢索並攜帶 revision、欄位設定與 workflow 證據", async () => {
  const revision = `sha256:${"a".repeat(64)}`;
  const fieldSourceId = "definitions:default/devtest/51:field:1036641:G6";
  const workflowSourceId = "definitions:default/devtest/51:workflow:1036641:G6:post.js";
  const googleClient: DevAiJsonProvider = {
    name: "google",
    model: "gemini-balanced",
    async generateJsonText(request) {
      assert.equal(request.model, "gemini-balanced");
      assert.equal(request.effort, "high");
      assert.match(request.prompt, new RegExp(fieldSourceId));
      assert.match(request.prompt, /\\\"l\\\":\\\"1036600\\\"/);
      assert.match(request.prompt, /post\.js/);
      assert.match(request.prompt, new RegExp(revision));
      return JSON.stringify({
        answer: "欄位 1036641 由 linked field 1036600 帶入，post workflow 也有引用。",
        assumptions: [],
        followUps: [],
        sourceIds: [fieldSourceId, workflowSourceId],
      });
    },
  };
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: googleClient,
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: {
      async search(params) {
        assert.equal(params.formPath, "default/devtest/51");
        assert.equal(params.fieldId, "1036641");
        return {
          data: [
            {
              type: "field" as const,
              formPath: "default/devtest/51",
              formName: "luo test",
              sourceRelativePath: "default/devtest/51.nui",
              fieldId: "1036641",
              fieldName: "測試",
              kind: "D",
              position: "G6",
              sourceLine: 24,
              attrs: { l: "1036600", vd: "1016317" },
              fieldReferences: [
                {
                  attribute: "l" as const,
                  fieldId: "1036600",
                  formPath: "default/devtest/51",
                  fieldName: "來源選擇",
                  kind: "L",
                  position: "F6",
                },
              ],
              formulaKind: null,
              nuiFormula: null,
              displayFormula: null,
              workflowScope: null,
              workflowFileName: null,
              workflowExcerpt: null,
            },
            {
              type: "workflow" as const,
              formPath: "default/devtest/51",
              formName: "luo test",
              sourceRelativePath: "forms/default/devtest/51/workflows/post.js",
              fieldId: "1036641",
              fieldName: "測試",
              kind: null,
              position: "G6",
              sourceLine: 2,
              attrs: null,
              fieldReferences: [],
              formulaKind: null,
              nuiFormula: null,
              displayFormula: null,
              workflowScope: "post",
              workflowFileName: "post.js",
              workflowExcerpt: "entry.setValue(1036641, value);",
            },
          ],
          meta: {
            count: 2,
            limit: 8,
            truncated: false,
            q: "",
            fieldId: "1036641",
            formPath: "default/devtest/51",
            type: "all" as const,
            revision,
          },
        };
      },
    },
  });

  const result = await service.ask({
    question: "這個欄位來源是什麼？",
    mode: "definitions",
    speedMode: "deep",
    formPath: "default/devtest/51",
    fieldId: "1036641",
  });

  assert.equal(result.mode, "definitions");
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].revision, revision);
  assert.equal(result.sources[0].fieldId, "1036641");
  assert.equal(result.contextPreview.definitionItems, 2);
});

test("Dev AI chat 只在自由提問明確標記 Field ID 時做精確檢索", async () => {
  const searchCalls: Array<Parameters<RagicDefinitionsReadService["search"]>[0]> = [];
  const service = createDefinitionsSearchChatService(async (params) => {
    searchCalls.push(params);
    return emptySearchResult();
  });

  await service.ask({
    question: "請查 Field ID 1040347 這個 Name 欄位的來源",
    mode: "definitions",
  });

  assert.equal(searchCalls[0]?.fieldId, "1040347");
  assert.equal(searchCalls[0]?.q, undefined);
});

test("Dev AI chat 不會把工單編號誤判為 Ragic Field ID", async () => {
  const searchCalls: Array<Parameters<RagicDefinitionsReadService["search"]>[0]> = [];
  const service = createDefinitionsSearchChatService(async (params) => {
    searchCalls.push(params);
    return emptySearchResult();
  });
  const question = "請查工單 WO-25040537 在這個表單的欄位資料";

  await service.ask({
    question,
    mode: "definitions",
    formPath: "default/devtest/51",
  });

  assert.equal(searchCalls[0]?.q, question);
  assert.equal(searchCalls[0]?.fieldId, undefined);
  assert.equal(searchCalls.every((params) => params.fieldId === undefined), true);
});

test("Dev AI chat 以前端明確傳入的 fieldId 優先於提問內容", async () => {
  const searchCalls: Array<Parameters<RagicDefinitionsReadService["search"]>[0]> = [];
  const service = createDefinitionsSearchChatService(async (params) => {
    searchCalls.push(params);
    return emptySearchResult();
  });

  await service.ask({
    question: "請查 Field ID 1040347 的來源",
    mode: "definitions",
    fieldId: "1036641",
  });

  assert.equal(searchCalls[0]?.fieldId, "1036641");
});

test("Dev AI chat 的 Field ID 精確檢索無結果時依序退回全文與表單檢索", async () => {
  const searchCalls: Array<Parameters<RagicDefinitionsReadService["search"]>[0]> = [];
  const service = createDefinitionsSearchChatService(async (params) => {
    searchCalls.push(params);
    return emptySearchResult();
  });
  const question = "請查欄位編號 1040347 的來源";
  const formPath = "default/devtest/51";

  await service.ask({
    question,
    mode: "definitions",
    formPath,
  });

  assert.deepEqual(
    searchCalls.map((params) => ({
      q: params.q,
      fieldId: params.fieldId,
      formPath: params.formPath,
    })),
    [
      { q: undefined, fieldId: "1040347", formPath },
      { q: question, fieldId: undefined, formPath },
      { q: undefined, fieldId: undefined, formPath },
    ]
  );
});

test("Dev AI chat disabled 時不呼叫 Google", async () => {
  let googleCalled = false;
  const service = createDevAiChatService({
    config: { ...enabledConfig, enabled: false },
    providerClient: {
      name: "google",
      model: "gemini-balanced",
      async generateJsonText() {
        googleCalled = true;
        return "{}";
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: {
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
    providerClient: {
      name: "google",
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
      async search() { return emptySearchResult(); },
    },
  });

  const result = await service.ask({ question: "Funda 是什麼？", includeKnowledge: true });

  assert.equal(googleCalled, true);
  assert.equal(result.sources.length, 0);
  assert.equal(result.contextPreview.knowledgeItems, 0);
  assert.match(result.answer, /knowledge/);
});
