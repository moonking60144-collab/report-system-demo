import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDevAiChatService } from "../src/services/dev/ai/devAiChatService";
import { createDevAiKnowledgeBaseService } from "../src/services/dev/ai/devAiKnowledgeBaseService";
import { createDevAiThreadRepository } from "../src/services/dev/ai/devAiThreadRepository";
import { createDevAiThreadService } from "../src/services/dev/ai/devAiThreadService";
import { DEV_AI_EMBEDDING_MODEL, DEV_AI_EMBEDDING_REVISION } from "../src/services/dev/ai/devAiEmbedding";
import { env } from "../src/config/env";
import { snapshotDevAiEmbeddingArtifacts, snapshotDevAiRetrievalCode } from "./dev-ai-retrieval-code-snapshot";
import type { DevAiKnowledgeSource } from "@shared-types/ragicDefinitions";

interface EvalTurn {
  message: string;
  expectedSourceIds: string[];
  requiredEvidence: Array<{ sourceId: string; text: string }>;
}

interface EvalEpisode {
  schemaVersion: "dev-ai-retrieval-episode.v1";
  id: string;
  turns: EvalTurn[];
}

function parseArgs(argv: string[]) {
  const options = {
    cases: path.resolve("../docs/dev-ai-evals/r1/retrieval-episodes.jsonl"),
    knowledgeDir: path.resolve("../docs/dev-ai-evals/r1/fixtures"),
    output: "",
    mode: "lexical" as "lexical" | "hybrid",
    lexicalProfile: "phrase" as "legacy" | "phrase",
    speedMode: "fast" as "fast" | "balanced" | "deep",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--mode") {
      const value = argv[++index];
      if (value !== "lexical" && value !== "hybrid") throw new Error("--mode 必須是 lexical 或 hybrid");
      options.mode = value;
      continue;
    }
    if (arg === "--lexical-profile") {
      const value = argv[++index];
      if (value !== "legacy" && value !== "phrase") throw new Error("--lexical-profile 必須是 legacy 或 phrase");
      options.lexicalProfile = value;
      continue;
    }
    if (arg === "--speed-mode") {
      const value = argv[++index];
      if (value !== "fast" && value !== "balanced" && value !== "deep") {
        throw new Error("--speed-mode 必須是 fast、balanced 或 deep");
      }
      options.speedMode = value;
      continue;
    }
    if (arg === "--cases" || arg === "--knowledge-dir" || arg === "--output") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} 缺少路徑`);
      if (arg === "--cases") options.cases = path.resolve(value);
      else if (arg === "--knowledge-dir") options.knowledgeDir = path.resolve(value);
      else options.output = path.resolve(value);
      continue;
    }
    throw new Error(`不支援的參數：${arg}`);
  }
  return options;
}

async function readEpisodes(filePath: string): Promise<EvalEpisode[]> {
  const lines = (await readFile(filePath, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const episodes = lines.map((line, index) => {
    const value = JSON.parse(line) as Partial<EvalEpisode>;
    if (value.schemaVersion !== "dev-ai-retrieval-episode.v1" || typeof value.id !== "string" || !value.id
      || !Array.isArray(value.turns) || !value.turns.length || value.turns.some((turn) =>
        typeof turn.message !== "string" || !turn.message.trim()
        || !Array.isArray(turn.expectedSourceIds) || turn.expectedSourceIds.some((id) => typeof id !== "string")
        || !Array.isArray(turn.requiredEvidence) || turn.requiredEvidence.some((item) =>
          !item || typeof item.sourceId !== "string" || typeof item.text !== "string" || !item.text))) {
      throw new Error(`第 ${index + 1} 筆 retrieval episode 格式錯誤`);
    }
    return value as EvalEpisode;
  });
  if (!episodes.length || new Set(episodes.map((episode) => episode.id)).size !== episodes.length) {
    throw new Error("retrieval episodes 不可為空或使用重複 ID");
  }
  return episodes;
}

function sourceRecord(source: DevAiKnowledgeSource) {
  return { sourceId: source.sourceId, sourceVersion: source.sourceVersion ?? null,
    score: source.score, retrieval: source.retrieval ?? null };
}

async function knowledgeSnapshotSha256(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && [".md", ".txt", ".json", ".jsonl"].includes(path.extname(file).toLowerCase())) files.push(file);
    }
  };
  await visit(root);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    digest.update(path.relative(root, file).replace(/\\/g, "/"));
    digest.update(await readFile(file));
  }
  return digest.digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const episodes = await readEpisodes(options.cases);
  if (options.dryRun) {
    console.log(JSON.stringify({ episodes: episodes.length, turns: episodes.reduce((sum, episode) => sum + episode.turns.length, 0) }));
    return;
  }
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const casesSha256 = sha256(await readFile(options.cases, "utf8"));
  const { codeSha256, codeFiles } = await snapshotDevAiRetrievalCode(path.resolve(__dirname, ".."), options.mode);
  const knowledgeSha256 = await knowledgeSnapshotSha256(options.knowledgeDir);
  const knowledge = createDevAiKnowledgeBaseService({ knowledgeDir: options.knowledgeDir,
    retrievalMode: options.mode, lexicalProfile: options.lexicalProfile, vectorDbFile: ":memory:" });
  const repository = createDevAiThreadRepository({ dbFile: ":memory:" });
  const searches: Array<{ query: string; requestedItems: number | null; sources: DevAiKnowledgeSource[] }> = [];
  const chat = createDevAiChatService({ config: { enabled: true, provider: "minimax",
    model: "retrieval-eval-fixture", fastModel: "retrieval-eval-fixture", rateLimitPerMinute: 1000 },
    definitionsService: { async search(params) { return { data: [], meta: { count: 0, limit: params.limit ?? 0,
      truncated: false, q: params.q ?? "", fieldId: params.fieldId ?? "", formPath: params.formPath ?? "",
      type: params.type ?? "all", revision: null } }; } },
    knowledgeService: { invalidateCache: () => knowledge.invalidateCache(), async search(request) {
      const sources = await knowledge.search(request);
      searches.push({ query: request.query, requestedItems: request.maxItems ?? null, sources });
      return sources;
    } },
    providerClient: { name: "minimax", model: "retrieval-eval-fixture", async generateJsonText() {
      return JSON.stringify({ threadTitle: "離線檢索評估", answer: "此輪只評估檢索，不評估生成答案。",
        assumptions: [], followUps: [], sourceIds: [] });
    } },
  });
  const threads = createDevAiThreadService({ enabled: true, repository, chatService: chat,
    summaryEnabled: false });
  const results = [];
  try {
    const prepareStartedAt = Date.now();
    const index = options.mode === "hybrid" ? await knowledge.prepareIndex?.() ?? null : null;
    const embedding = index ? { ...await snapshotDevAiEmbeddingArtifacts(
      env.DEV_AI_EMBEDDING_CACHE_DIR, DEV_AI_EMBEDDING_MODEL, DEV_AI_EMBEDDING_REVISION),
      profile: index.profile, allowDownload: env.DEV_AI_EMBEDDING_ALLOW_DOWNLOAD } : null;
    const preparationMs = options.mode === "hybrid" ? Date.now() - prepareStartedAt : 0;
    for (const episode of episodes) {
      const thread = await threads.createThread(`retrieval-eval:${episode.id}`);
      const turns = [];
      for (const [index, turn] of episode.turns.entries()) {
        searches.length = 0;
        const response = await threads.sendMessage(`retrieval-eval:${episode.id}`, thread.id, {
          clientMessageId: `${episode.id}-${index + 1}`, message: turn.message,
          includeKnowledge: true, includeDefinitions: false, speedMode: options.speedMode,
        });
        const candidates = [...new Map(searches.flatMap((search) => search.sources)
          .map((source) => [source.sourceId, source])).values()];
        const context = response.chat?.contextSources ?? [];
        const candidateRanks = turn.expectedSourceIds.map((id) => ({ sourceId: id,
          rank: candidates.findIndex((source) => source.sourceId === id) + 1 }));
        const contextRanks = turn.expectedSourceIds.map((id) => ({ sourceId: id,
          rank: context.findIndex((source) => source.sourceId === id) + 1 }));
        turns.push({ message: turn.message,
          retrievalQuery: response.userMessage.metadata.retrievalQuery ?? turn.message,
          searches: searches.map((search) => ({ query: search.query, requestedItems: search.requestedItems })),
          candidates: candidates.map(sourceRecord), context: context.map(sourceRecord), candidateRanks, contextRanks,
          expectedSourceIds: turn.expectedSourceIds,
          candidateHits: turn.expectedSourceIds.filter((id) => candidates.some((source) => source.sourceId === id)),
          contextHits: turn.expectedSourceIds.filter((id) => context.some((source) => source.sourceId === id)),
          requiredEvidence: turn.requiredEvidence,
          evidenceHits: turn.requiredEvidence.filter((item) => context.some((source) =>
            source.sourceId === item.sourceId && source.excerpt.includes(item.text))),
          contextChars: response.chat?.contextPreview.chars ?? 0,
          latencyMs: response.chat?.latencyMs ?? null });
      }
      results.push({ id: episode.id, turns });
    }
    const allTurns = results.flatMap((episode) => episode.turns);
    const finalCode = await snapshotDevAiRetrievalCode(path.resolve(__dirname, ".."), options.mode);
    if (finalCode.codeSha256 !== codeSha256 || sha256(await readFile(options.cases, "utf8")) !== casesSha256
      || await knowledgeSnapshotSha256(options.knowledgeDir) !== knowledgeSha256) {
      throw new Error("評估期間程式、案例或知識快照已改變，結果不可歸因於單一版本");
    }
    if (embedding && (await snapshotDevAiEmbeddingArtifacts(
      env.DEV_AI_EMBEDDING_CACHE_DIR, DEV_AI_EMBEDDING_MODEL, DEV_AI_EMBEDDING_REVISION
    )).artifactSha256 !== embedding.artifactSha256) {
      throw new Error("評估期間 embedding 模型產物已改變，結果不可歸因於單一版本");
    }
    const output = { schemaVersion: "dev-ai-retrieval-eval.v1", generatedAt: new Date().toISOString(),
      mode: options.mode, lexicalProfile: options.lexicalProfile, speedMode: options.speedMode,
      cases: options.cases, knowledgeDir: options.knowledgeDir,
      casesSha256, codeSha256, codeFiles, knowledgeSha256, index, embedding,
      runtime: { node: process.version, platform: process.platform, arch: process.arch }, preparationMs,
      note: "使用真正 ThreadService 與檢索入口；生成模型為固定替身，回答品質需另行評估。",
      summary: {
        turns: allTurns.length,
        expectedSources: allTurns.reduce((sum, turn) => sum + turn.expectedSourceIds.length, 0),
        candidateHits: allTurns.reduce((sum, turn) => sum + turn.candidateHits.length, 0),
        contextHits: allTurns.reduce((sum, turn) => sum + turn.contextHits.length, 0),
        candidateMrr: allTurns.flatMap((turn) => turn.candidateRanks).reduce((sum, item) =>
          sum + (item.rank ? 1 / item.rank : 0), 0) / Math.max(1, allTurns.reduce((sum, turn) => sum + turn.expectedSourceIds.length, 0)),
        contextMrr: allTurns.flatMap((turn) => turn.contextRanks).reduce((sum, item) =>
          sum + (item.rank ? 1 / item.rank : 0), 0) / Math.max(1, allTurns.reduce((sum, turn) => sum + turn.expectedSourceIds.length, 0)),
        requiredEvidence: allTurns.reduce((sum, turn) => sum + turn.requiredEvidence.length, 0),
        evidenceHits: allTurns.reduce((sum, turn) => sum + turn.evidenceHits.length, 0),
      }, episodes: results };
    if (options.output) {
      await mkdir(path.dirname(options.output), { recursive: true });
      await writeFile(options.output, JSON.stringify(output, null, 2));
    } else console.log(JSON.stringify(output, null, 2));
  } finally {
    await repository.close();
    await knowledge.dispose?.();
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
