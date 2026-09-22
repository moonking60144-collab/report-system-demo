import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isDevAiKnowledgePreparationReady,
  writeDevAiKnowledgePreparationMarker,
} from "../../../src/services/dev/ai/devAiKnowledgePreparation";
import type { DevAiKnowledgeRuntimeStatus } from "@shared-types/ragicDefinitions";

function readyRuntime(): DevAiKnowledgeRuntimeStatus {
  return {
    retrievalMode: "hybrid",
    documents: 3,
    embedding: {
      required: true,
      state: "not-checked",
      profile: "fixture-profile",
      dimensions: 384,
    },
    index: {
      required: true,
      state: "ready",
      profile: "fixture-profile",
      dimensions: 384,
      expectedFingerprint: "sha256:fixture",
      storedFingerprint: "sha256:fixture",
      expectedChunks: 11,
      storedChunks: 11,
      updatedAt: "2026-09-22T00:00:00.000Z",
      errorCode: null,
    },
  };
}

test("knowledge preparation marker 同時綁定 model cache 與 vector snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-ready-"));
  const cacheDir = path.join(root, "models");
  const vectorDbFile = path.join(root, "vectors.sqlite3");
  const modelFile = path.join(cacheDir, "model", "weights.bin");
  await mkdir(path.dirname(modelFile), { recursive: true });
  await writeFile(modelFile, "prepared-model", "utf8");
  const runtime = readyRuntime();
  try {
    await writeDevAiKnowledgePreparationMarker(
      {
        profile: runtime.index.profile!,
        dimensions: runtime.index.dimensions!,
        fingerprint: runtime.index.expectedFingerprint!,
      },
      { cacheDir, vectorDbFile }
    );
    assert.equal(
      await isDevAiKnowledgePreparationReady(runtime, { cacheDir, vectorDbFile }),
      true
    );

    await writeFile(modelFile, "truncated", "utf8");
    assert.equal(
      await isDevAiKnowledgePreparationReady(runtime, { cacheDir, vectorDbFile }),
      false,
      "KNOWLEDGE_READINESS_MUST_REJECT_CHANGED_MODEL_CACHE"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
