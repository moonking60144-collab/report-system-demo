import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import { maskSecrets } from "../ragicFormulaPatchDryRunService";
import { RAGIC_OFFICIAL_KNOWLEDGE_SEEDS } from "./ragicOfficialKnowledgeSeeds";
import { selectKnowledgeEvidence, knowledgeEvidenceForRanges, trimKnowledgeEvidence } from "./devAiKnowledgeEvidence";
import { createDevAiVectorIndex, type DevAiIndexDocument, type DevAiVectorHit } from "./devAiVectorIndex";
import type { DevAiEmbeddingProvider } from "./devAiEmbedding";
import { DEV_AI_IPV4_TOKEN, findDevAiNetworkAddressOccurrences, stripDevAiNetworkAddresses } from "./devAiNetworkAddress";
import { HttpError } from "../../../utils/httpError";
import {
  devAiKnowledgePublicationBarrier,
  type DevAiKnowledgePublicationBarrier,
} from "./devAiKnowledgePublicationBarrier";
import { isDevAiKnowledgePreparationReady } from "./devAiKnowledgePreparation";
import type { DevAiKnowledgeSource } from "@shared-types/ragicDefinitions";

export interface DevAiKnowledgeSearchRequest {
  query: string;
  maxItems?: number;
  signal?: AbortSignal;
}

export interface DevAiKnowledgeBaseServiceDeps {
  knowledgeDir?: string;
  approvedExamplesFile?: string;
  maxItems?: number;
  cacheTtlMs?: number;
  now?: () => number;
  retrievalMode?: "lexical" | "hybrid" | "vector";
  vectorDbFile?: string;
  embeddingCacheDir?: string;
  embeddingProvider?: DevAiEmbeddingProvider;
  publicationBarrier?: DevAiKnowledgePublicationBarrier;
}

export interface DevAiKnowledgeBaseService {
  search(request: DevAiKnowledgeSearchRequest): Promise<DevAiKnowledgeSource[]>;
  invalidateCache(): void;
  prepareIndex?(): Promise<{ documents: number; chunks: number; profile: string; dimensions: number; fingerprint: string }>;
  getRuntimeStatus?(): Promise<import("@shared-types/ragicDefinitions").DevAiKnowledgeRuntimeStatus>;
  dispose?(): Promise<void>;
}

type KnowledgeDocument = DevAiIndexDocument;

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl"]);
const COMPLETE_OFFICIAL_EVIDENCE_MAX_CHARS = 2_400;
const OFFICIAL_KNOWLEDGE_QUERY_HINTS = [
  "ragic",
  "公式",
  "formula",
  "欄位",
  "表單",
  "子表格",
  "多選",
  "重算",
  "workflow",
  "工作流程",
  "javascript",
  "nashorn",
  "ecmascript",
  "es5",
  "if(",
  "isblank",
  "sumif",
  "sumifs",
  "updateif",
  "getnewvalue",
  "getoldvalue",
  "setifexecuteworkflow",
  "pre workflow",
  "post workflow",
  "action button",
  "動作按鈕",
  "global workflow",
];
const log = createLogger("dev-ai-knowledge");
const COMMON_RULE_HINTS = OFFICIAL_KNOWLEDGE_QUERY_HINTS.filter((hint) => !["ragic", "欄位", "表單"].includes(hint));
const MAX_HYBRID_EVIDENCE_CHARS = 720;

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const occurrences = findDevAiNetworkAddressOccurrences(text);
  for (const occurrence of occurrences) tokens.add(occurrence.token);
  const remaining = stripDevAiNetworkAddresses(text, occurrences).toLowerCase();
  for (const match of remaining.matchAll(/[a-z0-9_/-]+|[\u4e00-\u9fff]/g)) {
    const token = match[0]?.trim();
    if (token && token.length >= 1) tokens.add(token);
  }
  return tokens;
}

function titleFromContent(filePath: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(filePath);
}

