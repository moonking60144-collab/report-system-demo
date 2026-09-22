import { describe, expect, it } from "vitest";
import {
  knowledgeCandidateKindLabel,
  knowledgeCandidateStatusLabel,
  knowledgeDomainLabel,
  hasKnowledgeCandidateUnsavedChanges,
  mergeKnowledgeCandidatePages,
} from "./devKnowledgeViewUtils";
import type {
  DevAiKnowledgeCandidate,
  DevAiKnowledgeCandidateListResult,
} from "@shared-types/ragicDefinitions";

function candidate(
  id: string,
  patch: Partial<DevAiKnowledgeCandidate> = {}
): DevAiKnowledgeCandidate {
  return {
    id,
    kind: "chat-answer",
    status: "pending",
    domain: "ragic",
    title: id,
    payload: { kind: "chat-answer", question: id, answer: id },
    sourceKey: null,
    sourceThreadId: null,
    sourceMessageId: null,
    createdBy: "alice",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedBy: "alice",
    updatedAt: "2026-08-15T00:00:00.000Z",
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    approvedFeedbackId: null,
    ...patch,
  };
}

describe("Dev knowledge 管理文案", () => {
  it("把資料狀態轉成管理者可理解的發布語意", () => {
    expect(knowledgeCandidateStatusLabel("pending")).toBe("待審核");
    expect(knowledgeCandidateStatusLabel("approved")).toBe("已發布");
    expect(knowledgeCandidateStatusLabel("rejected")).toBe("已拒絕");
    expect(knowledgeCandidateStatusLabel("publishing")).toBe("發布中");
  });

  it("區分問答、公式與來源知識域", () => {
    expect(knowledgeCandidateKindLabel("chat-answer")).toBe("問答");
    expect(knowledgeCandidateKindLabel("formula-suggestion")).toBe("公式");
    expect(knowledgeDomainLabel("definitions")).toBe("Definitions／公式");
    expect(knowledgeDomainLabel("meeting")).toBe("會議決議");
  });

  it("把候選修改與尚未送出的審核備註都視為未儲存狀態", () => {
    const current = candidate("candidate-1", { reviewNote: "原備註" });
    expect(hasKnowledgeCandidateUnsavedChanges(current, false, "原備註")).toBe(false);
    expect(hasKnowledgeCandidateUnsavedChanges(current, true, "原備註")).toBe(true);
    expect(hasKnowledgeCandidateUnsavedChanges(current, false, "新備註")).toBe(true);
  });

  it("載入下一頁時保留既有候選並去除重複 id", () => {
    const first: DevAiKnowledgeCandidateListResult = {
      items: [candidate("candidate-3"), candidate("candidate-2")],
      counts: { total: 3, pending: 3, publishing: 0, approved: 0, rejected: 0 },
      hasMore: true,
      nextCursor: "page-2",
    };
    const second: DevAiKnowledgeCandidateListResult = {
      items: [candidate("candidate-2"), candidate("candidate-1")],
      counts: first.counts,
      hasMore: false,
      nextCursor: null,
    };
    expect(mergeKnowledgeCandidatePages(first, second).items.map((item) => item.id)).toEqual([
      "candidate-3",
      "candidate-2",
      "candidate-1",
    ]);
  });
});
