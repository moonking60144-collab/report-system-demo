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
import type {
  DevAiKnowledgeSource,
  RagicDefinitionFormDetail,
  RagicDefinitionSearchItem,
} from "@shared-types/ragicDefinitions";
import { RAGIC_OFFICIAL_KNOWLEDGE_SEEDS } from "../../../src/services/dev/ai/ragicOfficialKnowledgeSeeds";

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
          sourceId: "curated:democo",
          title: "DemoCo 內部口徑",
          kind: "curated",
          excerpt: "DemoCo 問答必須以內部文件為準。",
          score: 9,
          path: "democo.md",
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
      assert.equal(request.maxOutputTokens, 1_024);
      assert.equal(request.storeInteraction, false);
      assert.match(request.prompt, /curated:democo/);
      assert.match(request.prompt, /DemoCo 是什麼/);
      return JSON.stringify({
        answer: "目前只能依據內部口徑回答。",
        assumptions: ["本地知識庫只有一筆資料"],
        followUps: ["請補更多 DemoCo 文件"],
        sourceIds: ["curated:democo"],
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

  const result = await service.ask({ question: "DemoCo 是什麼？", speedMode: "fast" });

  assert.equal(result.chatId, "chat-1");
  assert.equal(result.provider, "google");
  assert.equal(result.model, "gemini-fast");
  assert.equal(result.speedMode, "fast");
  assert.equal(result.contextSources.length, 1);
  assert.equal(result.citedEvidence.length, 1);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].sourceId, "curated:democo");
  assert.equal(result.contextPreview.knowledgeItems, 1);
});

