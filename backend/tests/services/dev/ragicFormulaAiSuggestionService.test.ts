import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../../src/utils/httpError";
import {
  createGoogleGeminiClient,
  type GoogleGeminiClient,
} from "../../../src/services/dev/ai/googleGeminiClient";
import {
  createRagicFormulaAiSuggestionService,
  type RagicFormulaAiRuntimeConfig,
} from "../../../src/services/dev/ai/ragicFormulaAiSuggestionService";
import type { RagicFormulaAiContextBuilder } from "../../../src/services/dev/ai/ragicFormulaAiContextBuilder";
import type { RagicFormulaPatchDryRunService } from "../../../src/services/dev/ragicFormulaPatchDryRunService";
import type { RagicFormulaPatchDryRunResult } from "@shared-types/ragicDefinitions";

const enabledConfig: RagicFormulaAiRuntimeConfig = {
  enabled: true,
  provider: "google",
  model: "gemini-test",
  thinkingLevel: "minimal",
  maxOutputTokens: 512,
  maxConcurrentRequests: 2,
  suggestRateLimitPerMinute: 6,
  storeInteractions: false,
  storeRawOutput: false,
};

function dryRunResult(newFormula: string): RagicFormulaPatchDryRunResult {
  return {
    allowed: true,
    mode: "dry-run",
    formPath: "default/devtest/51",
    formName: "luo test",
    fieldId: "1036641",
    fieldName: "測試",
    position: "G6",
    formulaKind: "formula",
    sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
    builderFilePath: "/tmp/51.nui",
    sourceLine: 24,
    oldFormula: "F6*D6+123456",
    newFormula,
    oldLinePreview: "D,7,6,1036641,測試,text=1&f=F6*D6+123456",
    newLinePreview: `D,7,6,1036641,測試,text=1&f=${newFormula}`,
    gitClean: true,
    warnings: [],
    blockers: [],
  };
}

function contextBuilder(): RagicFormulaAiContextBuilder {
  return {
    async buildContext() {
      return {
        promptContext: "{\"targetField\":{\"fieldId\":\"1036641\",\"position\":\"G6\"}}",
        preview: { fields: 2, formulas: 1, siblings: 0, similarItems: 0, chars: 60 },
        fieldsById: new Map([
          ["1036641", {
            fieldId: "1036641",
            fieldName: "測試",
            kind: "D",
            position: "G6",
            sourceLine: 24,
            attrs: {},
          }],
          ["1036615", {
            fieldId: "1036615",
            fieldName: "編號",
            kind: "D",
            position: "D6",
            sourceLine: 13,
            attrs: {},
          }],
        ]),
        positions: new Set(["G6", "F6", "D6"]),
      };
    },
  };
}

function dryRunService(calls: unknown[] = []): RagicFormulaPatchDryRunService {
  return {
    async dryRunFormulaPatch(input) {
      calls.push(input);
      return dryRunResult(input.newFormula);
    },
  };
}

