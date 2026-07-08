import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDevAiKnowledgeBaseService } from "../../../src/services/dev/ai/devAiKnowledgeBaseService";

test("Dev AI knowledge search 會從本地 markdown/jsonl 找相關來源", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-"));
  await mkdir(path.join(root, "funda"), { recursive: true });
  await writeFile(
    path.join(root, "funda", "company.md"),
    "# Funda 內部口徑\nFunda 公司問題只能依據內部文件回答，不可編造。",
    "utf8"
  );
  await writeFile(
    path.join(root, "rules.jsonl"),
    JSON.stringify({
      title: "公式空值規則",
      content: "Ragic 公式遇到空值時要明確處理。",
    }),
    "utf8"
  );

  const service = createDevAiKnowledgeBaseService({ knowledgeDir: root, maxItems: 4 });
  const result = await service.search({ query: "Funda 公司 怎麼回答" });

  assert.equal(result.length >= 1, true);
  assert.equal(result[0].kind, "curated");
  assert.equal(result[0].path, "funda/company.md");
  assert.match(result[0].excerpt, /不可編造/);
});

test("Dev AI knowledge search 缺資料夾時回空陣列", async () => {
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: path.join(tmpdir(), "dev-ai-knowledge-missing"),
  });
  const result = await service.search({ query: "Funda" });
  assert.deepEqual(result, []);
});

test("Dev AI knowledge search 會在 TTL 內重用檔案快取", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-cache-"));
  const file = path.join(root, "company.md");
  await writeFile(file, "# Funda\nalpha knowledge", "utf8");
  let current = 1_000;
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: root,
    cacheTtlMs: 5_000,
    now: () => current,
  });

  const first = await service.search({ query: "alpha" });
  assert.equal(first.length, 1);

  await writeFile(file, "# Funda\nbeta knowledge", "utf8");
  const cached = await service.search({ query: "alpha" });
  assert.equal(cached.length, 1);

  current += 6_000;
  const refreshed = await service.search({ query: "beta" });
  assert.equal(refreshed.length, 1);
  assert.match(refreshed[0].excerpt, /beta/);
});

test("Dev AI knowledge search invalidateCache 後會立刻重讀檔案", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-invalidate-"));
  const file = path.join(root, "company.md");
  await writeFile(file, "# Funda\nalpha knowledge", "utf8");
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: root,
    cacheTtlMs: 60_000,
  });

  assert.equal((await service.search({ query: "alpha" })).length, 1);
  await writeFile(file, "# Funda\nbeta knowledge", "utf8");
  assert.equal((await service.search({ query: "beta" })).length, 0);

  service.invalidateCache();
  const refreshed = await service.search({ query: "beta" });
  assert.equal(refreshed.length, 1);
  assert.match(refreshed[0].excerpt, /beta/);
});

test("Dev AI knowledge search 不直接吃 approved examples ledger，只讀 compiled knowledge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-compiled-only-"));
  const ledger = path.join(root, "approved-examples.jsonl");
  await writeFile(
    ledger,
    JSON.stringify({
      title: "Raw approved answer",
      content: "uncompiled-source-marker should not be indexed",
      metadata: { kind: "chat-answer" },
    }),
    "utf8"
  );
  await mkdir(path.join(root, "compiled"), { recursive: true });
  await writeFile(
    path.join(root, "compiled", "approved-chat-answers.md"),
    "# Clean knowledge\ncompiled clean answer should be indexed",
    "utf8"
  );

  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: root,
    approvedExamplesFile: ledger,
  });

  assert.equal((await service.search({ query: "uncompiled-source-marker" })).length, 0);
  const result = await service.search({ query: "compiled clean answer" });
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "compiled/approved-chat-answers.md");
});

test("Dev AI knowledge search 內建 Ragic 官方公式 seed", async () => {
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: path.join(tmpdir(), "dev-ai-knowledge-official-formulas-missing"),
    maxItems: 4,
  });

  const result = await service.search({ query: "Ragic 公式 ISBLANK 欄位標頭 公式重算" });

  assert.equal(result.length >= 1, true);
  assert.equal(result[0].kind, "official");
  assert.equal(result[0].sourceId, "official:ragic-formulas");
  assert.match(result[0].excerpt, /欄位標頭/);
});

test("Dev AI knowledge search 內建 Ragic 官方 workflow ES5 seed", async () => {
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: path.join(tmpdir(), "dev-ai-knowledge-official-workflow-missing"),
    maxItems: 4,
  });

  const result = await service.search({
    query: "Ragic workflow Nashorn ECMAScript 5.1 setIfExecuteWorkflow getNewValue",
  });

  assert.equal(result.length >= 1, true);
  assert.equal(result[0].kind, "official");
  assert.equal(result[0].sourceId, "official:ragic-workflow-es5");
  assert.match(result[0].excerpt, /Nashorn/);
});

test("Dev AI knowledge search 一般 Funda 問答不會誤撈官方 Ragic seed", async () => {
  const service = createDevAiKnowledgeBaseService({
    knowledgeDir: path.join(tmpdir(), "dev-ai-knowledge-no-official-pollution"),
    maxItems: 4,
  });

  const result = await service.search({ query: "公司請假制度要怎麼回答使用者" });

  assert.equal(result.some((source) => source.kind === "official"), false);
});

test("Dev AI knowledge search 會跳過讀取失敗的單一檔案並保留其他來源", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-ai-knowledge-skip-bad-file-"));
  await writeFile(path.join(root, "good.md"), "# Funda good\nusable knowledge marker", "utf8");
  const badFile = path.join(root, "bad.md");
  await writeFile(badFile, "# bad\nthis file cannot be read", "utf8");
  await chmod(badFile, 0o000);

  const service = createDevAiKnowledgeBaseService({ knowledgeDir: root, maxItems: 4 });
  const result = await service.search({ query: "usable knowledge marker" });
  await chmod(badFile, 0o600);

  assert.equal(result.length, 1);
  assert.equal(result[0].path, "good.md");
  assert.match(result[0].excerpt, /usable knowledge marker/);
});
