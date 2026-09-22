import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDevAiKnowledgeBaseService } from "../src/services/dev/ai/devAiKnowledgeBaseService";

type RetrievalMode = "lexical" | "hybrid" | "vector";

interface EvalCase {
  schemaVersion: "dev-ai-retrieval-eval-case.v1";
  id: string;
  question: string;
  maxSources: number;
  expectedSourceIds: string[];
  expectedTopSourceId: string | null;
  requiredEvidencePatterns: string[];
  forbiddenEvidencePatterns: string[];
}

interface CliOptions {
  casesPath: string;
  outputDir: string;
  mode: RetrievalMode;
  caseIds: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let casesPath = path.resolve(process.cwd(), "../docs/dev-ai-evals/public/cases.jsonl");
  let outputDir = path.resolve(process.cwd(), ".data/dev-ai/evals/public");
  let mode: RetrievalMode = "lexical";
  const caseIds: string[] = [];
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--cases") {
      casesPath = path.resolve(process.cwd(), requireString(argv[++index], arg));
    } else if (arg === "--output") {
      outputDir = path.resolve(process.cwd(), requireString(argv[++index], arg));
    } else if (arg === "--mode") {
      const value = argv[++index];
      if (value !== "lexical" && value !== "hybrid" && value !== "vector") {
        throw new Error("--mode 必須是 lexical、hybrid 或 vector");
      }
      mode = value;
    } else if (arg === "--case") {
      caseIds.push(requireString(argv[++index], arg));
    } else {
      throw new Error(`不支援的參數：${arg}`);
    }
  }
  return { casesPath, outputDir, mode, caseIds, dryRun };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 缺少值`);
  return value.trim();
}

function stringArray(value: unknown, field: string, line: number): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`第 ${line} 行 ${field} 必須是字串陣列`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseCase(value: unknown, line: number): EvalCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`第 ${line} 行不是 JSON object`);
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== "dev-ai-retrieval-eval-case.v1") {
    throw new Error(`第 ${line} 行 schemaVersion 不支援`);
  }
  const maxSources = Number(input.maxSources ?? 3);
  if (!Number.isSafeInteger(maxSources) || maxSources < 1 || maxSources > 20) {
    throw new Error(`第 ${line} 行 maxSources 必須介於 1 到 20`);
  }
  const expectedSourceIds = stringArray(input.expectedSourceIds, "expectedSourceIds", line);
  const expectedTopSourceId =
    input.expectedTopSourceId === null || input.expectedTopSourceId === undefined
      ? null
      : requireString(input.expectedTopSourceId, `第 ${line} 行 expectedTopSourceId`);
  if (expectedSourceIds.length && !expectedTopSourceId) {
    throw new Error(`第 ${line} 行有預期來源時必須指定 expectedTopSourceId`);
  }
  if (expectedTopSourceId && !expectedSourceIds.includes(expectedTopSourceId)) {
    throw new Error(`第 ${line} 行 expectedTopSourceId 必須包含於 expectedSourceIds`);
  }
  return {
    schemaVersion: "dev-ai-retrieval-eval-case.v1",
    id: requireString(input.id, `第 ${line} 行 id`),
    question: requireString(input.question, `第 ${line} 行 question`),
    maxSources,
    expectedSourceIds,
    expectedTopSourceId,
    requiredEvidencePatterns: stringArray(
      input.requiredEvidencePatterns,
      "requiredEvidencePatterns",
      line
    ),
    forbiddenEvidencePatterns: stringArray(
      input.forbiddenEvidencePatterns,
      "forbiddenEvidencePatterns",
      line
    ),
  };
}

async function readCases(filePath: string): Promise<EvalCase[]> {
  const rows = (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter((row) => row.text)
    .map((row) => parseCase(JSON.parse(row.text) as unknown, row.line));
  if (!rows.length) throw new Error("Eval cases 為空");
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("Eval case id 重複");
  }
  return rows;
}

function matches(pattern: string, value: string): boolean {
  return new RegExp(pattern, "iu").test(value);
}

const sha256 = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const allCases = await readCases(options.casesPath);
  const cases = options.caseIds.length
    ? allCases.filter((item) => options.caseIds.includes(item.id))
    : allCases;
  const missing = options.caseIds.filter((id) => !cases.some((item) => item.id === id));
  if (missing.length) throw new Error(`找不到 Eval case：${missing.join(", ")}`);
  if (options.dryRun) {
    console.log(JSON.stringify({ status: "valid", mode: options.mode, cases: cases.map((item) => item.id) }));
    return;
  }

  const isolatedRoot = await mkdtemp(path.join(tmpdir(), "public-dev-ai-retrieval-eval-"));
  const isolatedKnowledgeDir = path.join(isolatedRoot, "knowledge");
  await mkdir(isolatedKnowledgeDir, { recursive: true });
  const service = createDevAiKnowledgeBaseService({
    retrievalMode: options.mode,
    knowledgeDir: isolatedKnowledgeDir,
    approvedExamplesFile: path.join(isolatedRoot, "approved-examples.jsonl"),
    vectorDbFile: path.join(isolatedRoot, "vectors.sqlite3"),
  });
  const startedAt = new Date();
  const results = [];
  try {
    for (const item of cases) {
      const sources = await service.search({ query: item.question, maxItems: item.maxSources });
      const sourceIds = sources.map((source) => source.sourceId);
      const expectedText = sources
        .filter((source) => item.expectedSourceIds.includes(source.sourceId))
        .map((source) => source.excerpt)
        .join("\n");
      const failures: string[] = [];
      for (const sourceId of item.expectedSourceIds) {
        if (!sourceIds.includes(sourceId)) failures.push(`missing-source:${sourceId}`);
      }
      if (item.expectedTopSourceId && sourceIds[0] !== item.expectedTopSourceId) {
        failures.push(
          `wrong-top-source:expected-${item.expectedTopSourceId}:received-${sourceIds[0] ?? "none"}`
        );
      }
      if (!item.expectedSourceIds.length && sources.length) {
        failures.push(`expected-no-answer:received-${sources.length}`);
      }
      for (const pattern of item.requiredEvidencePatterns) {
        if (!matches(pattern, expectedText)) failures.push(`missing-evidence:${pattern}`);
      }
      for (const pattern of item.forbiddenEvidencePatterns) {
        if (matches(pattern, sources.map((source) => source.excerpt).join("\n"))) {
          failures.push(`forbidden-evidence:${pattern}`);
        }
      }
      for (const source of sources) {
        for (const span of source.evidenceSpans ?? []) {
          const excerpt = source.excerpt.slice(span.excerptStart, span.excerptEnd);
          if (sha256(excerpt) !== span.contentHash) {
            failures.push(`evidence-hash:${source.sourceId}:${span.spanId}`);
          }
        }
      }
      results.push({
        id: item.id,
        passed: failures.length === 0,
        failures,
        sourceIds,
        sources: sources.map((source) => ({
          sourceId: source.sourceId,
          sourceVersion: source.sourceVersion ?? null,
          evidenceSpans: source.evidenceSpans ?? [],
          retrieval: source.retrieval ?? null,
        })),
      });
    }
  } finally {
    await service.dispose?.();
    await rm(isolatedRoot, { recursive: true, force: true });
  }

  const finishedAt = new Date();
  const report = {
    schemaVersion: "dev-ai-retrieval-eval-run.v1",
    mode: options.mode,
    casesPath: options.casesPath,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totals: {
      cases: results.length,
      passed: results.filter((item) => item.passed).length,
      failed: results.filter((item) => !item.passed).length,
    },
    results,
  };
  await mkdir(options.outputDir, { recursive: true });
  const outputPath = path.join(options.outputDir, "latest.json");
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, ...report.totals }));
  if (report.totals.failed) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
