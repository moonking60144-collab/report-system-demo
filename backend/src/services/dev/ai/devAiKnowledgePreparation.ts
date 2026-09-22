import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../../config/env";
import {
  DEV_AI_EMBEDDING_MODEL,
  DEV_AI_EMBEDDING_REVISION,
} from "./devAiEmbedding";
import type { DevAiKnowledgeRuntimeStatus } from "@shared-types/ragicDefinitions";

interface CacheFileSnapshot {
  path: string;
  bytes: number;
}

interface DevAiKnowledgePreparationMarker {
  schemaVersion: "dev-ai-knowledge-preparation.v1";
  preparedAt: string;
  model: string;
  revision: string;
  profile: string;
  dimensions: number;
  fingerprint: string;
  cacheFiles: CacheFileSnapshot[];
}

export function devAiKnowledgePreparationMarkerFile(
  vectorDbFile = env.DEV_AI_VECTOR_DB_FILE
): string {
  return `${path.resolve(vectorDbFile)}.ready.json`;
}

async function listCacheFiles(root: string): Promise<CacheFileSnapshot[]> {
  const files: CacheFileSnapshot[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= 512) throw new Error("embedding cache 檔案數超過 readiness 上限");
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const metadata = await stat(absolute);
        files.push({
          path: path.relative(root, absolute).replace(/\\/g, "/"),
          bytes: metadata.size,
        });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await rm(filePath, { force: true });
      await rename(temporaryPath, filePath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function writeDevAiKnowledgePreparationMarker(
  result: {
    profile: string;
    dimensions: number;
    fingerprint: string;
  },
  options: {
    cacheDir?: string;
    vectorDbFile?: string;
    now?: () => Date;
  } = {}
): Promise<void> {
  const cacheDir = path.resolve(options.cacheDir ?? env.DEV_AI_EMBEDDING_CACHE_DIR);
  const cacheFiles = await listCacheFiles(cacheDir);
  if (!cacheFiles.length) throw new Error("embedding cache 為空，不能標記 knowledge readiness");
  await writeJsonAtomically(
    devAiKnowledgePreparationMarkerFile(options.vectorDbFile),
    {
      schemaVersion: "dev-ai-knowledge-preparation.v1",
      preparedAt: (options.now ?? (() => new Date()))().toISOString(),
      model: DEV_AI_EMBEDDING_MODEL,
      revision: DEV_AI_EMBEDDING_REVISION,
      profile: result.profile,
      dimensions: result.dimensions,
      fingerprint: result.fingerprint,
      cacheFiles,
    } satisfies DevAiKnowledgePreparationMarker
  );
}

export async function isDevAiKnowledgePreparationReady(
  runtime: DevAiKnowledgeRuntimeStatus,
  options: {
    cacheDir?: string;
    vectorDbFile?: string;
  } = {}
): Promise<boolean> {
  if (runtime.retrievalMode === "lexical") return true;
  if (runtime.index.state !== "ready") return false;
  let marker: DevAiKnowledgePreparationMarker;
  try {
    marker = JSON.parse(
      await readFile(devAiKnowledgePreparationMarkerFile(options.vectorDbFile), "utf8")
    ) as DevAiKnowledgePreparationMarker;
  } catch {
    return false;
  }
  if (
    marker.schemaVersion !== "dev-ai-knowledge-preparation.v1" ||
    marker.model !== DEV_AI_EMBEDDING_MODEL ||
    marker.revision !== DEV_AI_EMBEDDING_REVISION ||
    marker.profile !== runtime.index.profile ||
    marker.dimensions !== runtime.index.dimensions ||
    marker.fingerprint !== runtime.index.expectedFingerprint ||
    marker.fingerprint !== runtime.index.storedFingerprint ||
    !Array.isArray(marker.cacheFiles) ||
    !marker.cacheFiles.length
  ) {
    return false;
  }
  const cacheDir = path.resolve(options.cacheDir ?? env.DEV_AI_EMBEDDING_CACHE_DIR);
  try {
    for (const file of marker.cacheFiles) {
      if (!file.path || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return false;
      const absolute = path.resolve(cacheDir, file.path);
      if (path.relative(cacheDir, absolute).startsWith("..")) return false;
      if ((await stat(absolute)).size !== file.bytes) return false;
    }
    return true;
  } catch {
    return false;
  }
}
