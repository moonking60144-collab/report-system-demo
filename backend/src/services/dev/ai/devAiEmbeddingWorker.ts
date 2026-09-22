import type { DevAiEmbeddingWorkerConfig } from "./devAiEmbedding";
import path from "node:path";

let config: DevAiEmbeddingWorkerConfig;
let extractor: Promise<(texts: string[]) => Promise<number[][]>> | undefined;

function loadExtractor() {
  return extractor ??= (async () => {
    const { pipeline, AutoTokenizer, env } = await import("@huggingface/transformers");
    env.allowRemoteModels = config.allowDownload;
    env.allowLocalModels = true;
    env.localModelPath = `${config.cacheDir}/unpacked/`;
    env.cacheDir = config.cacheDir;
    const tokenizer = await AutoTokenizer.from_pretrained(
      config.allowDownload ? config.model : path.join(config.cacheDir, config.model, config.revision),
      { revision: config.revision, cache_dir: config.cacheDir, local_files_only: !config.allowDownload },
    );
    const pipe = await pipeline("feature-extraction", config.model, {
      revision: config.revision,
      dtype: "q8",
      device: "cpu",
      cache_dir: config.cacheDir,
      local_files_only: !config.allowDownload,
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    });
    if (!pipe.tokenizer) pipe.tokenizer = tokenizer;
    return async (texts: string[]) => (await pipe(texts, {
      pooling: "mean", normalize: true,
    })).tolist() as number[][];
  })();
}

process.on("message", async (message: { id: number; texts: string[]; config: DevAiEmbeddingWorkerConfig }) => {
  config = message.config;
  try {
    const embed = await loadExtractor();
    const vectors = await embed(message.texts);
    process.send!({ id: message.id, vectors });
  } catch {
    extractor = undefined;
    process.send!({ id: message.id, error: "DEV_AI_EMBEDDING_UNAVAILABLE" });
  }
});
process.on("disconnect", () => process.exit(0));
