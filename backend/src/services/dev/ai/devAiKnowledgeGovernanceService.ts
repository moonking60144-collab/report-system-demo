import { createHash } from "node:crypto";
import { env } from "../../../config/env";
import { HttpError } from "../../../utils/httpError";
import { createKeyedSerialQueue } from "../../../utils/keyedSerialQueue";
import { maskSecrets } from "../ragicFormulaPatchDryRunService";
import {
  devAiFeedbackService,
  normalizeDevAiFeedbackRequest,
  type DevAiFeedbackService,
} from "./devAiFeedbackService";
import {
  devAiKnowledgeCandidateRepository,
  type KnowledgeCandidateCursor,
  type DevAiKnowledgeCandidateRepository,
} from "./devAiKnowledgeCandidateRepository";
import type {
  DevAiFeedbackRequest,
  DevAiKnowledgeCandidate,
  DevAiKnowledgeCandidateListResult,
  DevAiKnowledgeCandidateStatus,
  DevAiKnowledgeCandidateSubmissionResult,
  DevAiKnowledgeCandidateSubmitRequest,
  DevAiKnowledgeCandidateUpdateRequest,
  DevAiKnowledgeDomain,
} from "@shared-types/ragicDefinitions";

export interface DevAiKnowledgeGovernanceOptions {
  actor: string;
  clientId?: string | null;
  tabId?: string | null;
}

export interface DevAiKnowledgeGovernanceServiceDeps {
  enabled?: boolean;
  repository?: DevAiKnowledgeCandidateRepository;
  approvedKnowledgeWriter?: DevAiFeedbackService;
  now?: () => Date;
}

export interface DevAiKnowledgeGovernanceService {
  submitCandidate(
    request: DevAiKnowledgeCandidateSubmitRequest,
    options: DevAiKnowledgeGovernanceOptions
  ): Promise<DevAiKnowledgeCandidateSubmissionResult>;
  listCandidates(input?: {
    status?: DevAiKnowledgeCandidateStatus;
    kind?: DevAiFeedbackRequest["kind"];
    query?: string;
    limit?: number;
    cursor?: string;
  }): Promise<DevAiKnowledgeCandidateListResult>;
  getCandidate(candidateId: string): Promise<DevAiKnowledgeCandidate>;
  updateCandidate(
    candidateId: string,
    request: DevAiKnowledgeCandidateUpdateRequest,
    options: DevAiKnowledgeGovernanceOptions
  ): Promise<DevAiKnowledgeCandidate>;
  approveCandidate(
    candidateId: string,
    note: string | undefined,
    options: DevAiKnowledgeGovernanceOptions
  ): Promise<DevAiKnowledgeCandidate>;
  rejectCandidate(
    candidateId: string,
    note: string | undefined,
    options: DevAiKnowledgeGovernanceOptions
  ): Promise<DevAiKnowledgeCandidate>;
}

const KNOWLEDGE_DOMAINS = new Set<DevAiKnowledgeDomain>([
  "ragic",
  "definitions",
  "internal-sop",
  "meeting",
]);

function compactText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function sanitizeFeedbackPayload(request: DevAiFeedbackRequest): DevAiFeedbackRequest {
  const normalized = normalizeDevAiFeedbackRequest(request);
  return JSON.parse(maskSecrets(JSON.stringify(normalized))) as DevAiFeedbackRequest;
}

function normalizeDomain(
  value: DevAiKnowledgeDomain | undefined,
  payload: DevAiFeedbackRequest
): DevAiKnowledgeDomain {
  if (value && KNOWLEDGE_DOMAINS.has(value)) return value;
  return payload.kind === "formula-suggestion" ? "definitions" : "ragic";
}

function candidateTitle(payload: DevAiFeedbackRequest, requestedTitle?: string): string {
  const explicit = compactText(requestedTitle, 160);
  if (explicit) return explicit;
  if (payload.kind === "chat-answer") {
    return compactText(payload.question, 160) || "未命名問答知識";
  }
  const formPath = compactText(payload.formPath, 100) || "未指定表單";
  const fieldId = compactText(payload.fieldId, 60) || "未指定欄位";
  const position = compactText(payload.position, 40);
  return `${formPath} · ${fieldId}${position ? ` · ${position}` : ""}`;
}

