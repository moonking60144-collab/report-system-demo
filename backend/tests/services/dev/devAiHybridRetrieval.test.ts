import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDevAiKnowledgeBaseService } from "../../../src/services/dev/ai/devAiKnowledgeBaseService";
import { HttpError } from "../../../src/utils/httpError";
import type { DevAiEmbeddingProvider } from "../../../src/services/dev/ai/devAiEmbedding";

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function fixtureProvider(embed: DevAiEmbeddingProvider["embed"]): DevAiEmbeddingProvider {
  return {
    profile: "public-fixture-v1",
    dimensions: 2,
    embed,
  };
}

test("hybrid retrieval 以語意向量找到長文件尾段，並保留可回查的 evidence offset 與 hash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-hybrid-"));
  const marker = "VECTOR_TARGET_731";
  const content = `# Safety guide\n${"背景說明。".repeat(180)}\n${marker}：完成檢查後才可啟動設備。`;
  await writeFile(path.join(root, "safety.md"), content, "utf8");

  const query = "operator asks for the semantic procedure";
  const provider = fixtureProvider(async (texts) => texts.map((text) => {
    if (text === query || text.includes(marker)) return [1, 0];
    return [0, 1];
  }));
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: root,
    retrievalMode: "hybrid",
    vectorDbFile: ":memory:",
    embeddingProvider: provider,
    maxItems: 1,
  });

  try {
    const [source] = await service.search({ query, maxItems: 1 });
    assert.ok(source, "HYBRID_VECTOR_MUST_RETRIEVE_SEMANTIC_TAIL");
    assert.equal(source.path, "safety.md");
    assert.match(source.excerpt, new RegExp(marker));
    assert.equal(source.sourceVersion, sha256(content));
    assert.equal(source.retrieval?.mode, "hybrid");
    assert.ok(source.retrieval?.vectorRank);
    assert.ok(source.evidenceSpans?.length);
    for (const span of source.evidenceSpans ?? []) {
      const original = content.slice(span.sourceStart, span.sourceEnd);
      assert.equal(source.excerpt.slice(span.excerptStart, span.excerptEnd), original);
      assert.equal(span.contentHash, sha256(original));
    }
  } finally {
    await service.dispose?.();
  }
});

test("lexical retrieval 能以省略的 HTTP 預設 port 定位保留網段尾段，且完全不呼叫 embedding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-endpoint-"));
  const content = `${"一般說明。".repeat(150)}\n入口 http://192.0.2.10/ 僅供文件示例，操作前需取得授權。`;
  await writeFile(path.join(root, "network.md"), content, "utf8");
  let embeddingCalls = 0;
  const provider = fixtureProvider(async () => {
    embeddingCalls += 1;
    throw new Error("lexical mode must not call embedding");
  });
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: root,
    retrievalMode: "lexical",
    vectorDbFile: ":memory:",
    embeddingProvider: provider,
  });

  try {
    const [source] = await service.search({ query: "192.0.2.10:80" });
    assert.equal(source.path, "network.md");
    assert.match(source.excerpt, /操作前需取得授權/);
    assert.equal(embeddingCalls, 0);
  } finally {
    await service.dispose?.();
  }
});

test("索引建立期間 invalidateCache 會拒絕舊快照結果", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-generation-"));
  await writeFile(path.join(root, "guide.md"), "semantic target", "utf8");
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const active = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const provider = fixtureProvider(async (texts) => {
    calls += 1;
    if (calls === 1) {
      started();
      await gate;
    }
    return texts.map(() => [1, 0]);
  });
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: root,
    retrievalMode: "hybrid",
    vectorDbFile: ":memory:",
    embeddingProvider: provider,
  });

  try {
    const pending = service.search({ query: "semantic question" });
    await active;
    service.invalidateCache();
    release();
    await assert.rejects(
      pending,
      (error) => error instanceof HttpError && error.code === "DEV_AI_KNOWLEDGE_CHANGED"
    );
  } finally {
    release();
    await service.dispose?.();
  }
});

test("lexical runtime status 明確標示不需要模型或向量索引", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-runtime-lexical-"));
  await writeFile(path.join(root, "guide.md"), "公開操作指南", "utf8");
  let embeddingCalls = 0;
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: root,
    retrievalMode: "lexical",
    vectorDbFile: ":memory:",
    embeddingProvider: fixtureProvider(async () => {
      embeddingCalls += 1;
      return [[1, 0]];
    }),
  });
  try {
    const status = await service.getRuntimeStatus!();
    assert.equal(status.retrievalMode, "lexical");
    assert.equal(status.embedding.state, "not-required");
    assert.equal(status.index.state, "not-required");
    assert.equal(embeddingCalls, 0);
  } finally {
    await service.dispose?.();
  }
});

test("hybrid runtime status 只檢查現有 snapshot，不把模型標成即時已驗證", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-runtime-hybrid-"));
  await writeFile(path.join(root, "guide.md"), "semantic public guide", "utf8");
  const provider = fixtureProvider(async (texts) => texts.map(() => [1, 0]));
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: root,
    retrievalMode: "hybrid",
    vectorDbFile: ":memory:",
    embeddingProvider: provider,
  });
  try {
    const before = await service.getRuntimeStatus!();
    assert.equal(before.index.state, "missing");
    await service.prepareIndex!();
    const after = await service.getRuntimeStatus!();
    assert.equal(after.index.state, "ready");
    assert.equal(after.embedding.state, "not-checked");
    assert.equal(after.index.storedChunks, after.index.expectedChunks);
  } finally {
    await service.dispose?.();
  }
});