test("Dev AI chat 分開保存 contextSources 與 citedEvidence，prompt 不外洩稽核 metadata", async () => {
  let capturedPrompt = "";
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "google",
      model: "gemini-balanced",
      async generateJsonText(request) {
        capturedPrompt = request.prompt;
        return JSON.stringify({
          answer: "目前沒有足夠證據可以引用。",
          assumptions: [],
          followUps: [],
          sourceIds: [],
        });
      },
    },
    knowledgeService: {
      invalidateCache() {},
      async search() {
        return [{
          sourceId: "guide:public-example",
          title: "公開示例",
          kind: "curated" as const,
          excerpt: "這段內容有送進模型。",
          score: 7,
          path: "guides/public.md",
          sourceVersion: `sha256:${"a".repeat(64)}`,
          retrieval: { mode: "hybrid" as const, lexicalRank: 1, vectorRank: 2, similarity: 0.81 },
          evidenceSpans: [{
            spanId: "0-11:fixture",
            sourceStart: 0,
            sourceEnd: 11,
            excerptStart: 0,
            excerptEnd: 11,
            contentHash: `sha256:${"b".repeat(64)}`,
          }],
        }];
      },
    },
    definitionsService: { async search() { return emptySearchResult(); } },
  });

  const result = await service.ask({ question: "請說明公開示例" });

  assert.equal(result.contextSources.length, 1);
  assert.equal(result.contextSources[0].sourceVersion, `sha256:${"a".repeat(64)}`);
  assert.equal(
    result.citedEvidence.length,
    0,
    "CITATION_MUST_NOT_DEFAULT_TO_CONTEXT"
  );
  assert.equal(result.sources.length, 0);
  assert.match(capturedPrompt, /guide:public-example/);
  assert.match(capturedPrompt, /這段內容有送進模型/);
  assert.doesNotMatch(capturedPrompt, /sourceVersion|evidenceSpans|retrieval|similarity/);
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
  const fieldSourceId = "definitions:default/devtest/51:field:9001108:G6";
  const workflowSourceId = "definitions:default/devtest/51:workflow:9001108:G6:post.js";
  const googleClient: DevAiJsonProvider = {
    name: "google",
    model: "gemini-balanced",
    async generateJsonText(request) {
      assert.equal(request.model, "gemini-balanced");
      assert.equal(request.effort, "high");
      assert.match(request.prompt, new RegExp(fieldSourceId));
      assert.match(request.prompt, /\\\"l\\\":\\\"9001104\\\"/);
      assert.match(request.prompt, /post\.js/);
      assert.match(request.prompt, new RegExp(revision));
      return JSON.stringify({
        answer: "欄位 9001108 由 linked field 9001104 帶入，post workflow 也有引用。",
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
        assert.equal(params.fieldId, "9001108");
        return {
          data: [
            {
              type: "field" as const,
              formPath: "default/devtest/51",
              formName: "luo test",
              sourceRelativePath: "default/devtest/51.nui",
              fieldId: "9001108",
              fieldName: "測試",
              kind: "D",
              position: "G6",
              sourceLine: 24,
              attrs: { l: "9001104", vd: "9001074" },
              fieldReferences: [
                {
                  attribute: "l" as const,
                  fieldId: "9001104",
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
              fieldId: "9001108",
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
              workflowExcerpt: "entry.setValue(9001108, value);",
            },
          ],
          meta: {
            count: 2,
            limit: 8,
            truncated: false,
            q: "",
            fieldId: "9001108",
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
    fieldId: "9001108",
  });

  assert.equal(result.mode, "definitions");
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].revision, revision);
  assert.equal(result.sources[0].fieldId, "9001108");
  assert.equal(result.contextPreview.definitionItems, 2);
});

test("Dev AI chat 只在自由提問明確標記 Field ID 時做精確檢索", async () => {
  const searchCalls: Array<Parameters<RagicDefinitionsReadService["search"]>[0]> = [];
  const service = createDefinitionsSearchChatService(async (params) => {
    searchCalls.push(params);
    return emptySearchResult();
  });

  await service.ask({
    question: "請查 Field ID 9001111 這個 Name 欄位的來源",
    mode: "definitions",
  });

  assert.equal(searchCalls[0]?.fieldId, "9001111");
  assert.equal(searchCalls[0]?.q, undefined);
});

test("Dev AI chat 不會把工單編號誤判為 Ragic Field ID", async () => {
  const searchCalls: Array<Parameters<RagicDefinitionsReadService["search"]>[0]> = [];
  const service = createDefinitionsSearchChatService(async (params) => {
    searchCalls.push(params);
    return emptySearchResult();
  });
  const question = "請查工單 WO-DEMO-0001 在這個表單的欄位資料";

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
    question: "請查 Field ID 9001111 的來源",
    mode: "definitions",
    fieldId: "9001108",
  });

  assert.equal(searchCalls[0]?.fieldId, "9001108");
});

test("Dev AI chat 的 Field ID 精確檢索無結果時依序退回全文與表單檢索", async () => {
  const searchCalls: Array<Parameters<RagicDefinitionsReadService["search"]>[0]> = [];
  const service = createDefinitionsSearchChatService(async (params) => {
    searchCalls.push(params);
    return emptySearchResult();
  });
  const question = "請查欄位編號 9001111 的來源";
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
      { q: undefined, fieldId: "9001111", formPath },
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
        assert.doesNotMatch(request.prompt, /curated:democo/);
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

  const result = await service.ask({ question: "DemoCo 是什麼？", includeKnowledge: true });

  assert.equal(googleCalled, true);
  assert.equal(result.sources.length, 0);
  assert.equal(result.contextPreview.knowledgeItems, 0);
  assert.match(result.answer, /knowledge/);
});

test("Dev AI chat 遇到向量模型未就緒會回傳原始 503，且不呼叫生成 provider", async () => {
  let providerCalled = false;
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "google",
      model: "gemini-balanced",
      async generateJsonText() {
        providerCalled = true;
        return "{}";
      },
    },
    knowledgeService: {
      invalidateCache() {},
      async search() {
        throw new HttpError(503, "本機知識模型尚未準備", "DEV_AI_EMBEDDING_UNAVAILABLE");
      },
    },
    definitionsService: { async search() { return emptySearchResult(); } },
  });

  await assert.rejects(
    () => service.ask({ question: "需要向量檢索的問題" }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_EMBEDDING_UNAVAILABLE"
  );
  assert.equal(providerCalled, false);
});

test("Dev AI chat 產生繁體標題並轉換自然語言，保留程式碼原文", async () => {
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "google",
      model: "gemini-balanced",
      async generateJsonText(request) {
        assert.match(request.prompt, /threadTitle/);
        assert.match(request.prompt, /只能使用繁體中文或英文/);
        return JSON.stringify({
          threadTitle: "当前代码说明",
          answer: "当前给你 `get后Value()`。\n```js\nconst 当前 = 1;\n```",
          assumptions: ["相关代码只影响新资料"],
          followUps: ["请提供当前版本"],
          sourceIds: [],
        });
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: { async search() { return emptySearchResult(); } },
  });

  const result = await service.ask({ question: "請說明目前程式碼。" });

  assert.equal(result.threadTitle, "目前程式碼說明", "TRADITIONAL_LANGUAGE_CONTRACT");
  assert.match(
    result.answer,
    /目前給你 `get后Value\(\)`/,
    "TRADITIONAL_LANGUAGE_CONTRACT"
  );
  assert.match(result.answer, /const 当前 = 1/);
  assert.deepEqual(result.assumptions, ["相關程式碼只影響新資料"]);
  assert.deepEqual(result.followUps, ["請提供目前版本"]);
});

