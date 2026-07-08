import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "../../../src/utils/httpError";
import { createDevAiKnowledgeCompilerService } from "../../../src/services/dev/ai/devAiKnowledgeCompilerService";

test("Dev AI knowledge compiler 會把 approved examples 編譯成乾淨 markdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-compile-"));
  const approvedExamplesFile = path.join(root, "approved-examples.jsonl");
  const compiledKnowledgeDir = path.join(root, "compiled");
  await writeFile(
    approvedExamplesFile,
    [
      JSON.stringify({
        title: "Approved chat answer: Funda",
        content: "類型：Funda Dev AI approved chat answer\n問題：Funda 是什麼？\n回答：依內部文件回答。",
        metadata: {
          feedbackId: "feedback-chat",
          kind: "chat-answer",
          createdAt: "2026-07-03T00:00:00.000Z",
          actor: "dev-user",
        },
      }),
      JSON.stringify({
        title: "Approved formula example: default/devtest/51 1036641",
        content: "類型：Funda Dev AI approved formula example\n需求：空值回 0\n建議公式：IF(ISBLANK(A1),0,A1)",
        metadata: {
          feedbackId: "feedback-formula",
          kind: "formula-suggestion",
          createdAt: "2026-07-03T00:01:00.000Z",
          formPath: "default/devtest/51",
          fieldId: "1036641",
          formulaKind: "formula",
        },
      }),
      "{bad json",
    ].join("\n"),
    "utf8"
  );

  let invalidated = false;
  const service = createDevAiKnowledgeCompilerService({
    enabled: true,
    approvedExamplesFile,
    compiledKnowledgeDir,
    now: () => new Date("2026-07-03T01:00:00.000Z"),
    onCompiled: () => {
      invalidated = true;
    },
  });

  const result = await service.compile({ actor: "dev-user" });

  assert.equal(result.skippedMalformed, 1);
  assert.equal(result.wroteFiles.length, 2);
  assert.equal(result.status.approvedExamples.chatAnswers, 1);
  assert.equal(result.status.approvedExamples.formulaSuggestions, 1);
  assert.equal(result.status.compiled.needsCompile, false);
  assert.equal(invalidated, true);

  const chatMarkdown = await readFile(
    path.join(compiledKnowledgeDir, "approved-chat-answers.md"),
    "utf8"
  );
  const formulaMarkdown = await readFile(
    path.join(compiledKnowledgeDir, "approved-formula-examples.md"),
    "utf8"
  );
  assert.match(chatMarkdown, /RAG 應讀取此整理稿/);
  assert.match(chatMarkdown, /Funda 是什麼/);
  assert.match(formulaMarkdown, /IF\(ISBLANK\(A1\),0,A1\)/);
});

test("Dev AI knowledge compiler disabled 時拒絕 compile 但 status 可讀", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-disabled-"));
  const service = createDevAiKnowledgeCompilerService({
    enabled: false,
    approvedExamplesFile: path.join(root, "approved-examples.jsonl"),
    compiledKnowledgeDir: path.join(root, "compiled"),
  });

  const status = await service.getStatus();
  assert.equal(status.enabled, false);
  await assert.rejects(
    () => service.compile(),
    (error) => error instanceof HttpError && error.code === "DEV_AI_DISABLED"
  );
});

test("Dev AI knowledge compiler status 的 compiled entries 以實際 markdown 為準", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-stale-status-"));
  const approvedExamplesFile = path.join(root, "approved-examples.jsonl");
  const compiledKnowledgeDir = path.join(root, "compiled");
  await writeFile(
    approvedExamplesFile,
    [
      JSON.stringify({
        title: "Approved chat answer: one",
        content: "問題：one\n回答：one",
        metadata: {
          feedbackId: "feedback-1",
          kind: "chat-answer",
          createdAt: "2026-07-03T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        title: "Approved chat answer: two",
        content: "問題：two\n回答：two",
        metadata: {
          feedbackId: "feedback-2",
          kind: "chat-answer",
          createdAt: "2026-07-03T00:01:00.000Z",
        },
      }),
    ].join("\n"),
    "utf8"
  );
  await createDevAiKnowledgeCompilerService({
    enabled: true,
    approvedExamplesFile,
    compiledKnowledgeDir,
    now: () => new Date("2026-07-03T00:02:00.000Z"),
  }).compile();
  await writeFile(
    approvedExamplesFile,
    [
      await readFile(approvedExamplesFile, "utf8"),
      JSON.stringify({
        title: "Approved chat answer: three",
        content: "問題：three\n回答：three",
        metadata: {
          feedbackId: "feedback-3",
          kind: "chat-answer",
          createdAt: "2026-07-03T00:03:00.000Z",
        },
      }),
    ].join("\n").trim(),
    "utf8"
  );
  await utimes(
    approvedExamplesFile,
    new Date(Date.now() + 60_000),
    new Date(Date.now() + 60_000)
  );

  const status = await createDevAiKnowledgeCompilerService({
    enabled: true,
    approvedExamplesFile,
    compiledKnowledgeDir,
  }).getStatus();

  assert.equal(status.approvedExamples.chatAnswers, 3);
  assert.equal(status.compiled.needsCompile, true);
  assert.equal(
    status.compiled.files.find((file) => file.kind === "chat-answer")?.entries,
    2
  );
});
