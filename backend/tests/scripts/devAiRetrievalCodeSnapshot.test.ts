import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotDevAiEmbeddingArtifacts, snapshotDevAiRetrievalCode } from "../../scripts/dev-ai-retrieval-code-snapshot";

test("檢索程式 hash 涵蓋執行依賴及 hybrid worker，且不受 checkout 絕對路徑影響", async () => {
  const backendRoot = process.cwd();
  const original = await snapshotDevAiRetrievalCode(backendRoot, "hybrid");
  for (const file of [
    "backend/src/services/dev/ai/devAiEmbedding.ts",
    "backend/src/services/dev/ai/devAiThreadRepository.ts",
    "backend/src/services/dev/ragicFormulaPatchDryRunService.ts",
    "backend/src/services/dev/ai/devAiEmbeddingWorker.ts",
    "backend/package-lock.json",
    "backend/scripts/dev-ai-retrieval-code-snapshot.ts",
  ]) assert.ok(original.codeFiles.includes(file), `MISSING_DEPENDENCY:${file}`);

  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-retrieval-snapshot-"));
  const copiedBackend = path.join(root, "backend");
  try {
    for (const relative of original.codeFiles) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.resolve(backendRoot, "..", relative), target);
    }
    const base = await snapshotDevAiRetrievalCode(copiedBackend, "hybrid");
    assert.equal(base.codeSha256, original.codeSha256, "ABSOLUTE_PATH_MUST_NOT_CHANGE_HASH");
    for (const relative of [
      "backend/src/services/dev/ai/devAiEmbedding.ts",
      "backend/src/services/dev/ai/devAiThreadRepository.ts",
      "backend/src/services/dev/ragicFormulaPatchDryRunService.ts",
    ]) {
      const target = path.join(root, relative);
      await appendFile(target, "\n// hash sensitivity probe\n");
      assert.notEqual((await snapshotDevAiRetrievalCode(copiedBackend, "hybrid")).codeSha256,
        base.codeSha256, `DEPENDENCY_CHANGE_MUST_CHANGE_HASH:${relative}`);
      await copyFile(path.resolve(backendRoot, "..", relative), target);
    }
    const lexical = await snapshotDevAiRetrievalCode(copiedBackend, "lexical");
    await appendFile(path.join(root, "backend/src/services/dev/ai/devAiEmbeddingWorker.ts"), "\n// worker probe\n");
    assert.equal((await snapshotDevAiRetrievalCode(copiedBackend, "lexical")).codeSha256,
      lexical.codeSha256, "LEXICAL_DOES_NOT_LOAD_WORKER");
    assert.notEqual((await snapshotDevAiRetrievalCode(copiedBackend, "hybrid")).codeSha256,
      base.codeSha256, "HYBRID_WORKER_CHANGE_MUST_CHANGE_HASH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("embedding 模型產物內容變動會改變 artifact hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-embedding-snapshot-"));
  const model = "fixture/model";
  const revision = "revision-1";
  const modelDir = path.join(root, model, revision);
  try {
    await mkdir(path.join(modelDir, "onnx"), { recursive: true });
    for (const name of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]) {
      await writeFile(path.join(modelDir, name), `fixture:${name}`);
    }
    const first = await snapshotDevAiEmbeddingArtifacts(root, model, revision);
    await writeFile(path.join(modelDir, "tokenizer.json"), "changed tokenizer");
    const second = await snapshotDevAiEmbeddingArtifacts(root, model, revision);
    assert.notEqual(second.artifactSha256, first.artifactSha256, "MODEL_BYTES_CHANGE_MUST_CHANGE_HASH");
    assert.deepEqual(first.files.map((file) => file.path),
      ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
