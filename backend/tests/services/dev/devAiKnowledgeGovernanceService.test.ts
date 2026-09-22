import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../../src/utils/httpError";
import { createDevAiKnowledgeCandidateRepository } from "../../../src/services/dev/ai/devAiKnowledgeCandidateRepository";
import { createDevAiKnowledgeGovernanceService } from "../../../src/services/dev/ai/devAiKnowledgeGovernanceService";
import type { DevAiFeedbackService } from "../../../src/services/dev/ai/devAiFeedbackService";

test("Dev AI knowledge governance 先建立 pending 候選，核准後才寫入 approved knowledge", async () => {
  const repository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => "candidate-1",
  });
  const approvedCalls: Array<{
    feedbackId: string | null | undefined;
    actor: string | null | undefined;
    title: string | null | undefined;
    domain: string | null | undefined;
  }> = [];
  const approvedKnowledgeWriter: DevAiFeedbackService = {
    async store(_request, options) {
      approvedCalls.push({
        feedbackId: options?.feedbackId,
        actor: options?.actor,
        title: options?.title,
        domain: options?.domain,
      });
      return {
        feedbackId: options?.feedbackId ?? "missing",
        stored: true,
        knowledgePath: "/tmp/approved-examples.jsonl",
        title: "approved",
      };
    },
  };
  let tick = 0;
  const service = createDevAiKnowledgeGovernanceService({
    enabled: true,
    repository,
    approvedKnowledgeWriter,
    now: () => new Date(Date.UTC(2026, 7, 15, 0, tick++, 0)),
  });

  const submitted = await service.submitCandidate(
    {
      payload: {
        kind: "chat-answer",
        question: "Form 901 怎麼查？",
        answer: "請先讀目前 definitions。",
        sourceIds: ["definitions:901"],
      },
      sourceKey: "thread:1:message:2",
      sourceThreadId: "thread-1",
      sourceMessageId: "message-2",
    },
    { actor: "alice" }
  );

  assert.equal(submitted.candidate.status, "pending");
  assert.equal(approvedCalls.length, 0);
  const duplicate = await service.submitCandidate(
    {
      payload: submitted.candidate.payload,
      sourceKey: "thread:1:message:2",
    },
    { actor: "alice" }
  );
  assert.equal(duplicate.duplicate, true);

  const approved = await service.approveCandidate(
    submitted.candidate.id,
    "已核對 definitions",
    { actor: "reviewer" }
  );
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewedBy, "reviewer");
  assert.equal(approved.updatedBy, "reviewer");
  assert.deepEqual(approvedCalls, [{
    feedbackId: "candidate-1",
    actor: "reviewer",
    title: "Form 901 怎麼查？",
    domain: "ragic",
  }]);
  await repository.close();
});

test("公式知識候選標題與 payload 保留 occurrence identity", async () => {
  const repository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => "candidate-formula",
  });
  const service = createDevAiKnowledgeGovernanceService({
    enabled: true,
    repository,
    approvedKnowledgeWriter: {
      async store() {
        throw new Error("pending 候選不應直接發布");
      },
    },
  });

  const submitted = await service.submitCandidate({
    payload: {
      kind: "formula-suggestion",
      objective: "修改第二個 occurrence",
      proposedFormula: "X31",
      formPath: "default/demo/1",
      fieldId: "7654321",
      position: "Y31",
      sourceLine: 40,
      formulaKind: "formula",
    },
  }, { actor: "alice" });

  assert.equal(submitted.candidate.title, "default/demo/1 · 7654321 · Y31");
  assert.equal(submitted.candidate.payload.position, "Y31");
  assert.equal(submitted.candidate.payload.sourceLine, 40);
  await repository.close();
});

test("Dev AI knowledge governance 會序列化同一候選的核准與拒絕", async () => {
  const repository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => "candidate-race",
  });
  let releasePublish: (() => void) | undefined;
  const publishGate = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  let confirmPublishStarted: (() => void) | undefined;
  const publishStarted = new Promise<void>((resolve) => {
    confirmPublishStarted = resolve;
  });
  const service = createDevAiKnowledgeGovernanceService({
    enabled: true,
    repository,
    approvedKnowledgeWriter: {
      async store(_request, options) {
        confirmPublishStarted?.();
        await publishGate;
        return {
          feedbackId: options?.feedbackId ?? "missing",
          stored: true,
          knowledgePath: "/tmp/approved-examples.jsonl",
          title: "approved",
        };
      },
    },
  });
  const submitted = await service.submitCandidate(
    {
      payload: {
        kind: "chat-answer",
        question: "同時審核會怎樣？",
        answer: "同一候選必須依序處理。",
      },
    },
    { actor: "alice" }
  );

  const approving = service.approveCandidate(submitted.candidate.id, undefined, {
    actor: "reviewer-a",
  });
  await publishStarted;
  const rejecting = service.rejectCandidate(submitted.candidate.id, undefined, {
    actor: "reviewer-b",
  });
  releasePublish?.();

  assert.equal((await approving).status, "approved");
  await assert.rejects(
    rejecting,
    (error) =>
      error instanceof HttpError && error.code === "DEV_AI_KNOWLEDGE_CANDIDATE_NOT_PENDING"
  );
  assert.equal((await service.getCandidate(submitted.candidate.id)).status, "approved");
  await repository.close();
});

