import test from "node:test";
import assert from "node:assert/strict";
import { createDevAiChatService } from "../../../src/services/dev/ai/devAiChatService";
import { knowledgeEvidenceForRanges } from "../../../src/services/dev/ai/devAiKnowledgeEvidence";

test("知識檢索候選數獨立於 fast 回答來源數", async () => {
  const requestedLimits: number[] = [];
  const documents = Array.from({ length: 18 }, (_, index) => {
    const content = `合成規則 ${index + 1}：等待確認後執行。`;
    return { sourceId: `fixture:${index + 1}`, title: `合成規則 ${index + 1}`, kind: "curated" as const,
      score: 18 - index, ...knowledgeEvidenceForRanges(content, [{ start: 0, end: content.length }]) };
  });
  const chat = createDevAiChatService({ config: { enabled: true, provider: "minimax" },
    knowledgeService: { invalidateCache() {}, async search(request) {
      requestedLimits.push(request.maxItems ?? 0);
      return documents.slice(0, request.maxItems);
    } },
    providerClient: { name: "minimax", model: "fixture", async generateJsonText(request) {
      const context = JSON.parse(request.prompt.split("本次參考資料:\n")[1].split("\n\nMode:\n")[0]) as Array<{ sourceId: string }>;
      assert.equal(context.length, 6, "模型實際收到的來源仍受 fast 上限約束");
      return JSON.stringify({ answer: "需要確認。", assumptions: [], followUps: [], sourceIds: [] });
    } },
  });
  const result = await chat.ask({ question: "合成規則如何執行？", mode: "general", speedMode: "fast",
    maxSources: 6, includeDefinitions: false });
  assert.ok(requestedLimits[0] > 6, "檢索應保留多於最終 context 的候選");
  assert.ok(result.contextSources.length <= 6, "回答來源數仍遵守 fast 上限");
});
