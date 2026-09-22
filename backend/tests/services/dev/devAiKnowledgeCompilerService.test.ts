import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "../../../src/utils/httpError";
import { createDevAiKnowledgeCompilerService } from "../../../src/services/dev/ai/devAiKnowledgeCompilerService";
import { createDevAiKnowledgeBaseService } from "../../../src/services/dev/ai/devAiKnowledgeBaseService";
import { createDevAiKnowledgePublicationBarrier } from "../../../src/services/dev/ai/devAiKnowledgePublicationBarrier";

test("Dev AI knowledge compiler 會把 approved examples 編譯成乾淨 markdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-compile-"));
  const approvedExamplesFile = path.join(root, "approved-examples.jsonl");
  const compiledKnowledgeDir = path.join(root, "compiled");
  await writeFile(
    approvedExamplesFile,
    [
      JSON.stringify({
        title: "Approved chat answer: DemoCo",
        content: "類型：DemoCo Dev AI approved chat answer\n問題：DemoCo 是什麼？\n回答：依內部文件回答。",
        metadata: {
          feedbackId: "feedback-chat",
          kind: "chat-answer",
          createdAt: "2026-07-03T00:00:00.000Z",
          actor: "dev-user",
        },
      }),
      JSON.stringify({
        title: "Approved formula example: default/devtest/51 9001108",
        content: "類型：DemoCo Dev AI approved formula example\n需求：空值回 0\n建議公式：IF(ISBLANK(A1),0,A1)",
        metadata: {
          feedbackId: "feedback-formula",
          kind: "formula-suggestion",
          createdAt: "2026-07-03T00:01:00.000Z",
          formPath: "default/devtest/51",
          fieldId: "9001108",
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
  assert.match(chatMarkdown, /DemoCo 是什麼/);
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

test("Dev AI knowledge compiler 會把中斷後的混合 generation 標記為需要重建", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-partial-compile-"));
  const approvedExamplesFile = path.join(root, "approved-examples.jsonl");
  const compiledKnowledgeDir = path.join(root, "compiled");
  const entry = (feedbackId: string, kind: "chat-answer" | "formula-suggestion") =>
    JSON.stringify({
      title: `${kind}: ${feedbackId}`,
      content:
        kind === "chat-answer"
          ? `問題：${feedbackId}\n回答：公開回答`
          : `需求：${feedbackId}\n建議公式：IF(A1=\"\",0,A1)`,
      metadata: {
        feedbackId,
        kind,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    });

  await writeFile(
    approvedExamplesFile,
    [entry("chat-1", "chat-answer"), entry("formula-1", "formula-suggestion")].join("\n"),
    "utf8"
  );
  const service = createDevAiKnowledgeCompilerService({
    enabled: true,
    approvedExamplesFile,
    compiledKnowledgeDir,
  });
  await service.compile();

  await writeFile(
    approvedExamplesFile,
    [
      await readFile(approvedExamplesFile, "utf8"),
      entry("formula-2", "formula-suggestion"),
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(compiledKnowledgeDir, "approved-chat-answers.md"),
    "# partial newer output\n",
    "utf8"
  );

  const status = await service.getStatus();
  assert.equal(
    status.compiled.needsCompile,
    true,
    "PARTIAL_COMPILE_MUST_REQUIRE_REBUILD"
  );
});

test("Dev AI knowledge reader 不會在兩份 compiled 文件發布期間讀到混合 generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-publish-barrier-"));
  const approvedExamplesFile = path.join(root, "approved-examples.jsonl");
  const compiledKnowledgeDir = path.join(root, "compiled");
  const barrier = createDevAiKnowledgePublicationBarrier();
  const entry = (feedbackId: string, kind: "chat-answer" | "formula-suggestion", marker: string) =>
    JSON.stringify({
      title: `${kind}: ${feedbackId}`,
      content:
        kind === "chat-answer"
          ? `問題：${marker}\n回答：${marker}`
          : `需求：${marker}\n建議公式：${marker}`,
      metadata: {
        feedbackId,
        kind,
        createdAt: "2026-07-03T00:00:00.000Z",
      },
    });
  await writeFile(
    approvedExamplesFile,
    [
      entry("chat-old", "chat-answer", "old-chat-marker"),
      entry("formula-old", "formula-suggestion", "old-formula-marker"),
    ].join("\n"),
    "utf8"
  );
  await createDevAiKnowledgeCompilerService({
    enabled: true,
    approvedExamplesFile,
    compiledKnowledgeDir,
    publicationBarrier: barrier,
  }).compile();

  await writeFile(
    approvedExamplesFile,
    [
      entry("chat-new", "chat-answer", "new-chat-marker"),
      entry("formula-new", "formula-suggestion", "new-formula-marker"),
    ].join("\n"),
    "utf8"
  );
  let releaseFirstFile!: () => void;
  const firstFilePaused = new Promise<void>((resolve) => {
    releaseFirstFile = resolve;
  });
  let firstFileWritten!: () => void;
  const reachedFirstFile = new Promise<void>((resolve) => {
    firstFileWritten = resolve;
  });
  const knowledge = createDevAiKnowledgeBaseService({
    knowledgeDir: root,
    approvedExamplesFile,
    cacheTtlMs: 0,
    retrievalMode: "lexical",
    publicationBarrier: barrier,
  });
  const compiler = createDevAiKnowledgeCompilerService({
    enabled: true,
    approvedExamplesFile,
    compiledKnowledgeDir,
    publicationBarrier: barrier,
    onCompiled: () => knowledge.invalidateCache(),
    async afterFileWritten(_fileName, index) {
      if (index !== 0) return;
      firstFileWritten();
      await firstFilePaused;
    },
  });

  const compiling = compiler.compile();
  await reachedFirstFile;
  let searchSettled = false;
  const searching = knowledge
    .search({ query: "new-formula-marker", maxItems: 4 })
    .then((value) => {
      searchSettled = true;
      return value;
    });
  await Promise.race([
    searching.then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]);
  assert.equal(
    searchSettled,
    false,
    "KNOWLEDGE_READER_MUST_WAIT_FOR_COMPILED_GENERATION"
  );

  releaseFirstFile();
  await compiling;
  const sources = await searching;
  assert.equal(searchSettled, true);
  assert.ok(sources.some((source) => source.excerpt.includes("new-formula-marker")));
  assert.ok(sources.every((source) => !source.excerpt.includes("old-formula-marker")));
  await knowledge.dispose?.();
});