function normalizeJsonContent(raw: string, filePath: string): KnowledgeDocument[] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jsonl") {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line, index): KnowledgeDocument[] => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const title = String(parsed.title ?? parsed.topic ?? `${path.basename(filePath)}:${index + 1}`);
          const content = String(parsed.content ?? parsed.rule ?? parsed.text ?? line);
          return [{ sourceId: `${filePath}#${index + 1}`, title, path: filePath, kind: "curated", content }];
        } catch {
          return [{ sourceId: `${filePath}#${index + 1}`, title: `${path.basename(filePath)}:${index + 1}`, path: filePath, kind: "curated", content: line }];
        }
      });
  }
  if (ext === ".json") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      return entries.flatMap((entry, index): KnowledgeDocument[] => {
        if (typeof entry !== "object" || entry === null) {
          return [{ sourceId: `${filePath}#${index + 1}`, title: `${path.basename(filePath)}:${index + 1}`, path: filePath, kind: "curated", content: String(entry) }];
        }
        const object = entry as Record<string, unknown>;
        const title = String(object.title ?? object.topic ?? `${path.basename(filePath)}:${index + 1}`);
        const content = String(object.content ?? object.rule ?? object.text ?? JSON.stringify(object));
        return [{ sourceId: `${filePath}#${index + 1}`, title, path: filePath, kind: "curated", content }];
      });
    } catch {
      return [{ sourceId: filePath, title: path.basename(filePath), path: filePath, kind: "curated", content: raw }];
    }
  }
  return [{ sourceId: filePath, title: titleFromContent(filePath, raw), path: filePath, kind: "curated", content: raw }];
}

async function listKnowledgeFiles(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && /ENOENT/.test(error.message)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listKnowledgeFiles(absolute));
      continue;
    }
    if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(absolute);
    }
  }
  return files;
}

function matchesRequestedAsset(document: KnowledgeDocument, queryTokens: Set<string>): boolean {
  const requested = [...queryTokens].filter((token) => DEV_AI_IPV4_TOKEN.test(token));
  if (!requested.length) return true;
  const addresses = [...tokenize(`${document.title}\n${document.content}`)].filter((token) => DEV_AI_IPV4_TOKEN.test(token));
  if (!addresses.length) return true;
  return requested.some((address) => addresses.some((token) => token === address || (!address.includes(":") && token.startsWith(`${address}:`))));
}

function scoreDocument(document: KnowledgeDocument, queryTokens: Set<string>): number {
  const haystack = `${document.title}\n${document.content}`.toLowerCase();
  const addressTokens = [...queryTokens].filter((token) => DEV_AI_IPV4_TOKEN.test(token));
  const documentTokens = addressTokens.length ? tokenize(haystack) : new Set<string>();
  const matchesAddress = (address: string) => documentTokens.has(address) || (
    !address.includes(":") && [...documentTokens].some((token) => token.startsWith(`${address}:`))
  );
  if (!matchesRequestedAsset(document, queryTokens)) return 0;
  const searchTerms = (document.searchTerms ?? []).join(" ").toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    if (DEV_AI_IPV4_TOKEN.test(token)) {
      if (matchesAddress(token)) score += 12;
      continue;
    }
    if (document.title.toLowerCase().includes(token)) score += 4;
    if (haystack.includes(token)) score += token.length > 1 ? 2 : 1;
    if (token.length > 1 && searchTerms.includes(token)) score += 4;
  }
  return score;
}

