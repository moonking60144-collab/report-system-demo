import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../../config/env";
import { HttpError } from "../../../utils/httpError";
import { createDevAiEmbeddingProvider, type DevAiEmbeddingProvider } from "./devAiEmbedding";

export interface DevAiIndexDocument {
  sourceId: string;
  title: string;
  path: string;
  kind: "curated" | "official";
  content: string;
  searchTerms?: string[];
}

interface Chunk {
  id: string;
  sourceId: string;
  start: number;
  end: number;
  input: string;
}

export interface DevAiVectorHit {
  sourceId: string;
  start: number;
  end: number;
  similarity: number;
}

export interface DevAiVectorIndexStatus {
  state: "missing" | "ready" | "stale" | "error";
  profile: string;
  dimensions: number;
  expectedFingerprint: string;
  storedFingerprint: string | null;
  expectedChunks: number;
  storedChunks: number;
  updatedAt: string | null;
  errorCode: string | null;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const SECTION_CHUNK_CHARS = 560;
const LONG_SECTION_CHUNK_CHARS = 360;
const CHUNK_OVERLAP = 80;

function sectionStartsFor(content: string): number[] {
  const starts = [0];
  let fenced: { marker: string; length: number } | null = null;
  let offset = 0;
  for (const line of content.split("\n")) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      const marker = delimiter[1][0];
      if (!fenced) fenced = { marker, length: delimiter[1].length };
      else if (fenced.marker === marker && delimiter[1].length >= fenced.length) fenced = null;
    } else if (!fenced && offset > 0 && /^#{1,6}[ \t]+.+$/.test(line)) starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function chunksFor(documents: DevAiIndexDocument[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const document of [...documents].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    const sectionStarts = sectionStartsFor(document.content);
    for (const [index, sectionStart] of sectionStarts.entries()) {
      const sectionEnd = sectionStarts[index + 1] ?? document.content.length;
      const chunkChars = sectionEnd - sectionStart <= SECTION_CHUNK_CHARS
        ? SECTION_CHUNK_CHARS : LONG_SECTION_CHUNK_CHARS;
      const headingEnd = document.content.indexOf("\n", sectionStart);
      const heading = document.content.slice(sectionStart, headingEnd < 0 ? sectionEnd : Math.min(headingEnd, sectionEnd));
      const sectionHeading = /^#{1,6}[ \t]+/.test(heading) ? heading.slice(0, 120) : "";
      for (let start = sectionStart; start < sectionEnd;) {
        const end = Math.min(sectionEnd, start + chunkChars);
        const input = `${document.title.slice(0, 120)}\n${(document.searchTerms ?? []).join(" ").slice(0, 160)}\n${sectionHeading}\n${document.content.slice(start, end)}`;
        chunks.push({ id: hash(JSON.stringify([document.sourceId, start, end, input])), sourceId: document.sourceId, start, end, input });
        if (chunks.length > 5000) throw new HttpError(503, "知識索引超過目前容量，請先整理知識內容", "DEV_AI_VECTOR_CAPACITY");
        if (end === sectionEnd) break;
        start = Math.max(start + 1, end - CHUNK_OVERLAP);
      }
    }
  }
  return chunks;
}

function validateVector(vector: number[], dimensions: number) {
  if (vector.length !== dimensions || !vector.every(Number.isFinite) || !vector.some((value) => value !== 0)) {
    throw new HttpError(503, "知識向量格式不正確，請重新準備索引", "DEV_AI_VECTOR_INVALID");
  }
}

function encodeVector(vector: number[]) {
  const buffer = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function decodeVector(buffer: Buffer, dimensions: number) {
  if (buffer.length !== dimensions * 4) throw new HttpError(503, "知識向量索引損壞", "DEV_AI_VECTOR_INVALID");
  const vector = Array.from({ length: dimensions }, (_, index) => buffer.readFloatLE(index * 4));
  validateVector(vector, dimensions);
  return vector;
}

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]; normA += a[i] ** 2; normB += b[i] ** 2;
  }
  return dot / Math.sqrt(normA * normB);
}

