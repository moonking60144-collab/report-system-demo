import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DevAiThreadArtifact, DevAiThreadMessage } from "@shared-types/ragicDefinitions";
import { ConversationMessage } from "./DevAiView";

function message(): DevAiThreadMessage {
  return {
    id: "assistant-1",
    threadId: "thread-1",
    role: "assistant",
    content: "**公開回答**",
    intent: "general",
    model: "fixture",
    status: "completed",
    createdAt: "2026-09-22T00:00:00.000Z",
    metadata: { answerFormat: "markdown" },
  };
}

function chatArtifact(payload: Record<string, unknown>): DevAiThreadArtifact {
  return {
    id: "artifact-1",
    messageId: "assistant-1",
    threadId: "thread-1",
    type: "chat-result",
    payload,
    createdAt: "2026-09-22T00:00:00.000Z",
  };
}

describe("Dev AI conversation evidence", () => {
  it("只把 citedEvidence 顯示成回答引用，contextSources 不會自動冒充引用", () => {
    const html = renderToStaticMarkup(
      <ConversationMessage
        message={message()}
        question="Ragic 是什麼？"
        artifacts={[chatArtifact({
          contextSources: [{
            sourceId: "context-only",
            title: "只進入 context",
            kind: "official",
            excerpt: "未被模型引用",
            score: 1,
          }],
          citedEvidence: [{
            sourceId: "cited",
            title: "模型實際引用",
            kind: "official",
            excerpt: "公開證據",
            score: 2,
          }],
        })]}
        knowledgeState={undefined}
        onSubmitKnowledgeCandidate={async () => undefined}
      />
    );
    expect(html).toContain("模型實際引用");
    expect(html).not.toContain("只進入 context");
    expect(html).toContain("<strong>公開回答</strong>");
  });

  it("舊 artifact 只有 sources 時仍顯示引用來源", () => {
    const html = renderToStaticMarkup(
      <ConversationMessage
        message={message()}
        question="舊問題"
        artifacts={[chatArtifact({ sources: [{
          sourceId: "legacy",
          title: "舊版來源",
          kind: "curated",
          excerpt: "舊版 evidence",
          score: 1,
        }] })]}
        knowledgeState="saved"
        onSubmitKnowledgeCandidate={async () => undefined}
      />
    );
    expect(html).toContain("舊版來源");
    expect(html).toContain("已送交知識審核");
  });
});
