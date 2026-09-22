import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { env } from "../../../config/env";
import { HttpError } from "../../../utils/httpError";

export interface DevAiEmbeddingWorkerConfig {
  model: string;
  revision: string;
  cacheDir: string;
  allowDownload: boolean;
}

export interface DevAiEmbeddingProvider {
  readonly profile: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  dispose?(): Promise<void>;
}

export const DEV_AI_EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const DEV_AI_EMBEDDING_REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";

export async function verifyDevAiEmbeddingProvider(provider: DevAiEmbeddingProvider): Promise<void> {
  const vectors = await provider.embed(["Dev AI 本機知識模型就緒檢查"]);
  const vector = vectors[0];
  if (vectors.length !== 1 || vector?.length !== provider.dimensions || !vector.every(Number.isFinite) || !vector.some((value) => value !== 0)) {
    throw new HttpError(503, "本機知識模型就緒檢查失敗", "DEV_AI_EMBEDDING_UNAVAILABLE");
  }
}

interface Job {
  id: number;
  texts: string[];
  resolve: (vectors: number[][]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createDevAiEmbeddingProvider(options: { cacheDir?: string; allowDownload?: boolean; timeoutMs?: number } = {}): DevAiEmbeddingProvider {
  const config: DevAiEmbeddingWorkerConfig = {
    model: DEV_AI_EMBEDDING_MODEL,
    revision: DEV_AI_EMBEDDING_REVISION,
    cacheDir: path.resolve(options.cacheDir ?? env.DEV_AI_EMBEDDING_CACHE_DIR),
    allowDownload: options.allowDownload ?? env.DEV_AI_EMBEDDING_ALLOW_DOWNLOAD,
  };
  const timeoutMs = options.timeoutMs ?? env.DEV_AI_EMBEDDING_TIMEOUT_MS;
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec"])
    if (process.env[key]) childEnvironment[key] = process.env[key];
  if (config.allowDownload) for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"])
    if (process.env[key]) childEnvironment[key] = process.env[key];
  let worker: ChildProcess | undefined;
  let active: Job | undefined;
  const queue: Job[] = [];
  let sequence = 0;
  let closed = false;
  let stopping: Promise<void> | undefined;
  const unavailable = () => new HttpError(503, "本機知識模型尚未準備好或執行失敗，請先準備知識索引後再試", "DEV_AI_EMBEDDING_UNAVAILABLE");

  function finish(job: Job, error?: Error, vectors?: number[][]) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.abort);
    if (active === job) active = undefined;
    error ? job.reject(error) : job.resolve(vectors!);
    if (!active) { worker?.unref(); worker?.channel?.unref(); }
    pump();
  }

  function stopWorker() {
    const previous = worker;
    worker = undefined;
    if (!previous) return stopping ?? Promise.resolve();
    return stopping = new Promise<void>((resolve) => {
      previous.ref();
      previous.channel?.ref();
      previous.once("close", resolve);
      previous.kill("SIGKILL");
    }).then(() => { stopping = undefined; pump(); });
  }

  function pump() {
    if (closed || stopping || active || !queue.length) return;
    const job = queue.shift()!;
    active = job;
    if (!worker) {
      const entry = path.join(__dirname, `devAiEmbeddingWorker${__filename.endsWith(".ts") ? ".ts" : ".js"}`);
      const current = spawn(process.execPath, ["--max-old-space-size=512", "-e", `
        const entry = ${JSON.stringify(entry)};
        if (entry.endsWith(".ts")) require("tsx/cjs/api").register();
        require(entry);
      `], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: childEnvironment });
      worker = current;
      current.on("message", (message: { id: number; error?: string; vectors?: number[][] }) => {
        if (worker !== current || active?.id !== message.id) return;
        const owned = active;
        const valid = message.vectors?.length === owned.texts.length && message.vectors.every((vector) =>
          vector.length === 384 && vector.every(Number.isFinite) && vector.some((value) => value !== 0));
        if (!valid || message.error) void stopWorker();
        finish(owned, valid && !message.error ? undefined : unavailable(), message.vectors);
      });
      const failed = () => {
        if (worker !== current) return;
        void stopWorker();
        if (active) finish(active, unavailable());
      };
      current.on("error", failed);
      current.on("exit", failed);
    }
    worker.ref();
    worker.channel?.ref();
    job.timer = setTimeout(() => {
      if (active !== job) return;
      void stopWorker();
      finish(job, unavailable());
    }, timeoutMs);
    worker.send!({ id: job.id, texts: job.texts, config }, (error) => {
      if (error && active === job) { void stopWorker(); finish(job, unavailable()); }
    });
  }

  return {
    profile: `${config.model}@${config.revision}:transformers4.3.0:q8:mean:normalized:512:title-content-aliases:v2`,
    dimensions: 384,
    async embed(texts, signal) {
      signal?.throwIfAborted();
      if (closed) throw unavailable();
      if (!texts.length) return [];
      if (texts.length > 8 || texts.some((text) => text.length > 4000)) throw new HttpError(400, "知識模型輸入過長", "DEV_AI_EMBEDDING_INPUT_LIMIT");
      if (queue.length >= 8) throw new HttpError(503, "知識搜尋忙碌中，請稍後再試", "DEV_AI_EMBEDDING_BUSY");
      return new Promise((resolve, reject) => {
        const job: Job = { id: ++sequence, texts, resolve, reject, signal, abort() {
          const error = signal?.reason instanceof Error ? signal.reason : new DOMException("搜尋已取消", "AbortError");
          if (active === job) {
            void stopWorker();
            finish(job, error);
          } else {
            const position = queue.indexOf(job);
            if (position < 0) return;
            queue.splice(position, 1);
            finish(job, error);
          }
        } };
        signal?.addEventListener("abort", job.abort, { once: true });
        queue.push(job);
        pump();
      });
    },
    async dispose() {
      closed = true;
      const abandoned = [...queue.splice(0), ...(active ? [active] : [])];
      const stopped = stopWorker();
      for (const job of abandoned) finish(job, unavailable());
      await stopped;
    },
  };
}