export function createDevAiVectorIndex(options: { dbFile?: string; embeddingProvider?: DevAiEmbeddingProvider } = {}) {
  const provider = options.embeddingProvider ?? createDevAiEmbeddingProvider();
  const dbFile = options.dbFile ?? env.DEV_AI_VECTOR_DB_FILE;
  const profile = `${provider.profile}:dim${provider.dimensions}:section${SECTION_CHUNK_CHARS}:long${LONG_SECTION_CHUNK_CHARS}:overlap${CHUNK_OVERLAP}:v3`;
  let dbPromise: Promise<Database> | undefined;
  let mutationChain: Promise<unknown> = Promise.resolve();
  let closed = false;
  let snapshot: { fingerprint: string; vectors: Map<string, number[]> } | undefined;
  const queryCache = new Map<string, number[]>();

  function db() {
    if (dbPromise) return dbPromise;
    const loading = (async () => {
      if (dbFile !== ":memory:") await mkdir(path.dirname(path.resolve(dbFile)), { recursive: true });
      const connection = await open({ filename: dbFile === ":memory:" ? dbFile : path.resolve(dbFile), driver: sqlite3.Database });
      try {
        await connection.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS vector_snapshots (profile TEXT PRIMARY KEY, fingerprint TEXT NOT NULL); CREATE TABLE IF NOT EXISTS knowledge_vectors (profile TEXT NOT NULL, chunk_id TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(profile, chunk_id));");
        return connection;
      } catch (error) {
        await connection.close(); throw error;
      }
    })();
    dbPromise = loading;
    void loading.catch(() => { if (dbPromise === loading) dbPromise = undefined; });
    return loading;
  }

  async function prepare(documents: DevAiIndexDocument[]) {
    if (closed) throw new HttpError(503, "知識索引已關閉", "DEV_AI_VECTOR_CLOSED");
    const chunks = chunksFor(documents);
    const fingerprint = hash(JSON.stringify(chunks.map((chunk) => chunk.id)));
    const operation = mutationChain.then(async () => {
      if (snapshot?.fingerprint === fingerprint) return snapshot;
      const connection = await db();
      const stored = await connection.all<{ chunk_id: string; vector: Buffer }[]>("SELECT chunk_id, vector FROM knowledge_vectors WHERE profile = ?", profile);
      const available = new Map<string, number[]>();
      for (const row of stored) {
        try { available.set(row.chunk_id, decodeVector(row.vector, provider.dimensions)); }
        catch (error) { if (!(error instanceof HttpError)) throw error; }
      }
      const persisted = await connection.get<{ fingerprint: string }>("SELECT fingerprint FROM vector_snapshots WHERE profile = ?", profile);
      const missing = chunks.filter((chunk) => !available.has(chunk.id));
      for (let start = 0; start < missing.length; start += 8) {
        const batch = missing.slice(start, start + 8);
        const vectors = await provider.embed(batch.map((chunk) => chunk.input));
        if (vectors.length !== batch.length) throw new HttpError(503, "知識向量數量不正確", "DEV_AI_VECTOR_INVALID");
        for (const [index, chunk] of batch.entries()) {
          validateVector(vectors[index], provider.dimensions);
          available.set(chunk.id, decodeVector(encodeVector(vectors[index]), provider.dimensions));
        }
      }
      if (closed) throw new HttpError(503, "知識索引已關閉", "DEV_AI_VECTOR_CLOSED");
      if (persisted?.fingerprint !== fingerprint || missing.length || available.size !== chunks.length) {
        await connection.exec("BEGIN IMMEDIATE");
        try {
          await connection.run("DELETE FROM knowledge_vectors WHERE profile = ?", profile);
          for (const chunk of chunks) await connection.run("INSERT INTO knowledge_vectors(profile, chunk_id, vector) VALUES(?, ?, ?)", profile, chunk.id, encodeVector(available.get(chunk.id)!));
          await connection.run("INSERT INTO vector_snapshots(profile, fingerprint) VALUES(?, ?) ON CONFLICT(profile) DO UPDATE SET fingerprint = excluded.fingerprint", profile, fingerprint);
          await connection.exec("COMMIT");
        } catch (error) {
          await connection.exec("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }
      return snapshot = { fingerprint, vectors: new Map(chunks.map((chunk) => [chunk.id, available.get(chunk.id)!])) };
    });
    mutationChain = operation.catch(() => undefined);
    const ready = await operation;
    return { chunks, vectors: ready.vectors, fingerprint, profile, dimensions: provider.dimensions };
  }

  async function inspect(documents: DevAiIndexDocument[]): Promise<DevAiVectorIndexStatus> {
    const chunks = chunksFor(documents);
    const expectedFingerprint = hash(JSON.stringify(chunks.map((chunk) => chunk.id)));
    const base = {
      profile,
      dimensions: provider.dimensions,
      expectedFingerprint,
      expectedChunks: chunks.length,
    };
    if (snapshot) {
      const storedChunks = snapshot.vectors.size;
      return {
        ...base,
        state:
          snapshot.fingerprint === expectedFingerprint && storedChunks === chunks.length
            ? "ready"
            : "stale",
        storedFingerprint: snapshot.fingerprint,
        storedChunks,
        updatedAt: null,
        errorCode: null,
      };
    }
    if (dbFile === ":memory:") {
      return {
        ...base,
        state: "missing",
        storedFingerprint: null,
        storedChunks: 0,
        updatedAt: null,
        errorCode: null,
      };
    }
    const resolvedDbFile = path.resolve(dbFile);
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(resolvedDbFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          ...base,
          state: "missing",
          storedFingerprint: null,
          storedChunks: 0,
          updatedAt: null,
          errorCode: null,
        };
      }
      throw error;
    }
    let connection: Database | null = null;
    try {
      connection = await open({
        filename: resolvedDbFile,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
      });
      const persisted = await connection.get<{ fingerprint: string }>(
        "SELECT fingerprint FROM vector_snapshots WHERE profile = ?",
        profile
      );
      const count = await connection.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM knowledge_vectors WHERE profile = ?",
        profile
      );
      const storedFingerprint = persisted?.fingerprint ?? null;
      const storedChunks = Number(count?.count ?? 0);
      return {
        ...base,
        state:
          !storedFingerprint || storedChunks === 0
            ? "missing"
            : storedFingerprint === expectedFingerprint && storedChunks === chunks.length
              ? "ready"
              : "stale",
        storedFingerprint,
        storedChunks,
        updatedAt: metadata.mtime.toISOString(),
        errorCode: null,
      };
    } catch {
      return {
        ...base,
        state: "error",
        storedFingerprint: null,
        storedChunks: 0,
        updatedAt: metadata.mtime.toISOString(),
        errorCode: "DEV_AI_VECTOR_STATUS_UNREADABLE",
      };
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  return {
    prepare,
    inspect,
    async search(documents: DevAiIndexDocument[], query: string, eligible: Set<string>, signal?: AbortSignal): Promise<DevAiVectorHit[]> {
      signal?.throwIfAborted();
      const pending = prepare(documents);
      const ready = signal ? await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("搜尋已取消", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      }) : await pending;
      signal?.throwIfAborted();
      let queryVector = queryCache.get(query);
      if (!queryVector) {
        const vectors = await provider.embed([query.slice(0, 2000)], signal);
        if (vectors.length !== 1) throw new HttpError(503, "查詢向量數量不正確", "DEV_AI_VECTOR_INVALID");
        queryVector = vectors[0];
        validateVector(queryVector, provider.dimensions);
        queryCache.set(query, queryVector);
        if (queryCache.size > 128) queryCache.delete(queryCache.keys().next().value!);
      }
      const hits: DevAiVectorHit[] = [];
      for (const [index, chunk] of ready.chunks.entries()) {
        if (index % 256 === 0) { await setImmediate(); signal?.throwIfAborted(); }
        if (!eligible.has(chunk.sourceId)) continue;
        hits.push({ sourceId: chunk.sourceId, start: chunk.start, end: chunk.end, similarity: cosine(queryVector, ready.vectors.get(chunk.id)!) });
      }
      return hits.sort((a, b) => b.similarity - a.similarity || a.sourceId.localeCompare(b.sourceId) || a.start - b.start);
    },
    async dispose() {
      closed = true;
      await provider.dispose?.();
      await mutationChain;
      await (await dbPromise)?.close();
    },
  };
}
