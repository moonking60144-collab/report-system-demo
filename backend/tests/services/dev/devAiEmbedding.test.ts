import test from "node:test";
import assert from "node:assert/strict";
import { createDevAiEmbeddingProvider, verifyDevAiEmbeddingProvider, type DevAiEmbeddingProvider } from "../../../src/services/dev/ai/devAiEmbedding";

test("模型就緒檢查即使索引不需重建也會實際執行一次 embedding", async () => {
  const calls: string[][] = [];
  const provider: DevAiEmbeddingProvider = { profile: "fixture", dimensions: 2, async embed(texts) {
    calls.push(texts);
    return [[0.5, 0.5]];
  } };
  await verifyDevAiEmbeddingProvider(provider);
  assert.equal(calls.length, 1, "READY_CHECK_MUST_NOT_DEPEND_ON_MISSING_INDEX_VECTORS");
  assert.equal(calls[0].length, 1);
  await assert.rejects(verifyDevAiEmbeddingProvider({ ...provider, async embed() { return [[0, 0]]; } }), /就緒檢查失敗/);
});

test("本機 embedding 逾時可回收 child，排隊請求不永久卡住且 API process 繼續", async () => {
  const provider = createDevAiEmbeddingProvider({ allowDownload: false, timeoutMs: 1 });
  try {
    const one = provider.embed(["timeout first"]);
    const two = provider.embed(["timeout queued"]);
    const results = await Promise.allSettled([one, two]);
    assert.ok(results.every((result) => result.status === "rejected"), "CHILD_TIMEOUTS_SETTLE_ALL_REQUESTS");
    await assert.rejects(provider.embed(["restart after timeout"]), /本機知識模型/);
    assert.equal(process.exitCode, undefined, "CHILD_TERMINATION_DOES_NOT_TERMINATE_API_PROCESS");
  } finally { await provider.dispose!(); }
});

test("embedding active 與 queued 取消都立即 settle，dispose 不留 pending job", async () => {
  const provider = createDevAiEmbeddingProvider({ allowDownload: false, timeoutMs: 10000 });
  const one = new AbortController();
  const two = new AbortController();
  const active = provider.embed(["active"], one.signal);
  const queued = provider.embed(["queued"], two.signal);
  const firstRejected = assert.rejects(active, { name: "AbortError" });
  const secondRejected = assert.rejects(queued, { name: "AbortError" });
  two.abort(); one.abort();
  await Promise.all([firstRejected, secondRejected]);
  await provider.dispose!();
  await assert.rejects(provider.embed(["closed"]), /本機知識模型/);
});
