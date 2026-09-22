import type {
  DevAiFeedbackKind,
  DevAiKnowledgeCandidate,
  DevAiKnowledgeCandidateListResult,
  DevAiKnowledgeCandidateStatus,
  DevAiKnowledgeDomain,
} from "@shared-types/ragicDefinitions";

export function knowledgeCandidateStatusLabel(status: DevAiKnowledgeCandidateStatus): string {
  switch (status) {
    case "pending":
      return "待審核";
    case "publishing":
      return "發布中";
    case "approved":
      return "已發布";
    case "rejected":
      return "已拒絕";
  }
}

export function hasKnowledgeCandidateUnsavedChanges(
  candidate: DevAiKnowledgeCandidate | null,
  dirty: boolean,
  reviewNote: string
): boolean {
  return dirty || reviewNote !== (candidate?.reviewNote ?? "");
}

export function mergeKnowledgeCandidatePages(
  current: DevAiKnowledgeCandidateListResult,
  next: DevAiKnowledgeCandidateListResult
): DevAiKnowledgeCandidateListResult {
  const knownIds = new Set(current.items.map((candidate) => candidate.id));
  return {
    ...next,
    items: [
      ...current.items,
      ...next.items.filter((candidate) => !knownIds.has(candidate.id)),
    ],
  };
}

export function knowledgeCandidateKindLabel(kind: DevAiFeedbackKind): string {
  return kind === "chat-answer" ? "問答" : "公式";
}

export function knowledgeDomainLabel(domain: DevAiKnowledgeDomain): string {
  switch (domain) {
    case "ragic":
      return "Ragic／報工";
    case "definitions":
      return "Definitions／公式";
    case "internal-sop":
      return "內部 SOP";
    case "meeting":
      return "會議決議";
  }
}