test("Dev AI 問題回顧由 Server 計算，不檢索也不呼叫模型", async () => {
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "google",
      model: "gemini-balanced",
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
  const previousUserQuestions = ["第一題", "第二題", "第三題"];

  const latest = await service.ask(
    { question: "我上一個問題是問什麼？" },
    { previousUserQuestions }
  );
  const secondLatest = await service.ask(
    { question: "我上上個問題是問什麼？" },
    { previousUserQuestions }
  );

  assert.equal(latest.answer, "你的上一個問題是：「第三題」");
  assert.equal(
    secondLatest.answer,
    "你的上上個問題是：「第二題」",
    "THREAD_RECALL_CONTRACT"
  );
  assert.equal(secondLatest.provider, "local");
  assert.equal(secondLatest.model, "thread-memory");
  assert.equal(secondLatest.providerAttempts, 0);
  assert.deepEqual(secondLatest.contextSources, []);
});

test("Dev AI chat 指定表單時讀取完整 definitions 並保留 workflow evidence", async () => {
  const detail: RagicDefinitionFormDetail = {
    form: {
      schemaVersion: 1,
      formPath: "default/forms999/9002",
      formName: "Demo 工令單",
      nuiFile: "fixture.nui",
      sourceRelativePath: "fixture.nui",
      sourceEncoding: "utf-8",
      counts: { fields: 1, formulas: 0, workflows: 1 },
    },
    fields: [{
      fieldId: "9001000",
      fieldName: "機台",
      kind: "T",
      position: "F7",
      sourceLine: 10,
      attrs: {},
    }],
    formulas: [],
    workflows: [{
      fileName: "post.js",
      scope: "post",
      content: "function updateMachine() { return param.getUpdatedEntry(); }",
      charCount: 62,
    }],
  };
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "google",
      model: "gemini-balanced",
      async generateJsonText(request) {
        assert.match(
          request.prompt,
          /definitions:default\/forms999\/9002:overview/,
          "SCOPED_FORM_MUST_USE_READ_FORM"
        );
        assert.match(request.prompt, /definitions:default\/forms999\/9002:workflow:post\.js/);
        assert.match(request.prompt, /updateMachine/);
        return JSON.stringify({
          threadTitle: "Demo Workflow 說明",
          answer: "已根據 definitions 說明。",
          assumptions: [],
          followUps: [],
          sourceIds: ["definitions:default/forms999/9002:workflow:post.js"],
        });
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: {
      async readForm(formPath) {
        assert.equal(formPath, "default/forms999/9002");
        return detail;
      },
      async search() { assert.fail("SCOPED_FORM_MUST_USE_READ_FORM"); },
    },
  });

  const result = await service.ask({
    question: "https://demo.example/default/forms999/9002/123 的 workflow 怎麼運作？",
  });

  assert.equal(result.contextPreview.definitionsStatus, "ready");
  assert.ok(result.contextPreview.definitionItems >= 2);
  assert.equal(result.citedEvidence[0]?.sourceType, "workflow");
});

test("Dev AI chat 表單 definitions 讀取失敗時明確標示 unavailable", async () => {
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "google",
      model: "gemini-balanced",
      async generateJsonText(request) {
        assert.match(request.prompt, /Definitions 本次不可用/);
        return JSON.stringify({
          threadTitle: "Definitions 不可用",
          answer: "本次無法讀取指定表單。",
          assumptions: [],
          followUps: [],
          sourceIds: [],
        });
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: {
      async readForm() { throw new Error("fixture missing"); },
      async search() { assert.fail("NO_UNSCOPED_FALLBACK"); },
    },
  });

  const result = await service.ask({
    question: "https://demo.example/default/forms999/9099 這張表單是什麼？",
  });

  assert.equal(result.contextPreview.definitionsStatus, "unavailable");
  assert.equal(result.contextPreview.definitionItems, 0);
  assert.equal(result.contextPreview.definitionsErrorCode, "DEFINITIONS_SEARCH_FAILED");
});

test("Dev AI chat 對截斷輸出只提高一次 token 上限重試", async () => {
  const outputLimits: number[] = [];
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "minimax",
      model: "MiniMax-M3",
      async generateJsonText(request) {
        outputLimits.push(request.maxOutputTokens ?? 0);
        if (outputLimits.length === 1) {
          throw new HttpError(
            502,
            "MiniMax 輸出超過 token 上限",
            "DEV_AI_MINIMAX_OUTPUT_TRUNCATED"
          );
        }
        assert.match(request.prompt, /前一次輸出因 token 上限被截斷/);
        return JSON.stringify({
          threadTitle: "截斷輸出重試",
          answer: "重試後完成。",
          assumptions: [],
          followUps: [],
          sourceIds: [],
        });
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: { async search() { return emptySearchResult(); } },
  });

  const result = await service.ask({ question: "請簡短回答。", speedMode: "fast" });

  assert.deepEqual(outputLimits, [1_024, 1_536], "OUTPUT_RETRY_CONTRACT");
  assert.equal(result.providerAttempts, 2);
  assert.equal(result.outputFallbackApplied, true);
  assert.equal(result.outputTokenLimit, 1_536);
});

