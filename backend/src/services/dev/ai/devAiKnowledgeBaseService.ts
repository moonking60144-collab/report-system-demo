import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../../config/env";
import { createLogger } from "../../../observability/logger";
import { maskSecrets } from "../ragicFormulaPatchDryRunService";
import { RAGIC_OFFICIAL_KNOWLEDGE_SEEDS } from "./ragicOfficialKnowledgeSeeds";
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
}

export interface DevAiKnowledgeBaseService {
  search(request: DevAiKnowledgeSearchRequest): Promise<DevAiKnowledgeSource[]>;
  invalidateCache(): void;
}

interface KnowledgeDocument {
  sourceId: string;
  title: string;
  path: string;
  kind: Extract<DevAiKnowledgeSource["kind"], "curated" | "official">;
  content: string;
}

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl"]);
const OFFICIAL_KNOWLEDGE_QUERY_HINTS = [
  "ragic",
  "公式",
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

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9_/-]+|[\u4e00-\u9fff]/g)) {
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

function excerpt(content: string, queryTokens: Set<string>): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 360) return normalized;
  const lower = normalized.toLowerCase();
  let index = 0;
  for (const token of queryTokens) {
    const found = lower.indexOf(token.toLowerCase());
    if (found >= 0) {
      index = Math.max(0, found - 90);
      break;
    }
  }
  return `${index > 0 ? "…" : ""}${normalized.slice(index, index + 360)}…`;
}

function scoreDocument(document: KnowledgeDocument, queryTokens: Set<string>): number {
  const haystack = `${document.title}\n${document.content}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (!token) continue;
    if (document.title.toLowerCase().includes(token)) score += 4;
    if (haystack.includes(token)) score += token.length > 1 ? 2 : 1;
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
  let cachedAt = 0;
  let cachedDocuments: KnowledgeDocument[] | null = null;

  async function loadDocuments(signal?: AbortSignal): Promise<KnowledgeDocument[]> {
    const current = now();
    if (cachedDocuments && cacheTtlMs > 0 && current - cachedAt <= cacheTtlMs) {
      return cachedDocuments;
    }
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
    cachedAt = current;
    cachedDocuments = documents;
    return documents;
  }

  async function search(
    request: DevAiKnowledgeSearchRequest
  ): Promise<DevAiKnowledgeSource[]> {
    request.signal?.throwIfAborted();
    const queryTokens = tokenize(request.query);
    const includeOfficialKnowledge = shouldIncludeOfficialKnowledge(request.query);
    const documents = await loadDocuments(request.signal);
    return documents
      .map((document) => ({
        document,
        score: scoreDocument(document, queryTokens),
      }))
      .filter((entry) => entry.score > 0)
      .filter((entry) => entry.document.kind !== "official" || includeOfficialKnowledge)
      .sort((a, b) => b.score - a.score || a.document.title.localeCompare(b.document.title))
      .slice(0, request.maxItems ?? defaultMaxItems)
      .map(({ document, score }) => ({
        sourceId: document.sourceId,
        title: document.title,
        kind: document.kind,
        excerpt: excerpt(document.content, queryTokens),
        score,
        path: document.path,
      }));
  }

  function invalidateCache(): void {
    cachedAt = 0;
    cachedDocuments = null;
  }

  return { search, invalidateCache };
}

export const devAiKnowledgeBaseService = createDevAiKnowledgeBaseService();