function candidateFingerprint(params: {
  sourceKey?: string | null;
  payload: DevAiFeedbackRequest;
  domain: DevAiKnowledgeDomain;
}): string {
  const sourceKey = compactText(params.sourceKey, 500);
  const value = sourceKey
    ? `source:${sourceKey}`
    : JSON.stringify({ domain: params.domain, payload: params.payload });
  return createHash("sha256").update(value).digest("hex");
}

function assertEnabled(enabled: boolean): void {
  if (!enabled) throw new HttpError(403, "Dev AI 未啟用", "DEV_AI_DISABLED");
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /SQLITE_CONSTRAINT.*UNIQUE/i.test(error.message);
}

function encodeCandidateCursor(cursor: KnowledgeCandidateCursor | null): string | null {
  return cursor
    ? Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
    : null;
}

function decodeCandidateCursor(value: string | undefined): KnowledgeCandidateCursor | undefined {
  const cursor = compactText(value, 1_000);
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.updatedAt === "string" && typeof parsed.id === "string") {
      const updatedAt = parsed.updatedAt.trim();
      const id = parsed.id.trim();
      if (updatedAt && id && Number.isFinite(Date.parse(updatedAt))) return { updatedAt, id };
    }
  } catch {}
  throw new HttpError(400, "知識列表 cursor 不合法", "DEV_AI_KNOWLEDGE_BAD_CURSOR");
}

