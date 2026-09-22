import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RAGIC_OFFICIAL_KNOWLEDGE_SEEDS } from "../src/services/dev/ai/ragicOfficialKnowledgeSeeds";

interface OfficialKnowledgeReviewTarget {
  sourceId: string;
  requiredTerms: string[];
}

interface OfficialKnowledgeReviewResult {
  sourceId: string;
  title: string;
  url: string;
  status: number | null;
  ok: boolean;
  seedHash: string;
  missingTerms: string[];
  error: string | null;
}

const REVIEW_TARGETS: OfficialKnowledgeReviewTarget[] = [
  {
    sourceId: "official:ragic-formulas",
    requiredTerms: ["公式", "欄位標頭", "ISBLANK", "公式重算"],
  },
  {
    sourceId: "official:ragic-workflow-es5",
    requiredTerms: ["Nashorn", "ECMAScript 5.1", "動作按鈕", "getNewValue"],
  },
];

function seedHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function reviewTarget(
  target: OfficialKnowledgeReviewTarget
): Promise<OfficialKnowledgeReviewResult> {
  const seed = RAGIC_OFFICIAL_KNOWLEDGE_SEEDS.find((item) => item.sourceId === target.sourceId);
  if (!seed) {
    return {
      sourceId: target.sourceId,
      title: target.sourceId,
      url: "",
      status: null,
      ok: false,
      seedHash: "",
      missingTerms: target.requiredTerms,
      error: "找不到對應 official knowledge seed",
    };
  }

  try {
    const response = await fetch(seed.path);
    const html = await response.text();
    const text = stripHtml(html);
    const missingTerms = target.requiredTerms.filter((term) => !text.includes(term));
    return {
      sourceId: seed.sourceId,
      title: seed.title,
      url: seed.path,
      status: response.status,
      ok: response.ok && missingTerms.length === 0,
      seedHash: seedHash(seed.content),
      missingTerms,
      error: null,
    };
  } catch (error) {
    return {
      sourceId: seed.sourceId,
      title: seed.title,
      url: seed.path,
      status: null,
      ok: false,
      seedHash: seedHash(seed.content),
      missingTerms: target.requiredTerms,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildOfficialKnowledgeReviewMarkdown(params: {
  generatedAt: Date;
  results: OfficialKnowledgeReviewResult[];
}): string {
  const lines = [
    "# Dev AI official Ragic knowledge review",
    "",
    `generatedAt: ${params.generatedAt.toISOString()}`,
    "",
    "這份 artifact 只用來人工審核 official seed 是否仍貼近 Ragic 官方文件；不會自動改 RAG seed、不會寫 definitions、不會 apply。",
    "",
    "| sourceId | status | seedHash | result | missingTerms | url |",
    "| --- | ---: | --- | --- | --- | --- |",
  ];

  for (const result of params.results) {
    lines.push(
      [
        result.sourceId,
        result.status === null ? "-" : String(result.status),
        result.seedHash || "-",
        result.ok ? "ok" : `needs-review${result.error ? `: ${result.error.replaceAll("|", "\\|")}` : ""}`,
        result.missingTerms.length ? result.missingTerms.join(", ") : "-",
        result.url,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
    );
  }

  lines.push(
    "",
    "人工處理規則：",
    "- 若 result 是 ok：現有 official seed 可先維持。",
    "- 若 result 是 needs-review：打開官方文件比對，手動更新 `ragicOfficialKnowledgeSeeds.ts`，再跑 knowledge/search 測試。",
    "- 不要把官方 HTML 或完整原文直接貼進 RAG；只整理成短規則、source URL 與可驗證限制。"
  );

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const generatedAt = new Date();
  const results = await Promise.all(REVIEW_TARGETS.map(reviewTarget));
  const outDir = path.resolve(process.cwd(), ".data/dev-ai/official-knowledge-review");
  await mkdir(outDir, { recursive: true });
  const timestamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `${timestamp}-ragic-official-knowledge-review.md`);
  await writeFile(outPath, buildOfficialKnowledgeReviewMarkdown({ generatedAt, results }), "utf8");
  console.log(`[dev-ai-official-knowledge] review=${outPath}`);

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[dev-ai-official-knowledge] failed", error);
    process.exitCode = 1;
  });
}
