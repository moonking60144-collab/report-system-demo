import { describe, expect, it } from "vitest";
import {
  devAiUnavailableMessage,
  devAiKnowledgeUnavailableMessage,
  selectDevAiCitedEvidencePayload,
  shouldApplyDevAiThreadDetailSnapshot,
} from "./devAiViewUtils";

describe("shouldApplyDevAiThreadDetailSnapshot", () => {
  it("allows current detail responses", () => {
    expect(shouldApplyDevAiThreadDetailSnapshot(2, 2)).toBe(true);
  });

  it("drops stale detail responses after a newer local mutation", () => {
    expect(shouldApplyDevAiThreadDetailSnapshot(2, 3)).toBe(false);
  });
});

describe("selectDevAiCitedEvidencePayload", () => {
  it("只把模型明確引用的來源交給引用 UI，不把全部 context 當成引用", () => {
    const contextSources = [{ sourceId: "context-only" }];
    const citedEvidence = [{ sourceId: "cited" }];
    expect(selectDevAiCitedEvidencePayload({ contextSources, citedEvidence })).toBe(
      citedEvidence
    );
  });

  it("舊 artifact 沒有 citedEvidence 時才使用 sources 相容欄位", () => {
    const sources = [{ sourceId: "legacy" }];
    expect(selectDevAiCitedEvidencePayload({ sources })).toBe(sources);
    expect(selectDevAiCitedEvidencePayload({ contextSources: [{ sourceId: "context" }] })).toBe(
      undefined
    );
  });
});

describe("devAiUnavailableMessage", () => {
  it("不會把 zero-config 的停用狀態顯示成 Ready", () => {
    expect(devAiUnavailableMessage(null)).toContain("正在檢查");
    expect(devAiUnavailableMessage({
      chatAvailable: false,
      knowledge: { available: true, state: "not-required" },
      conversation: { enabled: false },
      provider: { enabled: false, configured: false, name: "minimax" },
      retrieval: { mode: "lexical" },
      reason: "conversation-disabled",
    })).toContain("DEV_AI_CONVERSATION_HISTORY_ENABLED=true");
    expect(devAiUnavailableMessage({
      chatAvailable: false,
      knowledge: { available: true, state: "not-required" },
      conversation: { enabled: true },
      provider: { enabled: false, configured: false, name: "minimax" },
      retrieval: { mode: "lexical" },
      reason: "provider-disabled",
    })).toContain("DEV_AI_ENABLED=true");
  });

  it("對話與 provider 都可用時不顯示阻擋訊息", () => {
    expect(devAiUnavailableMessage({
      chatAvailable: true,
      knowledge: { available: true, state: "not-required" },
      conversation: { enabled: true },
      provider: { enabled: true, configured: true, name: "minimax" },
      retrieval: { mode: "lexical" },
      reason: "ready",
    })).toBeNull();
  });
});

describe("devAiKnowledgeUnavailableMessage", () => {
  it("hybrid/vector 未準備時要求關閉 knowledge，不阻擋一般聊天", () => {
    const readiness = {
      chatAvailable: true,
      knowledge: { available: false, state: "missing" as const },
      conversation: { enabled: true },
      provider: { enabled: true, configured: true, name: "minimax" as const },
      retrieval: { mode: "hybrid" as const },
      reason: "ready" as const,
    };
    expect(devAiUnavailableMessage(readiness)).toBeNull();
    expect(devAiKnowledgeUnavailableMessage(readiness)).toContain("knowledge:prepare");
  });
});