test("Dev AI chat fallback 再截斷時停止，不形成 provider retry loop", async () => {
  let calls = 0;
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "minimax",
      model: "MiniMax-M3",
      async generateJsonText() {
        calls += 1;
        throw new HttpError(
          502,
          "MiniMax 輸出超過 token 上限",
          "DEV_AI_MINIMAX_OUTPUT_TRUNCATED"
        );
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: { async search() { return emptySearchResult(); } },
  });

  await assert.rejects(
    service.ask({ question: "請簡短回答。", speedMode: "fast" }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_MINIMAX_OUTPUT_TRUNCATED"
  );
  assert.equal(calls, 2);
});

test("Dev AI chat 複雜技術問題第一次即保留較完整輸出空間", async () => {
  const service = createDevAiChatService({
    config: enabledConfig,
    providerClient: {
      name: "minimax",
      model: "MiniMax-M3",
      async generateJsonText(request) {
        assert.equal(request.maxOutputTokens, 1_536);
        return JSON.stringify({
          threadTitle: "技術識別比對",
          answer: "已完成 identity 比對。",
          assumptions: [],
          followUps: [],
          sourceIds: [],
        });
      },
    },
    knowledgeService: { invalidateCache() {}, async search() { return []; } },
    definitionsService: { async search() { return emptySearchResult(); } },
  });

  const result = await service.ask({
    question: "請比對 /forms31/903/881、NodeID 882、欄位 9001066 與欄位 9001067，並列出可確認與不可確認的差異。",
    speedMode: "fast",
  });

  assert.equal(result.outputTokenLimit, 1_536);
  assert.equal(result.providerAttempts, 1);
});

test("Dev AI chat 對長表單平均分配 context 並保留官方、欄位與 workflow evidence", async () => {
  const detail: RagicDefinitionFormDetail = {
    form: {
      schemaVersion: 1,
      formPath: "default/forms999/9001",
      formName: "Demo 工令單",
      nuiFile: "fixture.nui",
      sourceRelativePath: "fixture.nui",
      sourceEncoding: "utf-8",
      counts: { fields: 60, formulas: 0, workflows: 5 },
    },
    fields: Array.from({ length: 60 }, (_, index) => ({
      fieldId: String(9_001_000 + index),
      fieldName: `數量${index}`,
      position: `A${index + 1}`,
      kind: "N",
      sourceLine: index + 1,
      attrs: {},
    })),
    formulas: [],
    workflows: ["pre.js", "post.js", "sheet-scope.js", "approval.js", "daily.js"].map(
      (fileName) => ({
        fileName,
        scope: fileName.replace(".js", ""),
        content: `// ${fileName}\nvar entry = param.getUpdatedEntry();\n${"// demo workflow\n".repeat(500)}`,
        charCount: 8_000,
      })
    ),
  };
  const official = RAGIC_OFFICIAL_KNOWLEDGE_SEEDS.find(
    (seed) => seed.sourceId === "official:ragic-workflow-es5"
  );
  assert.ok(official);
  const service = createDevAiChatService({
    config: enabledConfig,
    knowledgeService: {
      invalidateCache() {},
      async search() { return [{ ...official, score: 1, excerpt: official.content }]; },
    },
    definitionsService: {
      async readForm() { return detail; },
      async search() { assert.fail("SCOPED_FORM_REQUIRED"); },
    },
    providerClient: {
      name: "minimax",
      model: "MiniMax-M3",
      async generateJsonText(input) {
        const serialized = input.prompt.split("本次參考資料:\n")[1].split("\n\nMode:\n")[0];
        const sources = JSON.parse(serialized) as DevAiKnowledgeSource[];
        assert.ok(serialized.length <= 8_000, "FAST_CONTEXT_BUDGET_CONTRACT");
        assert.equal(
          sources.find((source) => source.sourceId === official.sourceId)?.excerpt,
          official.content
        );
        assert.ok(sources.some((source) => source.fieldId === "9001054"));
        assert.ok(sources.some((source) => source.sourceType === "workflow"));
        return JSON.stringify({
          threadTitle: "表單 Workflow 核對",
          answer: "已核對來源。",
          assumptions: [],
          followUps: [],
          sourceIds: [official.sourceId],
        });
      },
    },
  });

  const result = await service.ask({
    question: "請核對 A55 A56 A57 A58 欄位與 workflow 程式碼",
    formPath: "default/forms999/9001",
    speedMode: "fast",
    maxSources: 6,
  });

  assert.equal(result.contextPreview.chars <= 8_000, true);
  assert.equal(result.contextSources.length <= 6, true);
});
