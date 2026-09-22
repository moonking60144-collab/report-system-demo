import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { createDevAiKnowledgeCandidateRepository } from "../../../src/services/dev/ai/devAiKnowledgeCandidateRepository";

test("Dev AI knowledge repository 會去重候選並維護審核統計", async () => {
  const repository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => "candidate-1",
  });
  const input = {
    fingerprint: "fingerprint-1",
    kind: "chat-answer" as const,
    domain: "ragic" as const,
    title: "為什麼不能新增報工？",
    payload: {
      kind: "chat-answer" as const,
      question: "為什麼不能新增報工？",
      answer: "先確認工令狀態。",
      sourceIds: ["definitions:901"],
    },
    sourceKey: "thread:1:message:2",
    sourceThreadId: "thread-1",
    sourceMessageId: "message-2",
    createdBy: "alice",
    now: "2026-08-15T00:00:00.000Z",
  };

  const first = await repository.createCandidate(input);
  const duplicate = await repository.createCandidate(input);

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.candidate.id, first.candidate.id);
  assert.equal(duplicate.candidate.sourceThreadId, "thread-1");

  const publishing = await repository.beginApproval({
    candidateId: first.candidate.id,
    reviewedBy: "reviewer",
    reviewedAt: "2026-08-15T00:01:00.000Z",
    reviewNote: "來源已確認",
  });
  assert.equal(publishing?.status, "publishing");
  const reviewed = await repository.finalizeApproval({
    candidateId: first.candidate.id,
    approvedFeedbackId: first.candidate.id,
    updatedAt: "2026-08-15T00:02:00.000Z",
  });
  assert.equal(reviewed?.status, "approved");

  const listed = await repository.listCandidates({ limit: 20 });
  assert.equal(listed.items.length, 1);
  assert.deepEqual(listed.counts, {
    total: 1,
    pending: 0,
    publishing: 0,
    approved: 1,
    rejected: 0,
  });
  assert.equal(listed.hasMore, false);
  assert.equal(listed.nextCursor, null);
  await repository.close();
});

test("Dev AI knowledge repository 只允許 pending 候選被修改", async () => {
  const repository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => "candidate-2",
  });
  const created = await repository.createCandidate({
    fingerprint: "fingerprint-2",
    kind: "formula-suggestion",
    domain: "definitions",
    title: "default/a/1 · 100",
    payload: {
      kind: "formula-suggestion",
      objective: "空值回 0",
      proposedFormula: "IF(A1==\"\",0,A1)",
      sourceIds: [],
    },
    createdBy: "alice",
    now: "2026-08-15T00:00:00.000Z",
  });

  const updated = await repository.updateCandidate({
    candidateId: created.candidate.id,
    fingerprint: "fingerprint-2-updated",
    title: "空值公式",
    domain: "definitions",
    payload: {
      ...created.candidate.payload,
      explanation: "避免空值參與運算",
    },
    updatedBy: "editor",
    updatedAt: "2026-08-15T00:01:00.000Z",
  });
  assert.equal(updated?.title, "空值公式");
  assert.equal(updated?.updatedBy, "editor");

  await repository.rejectCandidate({
    candidateId: created.candidate.id,
    reviewedBy: "reviewer",
    reviewedAt: "2026-08-15T00:02:00.000Z",
    reviewNote: null,
  });
  assert.equal(
    await repository.updateCandidate({
      candidateId: created.candidate.id,
      fingerprint: "fingerprint-3",
      title: "不可修改",
      domain: "definitions",
      payload: created.candidate.payload,
      updatedBy: "editor",
      updatedAt: "2026-08-15T00:03:00.000Z",
    }),
    null
  );
  await repository.close();
});

