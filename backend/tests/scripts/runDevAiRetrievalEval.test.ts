import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("public retrieval Eval 不會讀取執行環境的 curated knowledge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "public-retrieval-eval-test-"));
  const runtimeKnowledgeDir = path.join(root, "runtime-knowledge");
  const outputDir = path.join(root, "output");
  await mkdir(runtimeKnowledgeDir, { recursive: true });
  await writeFile(
    path.join(runtimeKnowledgeDir, "printer.md"),
    "# 合成測試資料\n公司印表機 IP 是 RFC 5737 測試位址 198.51.100.25。\n",
    "utf8"
  );

  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(
      npm,
      [
        "run",
        "eval:dev-ai-retrieval",
        "--",
        "--case",
        "PUB-006",
        "--output",
        outputDir,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DEV_AI_KNOWLEDGE_DIR: runtimeKnowledgeDir,
          DEV_AI_APPROVED_EXAMPLES_FILE: path.join(root, "runtime-approved.jsonl"),
          DEV_AI_VECTOR_DB_FILE: path.join(root, "runtime-vectors.sqlite3"),
        },
      }
    );
    assert.equal(
      result.status,
      0,
      `PUBLIC_EVAL_MUST_ISOLATE_RUNTIME_KNOWLEDGE\n${result.stdout}\n${result.stderr}`
    );
    const report = JSON.parse(
      await readFile(path.join(outputDir, "latest.json"), "utf8")
    ) as {
      totals: { cases: number; passed: number; failed: number };
      results: Array<{ sourceIds: string[] }>;
    };
    assert.deepEqual(report.totals, { cases: 1, passed: 1, failed: 0 });
    assert.deepEqual(report.results[0]?.sourceIds, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