export function createDevAiKnowledgeGovernanceService(
  deps: DevAiKnowledgeGovernanceServiceDeps = {}
): DevAiKnowledgeGovernanceService {
  const enabled = deps.enabled ?? (env.DEV_AI_ENABLED || env.DEMO_MODE);
  const repository = deps.repository ?? devAiKnowledgeCandidateRepository;
  const approvedKnowledgeWriter = deps.approvedKnowledgeWriter ?? devAiFeedbackService;
  const now = deps.now ?? (() => new Date());
  const candidateMutationQueue = createKeyedSerialQueue();

  async function runCandidateMutation<T>(
    candidateId: string,
    mutation: () => Promise<T>
  ): Promise<T> {
    let result: T | undefined;
    await candidateMutationQueue.enqueue(candidateId, async () => {
      result = await mutation();
    });
    return result as T;
  }

  async function requireCandidate(candidateId: string): Promise<DevAiKnowledgeCandidate> {
    const candidate = await repository.getCandidate(candidateId.trim());
    if (!candidate) {
      throw new HttpError(404, "找不到候選知識", "DEV_AI_KNOWLEDGE_CANDIDATE_NOT_FOUND");
    }
    return candidate;
  }

  return {
    async submitCandidate(request, options) {
      assertEnabled(enabled);
      const payload = sanitizeFeedbackPayload(request.payload);
      const domain = normalizeDomain(request.domain, payload);
      const sourceKey = compactText(request.sourceKey, 500) || null;
      const result = await repository.createCandidate({
        fingerprint: candidateFingerprint({ sourceKey, payload, domain }),
        kind: payload.kind,
        domain,
        title: maskSecrets(candidateTitle(payload, request.title)),
        payload,
        sourceKey,
        sourceThreadId: compactText(request.sourceThreadId, 120) || null,
        sourceMessageId: compactText(request.sourceMessageId, 120) || null,
        createdBy: options.actor,
        now: now().toISOString(),
      });
      return { candidate: result.candidate, duplicate: !result.created };
    },

    async listCandidates(input = {}) {
      assertEnabled(enabled);
      const requestedLimit =
        typeof input.limit === "number" && Number.isFinite(input.limit)
          ? Math.trunc(input.limit)
          : 100;
      const cursor = decodeCandidateCursor(input.cursor);
      const result = await repository.listCandidates({
        ...(input.status ? { status: input.status } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(compactText(input.query, 200) ? { query: compactText(input.query, 200) } : {}),
        limit: Math.min(200, Math.max(1, requestedLimit)),
        ...(cursor ? { cursor } : {}),
      });
      return {
        items: result.items,
        counts: result.counts,
        hasMore: result.hasMore,
        nextCursor: encodeCandidateCursor(result.nextCursor),
      };
    },

    async getCandidate(candidateId) {
      assertEnabled(enabled);
      return requireCandidate(candidateId);
    },

    async updateCandidate(candidateId, request, options) {
      assertEnabled(enabled);
      return runCandidateMutation(candidateId, async () => {
        const current = await requireCandidate(candidateId);
        if (current.status !== "pending") {
          throw new HttpError(
            409,
            "只有待審核知識可以修改",
            "DEV_AI_KNOWLEDGE_CANDIDATE_NOT_PENDING"
          );
        }
        const payload = request.payload
          ? sanitizeFeedbackPayload(request.payload)
          : current.payload;
        const domain = normalizeDomain(request.domain ?? current.domain, payload);
        try {
          const updated = await repository.updateCandidate({
            candidateId: current.id,
            fingerprint: candidateFingerprint({
              sourceKey: current.sourceKey,
              payload,
              domain,
            }),
            title: maskSecrets(candidateTitle(payload, request.title ?? current.title)),
            domain,
            payload,
            updatedBy: options.actor,
            updatedAt: now().toISOString(),
          });
          if (updated) return updated;
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new HttpError(
              409,
              "已有相同內容的候選知識",
              "DEV_AI_KNOWLEDGE_CANDIDATE_DUPLICATE"
            );
          }
          throw error;
        }
        throw new HttpError(
          409,
          "候選知識狀態已變更，請重新整理",
          "DEV_AI_KNOWLEDGE_CANDIDATE_NOT_PENDING"
        );
      });
    },

    async approveCandidate(candidateId, note, options) {
      assertEnabled(enabled);
      return runCandidateMutation(candidateId, async () => {
        let current = await requireCandidate(candidateId);
        if (current.status === "approved") return current;
        if (current.status === "pending") {
          const reviewedAt = now().toISOString();
          const publishing = await repository.beginApproval({
            candidateId: current.id,
            reviewedBy: options.actor,
            reviewedAt,
            reviewNote: compactText(note, 2_000) || null,
          });
          current = publishing ?? await requireCandidate(current.id);
        }
        if (current.status !== "publishing") {
          throw new HttpError(
            409,
            "已拒絕的候選知識不能直接核准",
            "DEV_AI_KNOWLEDGE_CANDIDATE_NOT_PENDING"
          );
        }
        await approvedKnowledgeWriter.store(current.payload, {
          actor: current.reviewedBy ?? options.actor,
          clientId: options.clientId,
          tabId: options.tabId,
          feedbackId: current.id,
          title: current.title,
          domain: current.domain,
        });
        let approved: DevAiKnowledgeCandidate | null;
        try {
          approved = await repository.finalizeApproval({
            candidateId: current.id,
            approvedFeedbackId: current.id,
            updatedAt: now().toISOString(),
          });
        } catch {
          throw new HttpError(
            503,
            "知識內容已寫入，但發布狀態尚未確認；請重試發布",
            "DEV_AI_KNOWLEDGE_FINALIZE_FAILED"
          );
        }
        if (approved) return approved;
        const latest = await requireCandidate(current.id);
        if (latest.status === "approved") return latest;
        throw new HttpError(
          503,
          "知識內容已寫入，但發布狀態尚未確認；請重試發布",
          "DEV_AI_KNOWLEDGE_FINALIZE_FAILED"
        );
      });
    },

    async rejectCandidate(candidateId, note, options) {
      assertEnabled(enabled);
      return runCandidateMutation(candidateId, async () => {
        const current = await requireCandidate(candidateId);
        if (current.status === "rejected") return current;
        if (current.status !== "pending") {
          throw new HttpError(
            409,
            "已發布的知識不能改成拒絕",
            "DEV_AI_KNOWLEDGE_CANDIDATE_NOT_PENDING"
          );
        }
        const rejected = await repository.rejectCandidate({
          candidateId: current.id,
          reviewedBy: options.actor,
          reviewedAt: now().toISOString(),
          reviewNote: compactText(note, 2_000) || null,
        });
        if (rejected) return rejected;
        throw new HttpError(
          409,
          "候選知識狀態已變更，請重新整理",
          "DEV_AI_KNOWLEDGE_CANDIDATE_NOT_PENDING"
        );
      });
    },
  };
}

export const devAiKnowledgeGovernanceService = createDevAiKnowledgeGovernanceService();