test("Dev AI knowledge repository 使用穩定 cursor 讀取所有候選", async () => {
  let id = 0;
  const repository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => `candidate-${String(id++).padStart(2, "0")}`,
  });
  for (let index = 0; index < 5; index += 1) {
    await repository.createCandidate({
      fingerprint: `fingerprint-page-${index}`,
      kind: "chat-answer",
      domain: "ragic",
      title: `候選 ${index}`,
      payload: {
        kind: "chat-answer",
        question: `問題 ${index}`,
        answer: `答案 ${index}`,
      },
      createdBy: "alice",
      now: new Date(Date.UTC(2026, 7, 15, 0, index, 0)).toISOString(),
    });
  }

  const firstPage = await repository.listCandidates({ limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  const secondPage = await repository.listCandidates({
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.items.length, 2);
  assert.equal(secondPage.hasMore, true);
  assert.ok(secondPage.nextCursor);
  const thirdPage = await repository.listCandidates({
    limit: 2,
    cursor: secondPage.nextCursor,
  });
  assert.equal(thirdPage.items.length, 1);
  assert.equal(thirdPage.hasMore, false);
  assert.equal(thirdPage.nextCursor, null);
  assert.deepEqual(
    [...firstPage.items, ...secondPage.items, ...thirdPage.items].map((candidate) => candidate.id),
    ["candidate-04", "candidate-03", "candidate-02", "candidate-01", "candidate-00"]
  );
  await repository.close();
});

test("Dev AI knowledge repository 搜尋支援中文字詞、Field ID 與字面萬用字元", async () => {
  let id = 0;
  const repository = createDevAiKnowledgeCandidateRepository({
    dbFile: ":memory:",
    idFactory: () => `candidate-search-${id++}`,
  });
  const rows = [
    {
      fingerprint: "search-report",
      title: "為什麼不能新增報工？",
      question: "報工新增失敗",
      answer: "先確認工令狀態。",
    },
    {
      fingerprint: "search-percent",
      title: "完成率 100%",
      question: "百分比怎麼看？",
      answer: "顯示完成率。",
    },
    {
      fingerprint: "search-field",
      title: "欄位公式",
      question: "Field ID 9001002 的公式",
      answer: "請查 definitions。",
    },
    {
      fingerprint: "search-quote",
      title: "特殊名稱",
      question: "foo\"bar 欄位",
      answer: "保留雙引號。",
    },
  ];
  for (const [index, row] of rows.entries()) {
    await repository.createCandidate({
      fingerprint: row.fingerprint,
      kind: "chat-answer",
      domain: "ragic",
      title: row.title,
      payload: {
        kind: "chat-answer",
        question: row.question,
        answer: row.answer,
      },
      createdBy: "alice",
      now: new Date(Date.UTC(2026, 7, 15, 0, index, 0)).toISOString(),
    });
  }

  assert.deepEqual(
    (await repository.listCandidates({ query: "不能新增", limit: 20 })).items.map(
      (candidate) => candidate.title
    ),
    ["為什麼不能新增報工？"]
  );
  assert.deepEqual(
    (await repository.listCandidates({ query: "報工", limit: 20 })).items.map(
      (candidate) => candidate.title
    ),
    ["為什麼不能新增報工？"]
  );
  assert.deepEqual(
    (await repository.listCandidates({ query: "9001002", limit: 20 })).items.map(
      (candidate) => candidate.title
    ),
    ["欄位公式"]
  );
  assert.deepEqual(
    (await repository.listCandidates({ query: "%", limit: 20 })).items.map(
      (candidate) => candidate.title
    ),
    ["完成率 100%"]
  );
  assert.deepEqual(
    (await repository.listCandidates({ query: "foo\"bar", limit: 20 })).items.map(
      (candidate) => candidate.title
    ),
    ["特殊名稱"]
  );
  await repository.close();
});

test("Dev AI knowledge repository 會替既有候選重建搜尋索引與狀態統計", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-migration-"));
  const dbFile = path.join(root, "knowledge.sqlite3");
  const legacyDb = await open({ filename: dbFile, driver: sqlite3.Database });
  await legacyDb.exec(`
    CREATE TABLE dev_ai_knowledge_candidates (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      domain TEXT NOT NULL DEFAULT 'ragic',
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_key TEXT,
      source_thread_id TEXT,
      source_message_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_note TEXT,
      approved_feedback_id TEXT
    );
  `);
  await legacyDb.run(
    `INSERT INTO dev_ai_knowledge_candidates (
      id, fingerprint, kind, status, domain, title, payload_json,
      created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "legacy-1",
    "legacy-fingerprint",
    "chat-answer",
    "pending",
    "ragic",
    "舊版報工知識",
    JSON.stringify({
      kind: "chat-answer",
      question: "為什麼不能新增報工？",
      answer: "先確認工令狀態。",
    }),
    "alice",
    "2026-08-15T00:00:00.000Z",
    "2026-08-15T00:00:00.000Z"
  );
  await legacyDb.close();

  const repository = createDevAiKnowledgeCandidateRepository({ dbFile });
  const listed = await repository.listCandidates({ query: "不能新增", limit: 20 });
  assert.deepEqual(listed.items.map((candidate) => candidate.id), ["legacy-1"]);
  assert.deepEqual(listed.counts, {
    total: 1,
    pending: 1,
    publishing: 0,
    approved: 0,
    rejected: 0,
  });
  await repository.close();
});
