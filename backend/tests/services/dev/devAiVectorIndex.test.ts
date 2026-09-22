import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { createDevAiVectorIndex, type DevAiIndexDocument } from "../../../src/services/dev/ai/devAiVectorIndex";
import type { DevAiEmbeddingProvider } from "../../../src/services/dev/ai/devAiEmbedding";

const doc = (id: string, content: string): DevAiIndexDocument => ({ sourceId: id, title: id, content, path: id, kind: "curated" });
function provider(profile = "fixture-v1", dimensions = 2) {
  const calls: string[][] = [];
  const embedding: DevAiEmbeddingProvider = { profile, dimensions, async embed(texts) {
    calls.push(texts);
    return texts.map((text) => text.includes("north") ? [1, 0] : text.includes("east") ? [0, 1] : [1, 1]);
  } };
  return { embedding, calls };
}

test("向量 cosine 以獨立二維幾何 oracle 排序，eligible 排除高分其他資產", async () => {
  const { embedding } = provider();
  const index = createDevAiVectorIndex({ dbFile: ":memory:", embeddingProvider: embedding });
  try {
    const documents = [doc("north", "north"), doc("east", "east"), doc("diagonal", "diagonal")];
    const hits = await index.search(documents, "north", new Set(["east", "diagonal"]));
    assert.deepEqual(hits.map((hit) => hit.sourceId), ["diagonal", "east"]);
    assert.ok(Math.abs(hits[0].similarity - Math.SQRT1_2) < 1e-6, "INDEPENDENT_COSINE_ORACLE");
    assert.equal(hits[1].similarity, 0);
  } finally { await index.dispose(); }
});

test("SQLite restart 重用相同向量，文字修改重建、刪除退場、model profile 隔離", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-vectors-"));
  const dbFile = path.join(root, "vectors.sqlite3");
  const first = provider();
  let index = createDevAiVectorIndex({ dbFile, embeddingProvider: first.embedding });
  await index.prepare([doc("a", "north"), doc("b", "east")]);
  await index.dispose();
  const second = provider();
  index = createDevAiVectorIndex({ dbFile, embeddingProvider: second.embedding });
  try {
    await index.prepare([doc("a", "north"), doc("b", "east")]);
    assert.equal(second.calls.length, 0, "RESTART_REUSES_STORED_EMBEDDINGS");
    await index.prepare([doc("a", "east changed")]);
    assert.equal(second.calls.length, 1);
    assert.equal(second.calls[0].length, 1);
    const db = await open({ filename: dbFile, driver: sqlite3.Database });
    assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) n FROM knowledge_vectors"))!.n, 1);
    await db.close();
  } finally { await index.dispose(); }
  const third = provider("fixture-v2");
  index = createDevAiVectorIndex({ dbFile, embeddingProvider: third.embedding });
  try { await index.prepare([doc("a", "east changed")]); assert.equal(third.calls.length, 1, "MODEL_PROFILE_REBUILDS"); }
  finally { await index.dispose(); }
});

test("向量損壞可重建，失敗的新快照不能覆寫上一次完整 SQLite 快照", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-vector-repair-"));
  const dbFile = path.join(root, "vectors.sqlite3");
  const initial = provider();
  let index = createDevAiVectorIndex({ dbFile, embeddingProvider: initial.embedding });
  await index.prepare([doc("a", "north")]);
  await index.dispose();
  const db = await open({ filename: dbFile, driver: sqlite3.Database });
  await db.run("UPDATE knowledge_vectors SET vector = ?", Buffer.from([0]));
  const repaired = provider();
  index = createDevAiVectorIndex({ dbFile, embeddingProvider: repaired.embedding });
  await index.prepare([doc("a", "north")]);
  assert.equal(repaired.calls.length, 1, "CORRUPTED_CACHE_REBUILT");
  const before = await db.all("SELECT * FROM vector_snapshots");
  repaired.embedding.embed = async () => [[NaN, 1]];
  await assert.rejects(index.prepare([doc("a", "changed")]), /向量格式/);
  assert.deepEqual(await db.all("SELECT * FROM vector_snapshots"), before, "FAILED_BUILD_RETAINS_PREVIOUS_SNAPSHOT");
  assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) n FROM knowledge_vectors"))!.n, 1);
  await index.dispose(); await db.close();
});

test("共享 prepare 中的 observer 取消立即結束，不中止其他搜尋的索引建置", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const baseline = provider();
  let calls = 0;
  const index = createDevAiVectorIndex({ dbFile: ":memory:", embeddingProvider: { ...baseline.embedding, async embed(texts) {
    if (++calls === 1) await gate;
    return baseline.embedding.embed(texts);
  } } });
  const abort = new AbortController();
  const pending = index.search([doc("a", "north")], "north", new Set(["a"]), abort.signal);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  abort.abort();
  await rejection;
  release();
  const surviving = await index.search([doc("a", "north")], "north", new Set(["a"]));
  assert.equal(surviving[0].similarity, 1, "SHARED_BUILD_SURVIVES_OBSERVER_CANCEL");
  await index.dispose();
});

test("source chunk offset 確實包含原文尾段，不把 title 加入 source span", async () => {
  const { embedding } = provider();
  const content = "背景".repeat(500) + "north TAIL_731";
  const index = createDevAiVectorIndex({ dbFile: ":memory:", embeddingProvider: embedding });
  try {
    const hits = await index.search([doc("a", content)], "north", new Set(["a"]));
    assert.match(content.slice(hits[0].start, hits[0].end), /TAIL_731/, "VECTOR_HIT_POINTS_TO_RAW_TAIL");
    assert.ok(hits[0].end <= content.length);
  } finally { await index.dispose(); }
});

test("索引狀態以唯讀 SQLite snapshot 判斷 ready 與 stale，不呼叫 embedding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-vector-status-"));
  const dbFile = path.join(root, "vectors.sqlite3");
  const initial = provider();
  let index = createDevAiVectorIndex({ dbFile, embeddingProvider: initial.embedding });
  await index.prepare([doc("guide", "north procedure")]);
  await index.dispose();

  const observer = provider();
  index = createDevAiVectorIndex({ dbFile, embeddingProvider: observer.embedding });
  try {
    const ready = await index.inspect([doc("guide", "north procedure")]);
    assert.equal(ready.state, "ready");
    assert.equal(ready.storedChunks, ready.expectedChunks);
    assert.equal(observer.calls.length, 0, "STATUS_MUST_NOT_START_EMBEDDING");

    const stale = await index.inspect([doc("guide", "east procedure changed")]);
    assert.equal(stale.state, "stale");
    assert.notEqual(stale.storedFingerprint, stale.expectedFingerprint);
    assert.equal(observer.calls.length, 0, "STALE_CHECK_MUST_REMAIN_READ_ONLY");
  } finally {
    await index.dispose();
  }
});

test("索引檔不存在時回 missing，狀態查詢不建立 SQLite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-vector-missing-"));
  const dbFile = path.join(root, "missing.sqlite3");
  const fixture = provider();
  const index = createDevAiVectorIndex({ dbFile, embeddingProvider: fixture.embedding });
  try {
    const status = await index.inspect([doc("guide", "north procedure")]);
    assert.equal(status.state, "missing");
    assert.equal(fixture.calls.length, 0);
    await assert.rejects(stat(dbFile), { code: "ENOENT" });
  } finally {
    await index.dispose();
  }
});