test("AI disabled 時不呼叫 Google", async () => {
  let googleCalled = false;
  const googleClient: GoogleGeminiClient = {
    model: "gemini-test",
    async generateJsonText() {
      googleCalled = true;
      return "{}";
    },
  };
  const service = createRagicFormulaAiSuggestionService({
    config: { ...enabledConfig, enabled: false },
    googleClient,
    contextBuilder: contextBuilder(),
    dryRunService: dryRunService(),
  });

  await assert.rejects(
    () =>
      service.suggestFormula({
        formPath: "default/devtest/51",
        fieldId: "1036641",
        formulaKind: "formula",
        objective: "產生測試公式",
      }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_DISABLED"
  );
  assert.equal(googleCalled, false);
});

test("AI suggestion 解析 Google JSON 並呼叫 dry-run，不碰 apply", async () => {
  const dryRunCalls: unknown[] = [];
  const googleClient: GoogleGeminiClient = {
    model: "gemini-test",
    async generateJsonText(request) {
      assert.match(request.prompt, /產生測試公式/);
      assert.match(request.prompt, /不要把「欄位不存在」誤寫成 ISBLANK/);
      assert.equal(request.schema.type, "object");
      assert.equal(request.model, "gemini-test");
      assert.equal(request.thinkingLevel, "minimal");
      assert.equal(request.maxOutputTokens, 512);
      assert.equal(request.storeInteraction, false);
      return JSON.stringify({
        proposedFormula: "F6*D6+1",
        explanation: "依照現有欄位加總。",
        assumptions: ["F6 與 D6 已存在"],
        referencedFields: [
          { fieldId: "1036615", position: "D6", name: "編號", reason: "測試引用" },
        ],
        risks: [],
        confidence: "high",
      });
    },
  };
  const service = createRagicFormulaAiSuggestionService({
    config: enabledConfig,
    googleClient,
    contextBuilder: contextBuilder(),
    dryRunService: dryRunService(dryRunCalls),
    suggestionIdFactory: () => "suggestion-1",
  });

  const result = await service.suggestFormula({
    formPath: "default/devtest/51",
    fieldId: "1036641",
    formulaKind: "formula",
    objective: "產生測試公式",
  });

  assert.equal(result.suggestionId, "suggestion-1");
  assert.equal(result.proposedFormula, "F6*D6+1");
  assert.equal(result.dryRun.allowed, true);
  assert.equal(result.dryRun.blockers.length, 0);
  assert.equal(result.confidence, "high");
  assert.equal(dryRunCalls.length, 1);
});

test("Google malformed JSON 會回中文分類錯誤且不呼叫 dry-run", async () => {
  const dryRunCalls: unknown[] = [];
  const googleClient: GoogleGeminiClient = {
    model: "gemini-test",
    async generateJsonText() {
      return "not json";
    },
  };
  const service = createRagicFormulaAiSuggestionService({
    config: enabledConfig,
    googleClient,
    contextBuilder: contextBuilder(),
    dryRunService: dryRunService(dryRunCalls),
  });

  await assert.rejects(
    () =>
      service.suggestFormula({
        formPath: "default/devtest/51",
        fieldId: "1036641",
        formulaKind: "formula",
        objective: "產生測試公式",
      }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_GOOGLE_MALFORMED_JSON"
  );
  assert.equal(dryRunCalls.length, 0);
});

test("AI output 引用不存在欄位或位置會加 blocker", async () => {
  const googleClient: GoogleGeminiClient = {
    model: "gemini-test",
    async generateJsonText() {
      return JSON.stringify({
        proposedFormula: "ZZ99+1",
        explanation: "測試不存在位置。",
        assumptions: [],
        referencedFields: [
          { fieldId: "9999999", position: "ZZ99", name: "不存在", reason: "測試" },
        ],
        risks: [],
        confidence: "medium",
      });
    },
  };
  const service = createRagicFormulaAiSuggestionService({
    config: enabledConfig,
    googleClient,
    contextBuilder: contextBuilder(),
    dryRunService: dryRunService(),
  });

  const result = await service.suggestFormula({
    formPath: "default/devtest/51",
    fieldId: "1036641",
    formulaKind: "formula",
    objective: "產生測試公式",
  });

  assert.equal(result.dryRun.allowed, false);
  assert.equal(result.confidence, "low");
  assert.match(result.dryRun.blockers.join("\n"), /AI 引用不存在欄位 ID/);
  assert.match(result.dryRun.blockers.join("\n"), /AI 公式引用目前表單不存在的位置/);
  assert.match(result.risks.join("\n"), /Dry-run 阻擋：AI 引用不存在欄位 ID/);
});

test("dry-run 阻擋會覆蓋 Google high confidence 並寫入風險", async () => {
  const googleClient: GoogleGeminiClient = {
    model: "gemini-test",
    async generateJsonText() {
      return JSON.stringify({
        proposedFormula: "IF(ISBLANK(C6), \"\", F6*D6+06100655)",
        explanation: "測試循環參照。",
        assumptions: [],
        referencedFields: [
          { fieldId: "1036615", position: "D6", name: "編號", reason: "測試引用" },
        ],
        risks: [],
        confidence: "high",
      });
    },
  };
  const dryRunCalls: unknown[] = [];
  const blockingDryRunService: RagicFormulaPatchDryRunService = {
    async dryRunFormulaPatch(input) {
      dryRunCalls.push(input);
      return {
        ...dryRunResult(input.newFormula),
        allowed: false,
        blockers: ["公式會造成循環參照：G6 -> C6 -> G6"],
      };
    },
  };
  const service = createRagicFormulaAiSuggestionService({
    config: enabledConfig,
    googleClient,
    contextBuilder: contextBuilder(),
    dryRunService: blockingDryRunService,
  });

  const result = await service.suggestFormula({
    formPath: "default/devtest/51",
    fieldId: "1036641",
    formulaKind: "formula",
    objective: "假如欄位不存在，不執行這個公式",
  });

  assert.equal(dryRunCalls.length, 1);
  assert.equal(result.dryRun.allowed, false);
  assert.equal(result.confidence, "low");
  assert.match(result.risks.join("\n"), /Dry-run 阻擋：公式會造成循環參照/);
});

test("Google client 將 401 與 429 分類成中文錯誤", async () => {
  for (const [status, code] of [
    [401, "DEV_AI_GOOGLE_AUTH_FAILED"],
    [429, "DEV_AI_GOOGLE_RATE_LIMITED"],
  ] as const) {
    const client = createGoogleGeminiClient(
      { apiKey: "key", model: "gemini-test", timeoutMs: 1000 },
      (async () => new Response("{}", { status })) as typeof fetch
    );
    await assert.rejects(
      () => client.generateJsonText({ prompt: "x", schema: { type: "object" } }),
      (error) => error instanceof HttpError && error.code === code
    );
  }
});

test("Google client request 帶 speed 相關 generation config", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const client = createGoogleGeminiClient(
    { apiKey: "key", model: "gemini-default", timeoutMs: 1000, thinkingLevel: "minimal", storeInteractions: false },
    (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ output_text: "{\"ok\":true}" }), { status: 200 });
    }) as typeof fetch
  );

  await client.generateJsonText({
    prompt: "x",
    schema: { type: "object" },
    model: "gemini-fast",
    thinkingLevel: "low",
    maxOutputTokens: 321,
    storeInteraction: true,
  });

  assert.ok(capturedBody);
  const body = capturedBody as Record<string, unknown>;
  assert.equal(body.model, "gemini-fast");
  assert.equal(body.store, true);
  assert.deepEqual(body.generation_config, {
    thinking_level: "low",
    max_output_tokens: 321,
  });
});

test("Google client timeout 會回 DEV_AI_GOOGLE_TIMEOUT", async () => {
  const client = createGoogleGeminiClient(
    { apiKey: "key", model: "gemini-test", timeoutMs: 5 },
    (async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch
  );

  await assert.rejects(
    () => client.generateJsonText({ prompt: "x", schema: { type: "object" } }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_GOOGLE_TIMEOUT"
  );
});