test("Dev AI knowledge governance 不允許修改已拒絕候選", async () => {
  const repository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => "candidate-2",
  });
  const service = createDevAiKnowledgeGovernanceService({
    enabled: true,
    repository,
    approvedKnowledgeWriter: {
      async store() {
        throw new Error("must not publish rejected knowledge");
      },
    },
  });
  const submitted = await service.submitCandidate(
    {
      payload: {
        kind: "chat-answer",
        question: "錯誤答案",
        answer: "不要收錄",
        sourceIds: [],
      },
    },
    { actor: "alice" }
  );
  await service.rejectCandidate(submitted.candidate.id, "無來源", { actor: "reviewer" });

  await assert.rejects(
    () => service.updateCandidate(
      submitted.candidate.id,
      { title: "重改" },
      { actor: "editor" }
    ),
    (error) =>
      error instanceof HttpError && error.code === "DEV_AI_KNOWLEDGE_CANDIDATE_NOT_PENDING"
  );
  await repository.close();
});

test("Dev AI knowledge governance 發布完成但 finalize 失敗時保留 publishing 並可安全重試", async () => {
  const baseRepository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => "candidate-recover",
  });
  let failFinalize = true;
  const repository = {
    ...baseRepository,
    async finalizeApproval(input: Parameters<typeof baseRepository.finalizeApproval>[0]) {
      if (failFinalize) {
        failFinalize = false;
        throw new Error("simulated finalize failure");
      }
      return baseRepository.finalizeApproval(input);
    },
  };
  const publishedFeedbackIds: string[] = [];
  const service = createDevAiKnowledgeGovernanceService({
    enabled: true,
    repository,
    approvedKnowledgeWriter: {
      async store(_request, options) {
        publishedFeedbackIds.push(options?.feedbackId ?? "missing");
        return {
          feedbackId: options?.feedbackId ?? "missing",
          stored: true,
          knowledgePath: "/tmp/approved-examples.jsonl",
          title: "approved",
        };
      },
    },
  });
  const submitted = await service.submitCandidate(
    {
      payload: {
        kind: "chat-answer",
        question: "發布中斷怎麼恢復？",
        answer: "沿用相同 candidate id 重試。",
      },
    },
    { actor: "alice" }
  );

  await assert.rejects(
    () => service.approveCandidate(submitted.candidate.id, "已核准", { actor: "reviewer" }),
    (error) =>
      error instanceof HttpError && error.code === "DEV_AI_KNOWLEDGE_FINALIZE_FAILED"
  );
  assert.equal((await service.getCandidate(submitted.candidate.id)).status, "publishing");
  await assert.rejects(
    () => service.rejectCandidate(submitted.candidate.id, "改拒絕", { actor: "reviewer" }),
    (error) =>
      error instanceof HttpError && error.code === "DEV_AI_KNOWLEDGE_CANDIDATE_NOT_PENDING"
  );

  const recovered = await service.approveCandidate(
    submitted.candidate.id,
    undefined,
    { actor: "reviewer" }
  );
  assert.equal(recovered.status, "approved");
  assert.deepEqual(publishedFeedbackIds, ["candidate-recover", "candidate-recover"]);
  await baseRepository.close();
});

test("Dev AI knowledge governance 會回傳 cursor 並拒絕不合法 cursor", async () => {
  let id = 0;
  const repository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => `candidate-cursor-${id++}`,
  });
  const service = createDevAiKnowledgeGovernanceService({ enabled: true, repository });
  for (let index = 0; index < 3; index += 1) {
    await service.submitCandidate(
      {
        payload: {
          kind: "chat-answer",
          question: `問題 ${index}`,
          answer: `答案 ${index}`,
        },
      },
      { actor: "alice" }
    );
  }

  const firstPage = await service.listCandidates({ limit: 2 });
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  const secondPage = await service.listCandidates({ limit: 2, cursor: firstPage.nextCursor });
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.hasMore, false);
  await assert.rejects(
    () => service.listCandidates({ cursor: "not-a-cursor" }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_KNOWLEDGE_BAD_CURSOR"
  );
  await repository.close();
});
