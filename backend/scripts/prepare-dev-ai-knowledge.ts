import { createDevAiKnowledgeBaseService } from "../src/services/dev/ai/devAiKnowledgeBaseService";
import { createDevAiEmbeddingProvider, verifyDevAiEmbeddingProvider } from "../src/services/dev/ai/devAiEmbedding";
import { writeDevAiKnowledgePreparationMarker } from "../src/services/dev/ai/devAiKnowledgePreparation";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--download")) throw new Error("只接受 --download；預設只使用已下載的模型檔");
const embeddingProvider = createDevAiEmbeddingProvider({ allowDownload: args.includes("--download") });
const service = createDevAiKnowledgeBaseService({
  retrievalMode: "hybrid",
  embeddingProvider,
});
void verifyDevAiEmbeddingProvider(embeddingProvider)
  .then(() => service.prepareIndex!())
  .then(async (result) => {
    await writeDevAiKnowledgePreparationMarker(result);
    return result;
  })
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error(error instanceof Error ? error.message : "知識索引準備失敗"); process.exitCode = 1; })
  .finally(() => service.dispose!());
