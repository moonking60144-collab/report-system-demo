import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "../../../src/utils/httpError";
import { createDevAiFeedbackService } from "../../../src/services/dev/ai/devAiFeedbackService";

test("Dev AI feedback 會把 approved chat answer 寫成 knowledge JSONL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-feedback-"));
  const filePath = path.join(root, "approved-examples.jsonl");
  let invalidated = false;
  const service = createDevAiFeedbackService({
    enabled: true,
    filePath,
    feedbackIdFactory: () => "feedback-1",
    now: () => new Date("2026-07-03T00:00:00.000Z"),
    onStored: () => {
      invalidated = true;
    },
  });

  const result = await service.store(
    {
      kind: "chat-answer",
      question: "Funda 是什麼？",
      answer: "只能依內部文件回答。",
      sourceIds: ["curated:funda"],
    },
    { actor: "dev-user", clientId: "client-a", tabId: "tab-a" }
  );

  assert.equal(result.feedbackId, "feedback-1");
  const lines = (await readFile(filePath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as {
    title: string;
    content: string;
    metadata: Record<string, unknown>;
  };
  assert.match(entry.title, /Approved chat answer/);
  assert.match(entry.content, /Funda 是什麼/);
  assert.match(entry.content, /只能依內部文件回答/);
  assert.equal(entry.metadata.actor, "dev-user");
  assert.equal(entry.metadata.kind, "chat-answer");
  assert.equal(invalidated, true);
});

test("Dev AI feedback 會把 approved formula 寫成可檢索範例", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-feedback-formula-"));
  const filePath = path.join(root, "approved-examples.jsonl");
  const service = createDevAiFeedbackService({
    enabled: true,
    filePath,
    feedbackIdFactory: () => "feedback-formula",
  });

  const result = await service.store({
    kind: "formula-suggestion",
    formPath: "default/devtest/51",
    fieldId: "1036641",
    formulaKind: "formula",
    objective: "空值回 0",
    proposedFormula: "IF(ISBLANK(A1),0,A1)",
    explanation: "避免空值。",
  });

  const content = await readFile(filePath, "utf8");
  assert.match(content, /approved formula example/);
  assert.match(content, /IF\(ISBLANK\(A1\),0,A1\)/);
  assert.equal(result.compiled?.status.approvedExamples.formulaSuggestions, 1);
  assert.equal(result.compiled?.status.compiled.needsCompile, false);
  const compiled = await readFile(
    path.join(root, "compiled", "approved-formula-examples.md"),
    "utf8"
  );
  assert.match(compiled, /Dev AI Approved Formula Examples/);
  assert.match(compiled, /IF\(ISBLANK\(A1\),0,A1\)/);
});

test("Dev AI feedback disabled 時拒絕寫入", async () => {
  const service = createDevAiFeedbackService({ enabled: false });
  await assert.rejects(
    () => service.store({ kind: "chat-answer", question: "hi", answer: "ok" }),
    (error) => error instanceof HttpError && error.code === "DEV_AI_DISABLED"
  );
});