function shouldIncludeOfficialKnowledge(query: string): boolean {
  const normalized = query.toLowerCase();
  return OFFICIAL_KNOWLEDGE_QUERY_HINTS.some((hint) => normalized.includes(hint));
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function usesCompleteOfficialEvidence(document: KnowledgeDocument): boolean {
  return document.kind === "official" && document.content.length <= COMPLETE_OFFICIAL_EVIDENCE_MAX_CHARS;
}

function hybridEvidence(document: KnowledgeDocument, query: string, queryTokens: Set<string>, includeLexical: boolean, vector?: { ranges: { start: number; end: number }[] }) {
  // Short API guides contain coupled defaults and exceptions; head/tail clipping can reverse their meaning.
  if (usesCompleteOfficialEvidence(document)) {
    return knowledgeEvidenceForRanges(document.content, [{ start: 0, end: document.content.length }]);
  }
  const lexical = includeLexical ? selectKnowledgeEvidence(document.content, queryTokens).evidenceSpans!.map((span) => ({ start: span.sourceStart, end: span.sourceEnd })) : [];
  const semantic = vector?.ranges ?? [];
  const explicitIdentifier = /(?:\d{1,3}\.){3}\d{1,3}|\b\d{5,10}\b|\b[A-Za-z_$][\w$]*\s*\(/.test(query);
  const selected: { start: number; end: number }[] = [];
  const primary = explicitIdentifier ? lexical : semantic;
  const secondary = explicitIdentifier ? semantic : lexical;
  const preferred = primary[0] ?? secondary[0];
  if (preferred) selected.push(preferred);
  for (const range of [...secondary, ...primary.slice(1)]) {
    const overlap = selected.find((existing) => range.start < existing.end && existing.start < range.end);
    if (overlap) {
      overlap.start = Math.min(overlap.start, range.start);
      overlap.end = Math.max(overlap.end, range.end);
      continue;
    }
    if (selected.length === 2) break;
    selected.push(range);
  }
  const evidence = knowledgeEvidenceForRanges(document.content, selected);
  if (evidence.excerpt.length <= MAX_HYBRID_EVIDENCE_CHARS) return evidence;
  const clipped = trimKnowledgeEvidence({
    sourceId: document.sourceId,
    title: document.title,
    kind: document.kind,
    score: 0,
    ...evidence,
  }, MAX_HYBRID_EVIDENCE_CHARS);
  return {
    excerpt: clipped.excerpt,
    sourceVersion: clipped.sourceVersion,
    evidenceSpans: clipped.evidenceSpans,
  };
}

export function createDevAiKnowledgeBaseService(
  deps: DevAiKnowledgeBaseServiceDeps = {}
): DevAiKnowledgeBaseService {
  const knowledgeDir = path.resolve(deps.knowledgeDir ?? env.DEV_AI_KNOWLEDGE_DIR);
  const approvedExamplesFile = path.resolve(
    deps.approvedExamplesFile ?? env.DEV_AI_APPROVED_EXAMPLES_FILE
  );
  const defaultMaxItems = Math.max(1, deps.maxItems ?? env.DEV_AI_KNOWLEDGE_MAX_ITEMS);
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? env.DEV_AI_KNOWLEDGE_CACHE_TTL_MS);
  const now = deps.now ?? Date.now;
  const retrievalMode = (deps.retrievalMode ?? env.DEV_AI_RETRIEVAL_MODE) as
    | "lexical"
    | "hybrid"
    | "vector";
  if (!["lexical", "hybrid", "vector"].includes(retrievalMode)) throw new Error("DEV_AI_RETRIEVAL_MODE 必須為 lexical、hybrid 或 vector");
  const vectorDbFile = deps.vectorDbFile ?? env.DEV_AI_VECTOR_DB_FILE;
  const embeddingCacheDir = deps.embeddingCacheDir ?? env.DEV_AI_EMBEDDING_CACHE_DIR;
  const vectorIndex = createDevAiVectorIndex({ dbFile: vectorDbFile, embeddingProvider: deps.embeddingProvider });
  const publicationBarrier = deps.publicationBarrier ?? devAiKnowledgePublicationBarrier;
  let cachedAt = 0;
  let cachedDocuments: KnowledgeDocument[] | null = null;
  let generation = 0;

  async function loadDocuments(signal?: AbortSignal): Promise<KnowledgeDocument[]> {
    const current = now();
    if (cachedDocuments && cacheTtlMs > 0 && current - cachedAt <= cacheTtlMs) {
      return cachedDocuments;
    }
    return publicationBarrier.withRead(async () => {
      const lockedCurrent = now();
      if (
        cachedDocuments &&
        cacheTtlMs > 0 &&
        lockedCurrent - cachedAt <= cacheTtlMs
      ) {
        return cachedDocuments;
      }
      const loadGeneration = generation;
      signal?.throwIfAborted();
      const files = (await listKnowledgeFiles(knowledgeDir)).filter(
        (file) => path.resolve(file) !== approvedExamplesFile
      );
      const documents: KnowledgeDocument[] = [];
      for (const file of files) {
        signal?.throwIfAborted();
        const relative = path.relative(knowledgeDir, file).replace(/\\/g, "/");
        try {
          const raw = maskSecrets(await readFile(file, "utf8"));
          if (/(?:^|\/)approved-(?:chat-answers|formula-examples)\.md$/.test(relative) && /^- entries:\s*0\s*$/m.test(raw)) continue;
          documents.push(...normalizeJsonContent(raw, relative));
        } catch (error) {
          if (isAbortError(error)) throw error;
          log.warn({
            event: "knowledge-file-skipped",
            file: relative,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      documents.push(...RAGIC_OFFICIAL_KNOWLEDGE_SEEDS);
      if (generation !== loadGeneration) throw new HttpError(503, "知識正在更新，請稍後再試", "DEV_AI_KNOWLEDGE_CHANGED");
      cachedAt = lockedCurrent;
      cachedDocuments = documents;
      return documents;
    });
  }

  async function search(
    request: DevAiKnowledgeSearchRequest
  ): Promise<DevAiKnowledgeSource[]> {
    request.signal?.throwIfAborted();
    const query = maskSecrets(request.query.trim());
    if (!query) return [];
    const queryTokens = tokenize(query);
    const includeOfficialKnowledge = shouldIncludeOfficialKnowledge(request.query);
    const includeCommonRules = COMMON_RULE_HINTS.some((hint) => request.query.toLowerCase().includes(hint));
    const includeOfficialForQuery = includeOfficialKnowledge && (includeCommonRules || ![...queryTokens].some((token) => DEV_AI_IPV4_TOKEN.test(token)));
    const documents = await loadDocuments(request.signal);
    const searchGeneration = generation;
    const ranked = documents
      .map((document) => ({
        document,
        score: scoreDocument(document, queryTokens),
      }))
      .filter((entry) => entry.score > 0)
      .filter((entry) => entry.document.kind !== "official" || includeOfficialForQuery)
      .sort((a, b) => b.score - a.score || a.document.title.localeCompare(b.document.title));
    const maxItems = Math.max(1, request.maxItems ?? defaultMaxItems);
    if (retrievalMode !== "lexical") {
      let vectorHits: DevAiVectorHit[];
      try {
        vectorHits = await vectorIndex.search(documents, query, new Set(documents.filter((document) => matchesRequestedAsset(document, queryTokens) && (document.kind !== "official" || includeCommonRules || ![...queryTokens].some((token) => DEV_AI_IPV4_TOKEN.test(token)))).map((document) => document.sourceId)), request.signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "知識索引暫時無法使用，請稍後再試", "DEV_AI_KNOWLEDGE_UNAVAILABLE");
      }
      if (searchGeneration !== generation) throw new HttpError(503, "知識正在更新，請稍後再試", "DEV_AI_KNOWLEDGE_CHANGED");
      const vectorRank = new Map<string, { rank: number; similarity: number; ranges: { start: number; end: number }[] }>();
      for (const hit of vectorHits.filter((item) => item.similarity >= 0.4)) {
        let candidate = vectorRank.get(hit.sourceId);
        if (!candidate) { candidate = { rank: vectorRank.size + 1, similarity: hit.similarity, ranges: [] }; vectorRank.set(hit.sourceId, candidate); }
        if (candidate.ranges.length < 3 && !candidate.ranges.some((range) => Math.min(range.end, hit.end) - Math.max(range.start, hit.start) > 90)) candidate.ranges.push({ start: hit.start, end: hit.end });
      }
      const lexicalRank = new Map(ranked.map((entry, index) => [entry.document.sourceId, index + 1]));
      const fused = documents.map((document) => {
        const lexical = retrievalMode === "vector" ? undefined : lexicalRank.get(document.sourceId);
        const vector = vectorRank.get(document.sourceId);
        return { document, lexical, vector, score: 1200 * ((lexical ? 1 / (60 + lexical) : 0) + (vector ? 1.25 / (60 + vector.rank) : 0)) };
      }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.document.sourceId.localeCompare(b.document.sourceId));
      return fused.slice(0, maxItems).map(({ document, lexical, vector, score }) => ({
        sourceId: document.sourceId, title: document.title, kind: document.kind, path: document.path, score,
        ...hybridEvidence(document, query, queryTokens, retrievalMode === "hybrid", vector),
        retrieval: { mode: retrievalMode as "hybrid" | "vector", ...(lexical ? { lexicalRank: lexical } : {}), ...(vector ? { vectorRank: vector.rank, similarity: vector.similarity } : {}) },
      }));
    }
    const selected = ranked.slice(0, maxItems);
    if (includeCommonRules && [...queryTokens].some((token) => DEV_AI_IPV4_TOKEN.test(token)) && maxItems > 1) {
      for (const kind of ["curated", "official"] as const) {
        const best = ranked.find((entry) => entry.document.kind === kind);
        if (best && !selected.some((entry) => entry.document.kind === kind)) selected[selected.length - 1] = best;
      }
    }
    return selected.map(({ document, score }) => ({
      sourceId: document.sourceId,
      title: document.title,
      kind: document.kind,
      ...(usesCompleteOfficialEvidence(document)
        ? knowledgeEvidenceForRanges(document.content, [{ start: 0, end: document.content.length }])
        : selectKnowledgeEvidence(document.content, queryTokens)),
      score,
      path: document.path,
    }));
  }

  function invalidateCache(): void {
    generation += 1;
    cachedAt = 0;
    cachedDocuments = null;
  }

  return {
    search, invalidateCache,
    async getRuntimeStatus() {
      const documents = await loadDocuments();
      if (retrievalMode === "lexical") {
        return {
          retrievalMode,
          documents: documents.length,
          embedding: {
            required: false,
            state: "not-required" as const,
            profile: null,
            dimensions: null,
          },
          index: {
            required: false,
            state: "not-required" as const,
            profile: null,
            dimensions: null,
            expectedFingerprint: null,
            storedFingerprint: null,
            expectedChunks: 0,
            storedChunks: 0,
            updatedAt: null,
            errorCode: null,
          },
        };
      }
      const index = await vectorIndex.inspect(documents);
      const runtime: import("@shared-types/ragicDefinitions").DevAiKnowledgeRuntimeStatus = {
        retrievalMode,
        documents: documents.length,
        embedding: {
          required: true,
          state: "not-checked" as const,
          profile: index.profile,
          dimensions: index.dimensions,
        },
        index: {
          required: true,
          ...index,
        },
      };
      if (
        await isDevAiKnowledgePreparationReady(runtime, {
          cacheDir: embeddingCacheDir,
          vectorDbFile,
        })
      ) {
        runtime.embedding.state = "prepared";
      }
      return runtime;
    },
    async prepareIndex() {
      const documents = await loadDocuments();
      const result = await vectorIndex.prepare(documents);
      return { documents: documents.length, chunks: result.chunks.length, profile: result.profile, dimensions: result.dimensions, fingerprint: result.fingerprint };
    },
    dispose: () => vectorIndex.dispose(),
  };
}

export const devAiKnowledgeBaseService = createDevAiKnowledgeBaseService();
