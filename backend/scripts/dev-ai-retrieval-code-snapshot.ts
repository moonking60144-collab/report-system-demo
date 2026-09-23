import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const ENTRY = "scripts/run-dev-ai-retrieval-episodes.ts";
const EMBEDDING_WORKER = "src/services/dev/ai/devAiEmbeddingWorker.ts";
const MANIFESTS = ["package.json", "package-lock.json", "tsconfig.json"];
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

export async function snapshotDevAiRetrievalCode(backendRoot: string, mode: "lexical" | "hybrid") {
  const repoRoot = path.resolve(backendRoot, "..");
  const configPath = path.join(backendRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const compiler = ts.parseJsonConfigFileContent(config.config, ts.sys, backendRoot);
  if (compiler.errors.length) throw new Error(compiler.errors.map((error) =>
    ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));

  const files = new Map<string, Buffer>();
  const visit = async (absolute: string): Promise<void> => {
    const relative = path.relative(repoRoot, absolute).replace(/\\/g, "/");
    if (relative.startsWith("../") || path.isAbsolute(relative) || relative.includes("/node_modules/")) return;
    if (files.has(relative)) return;
    const content = await readFile(absolute);
    files.set(relative, content);
    if (!/\.[cm]?[jt]sx?$/.test(absolute)) return;
    const imports = ts.preProcessFile(content.toString("utf8"), true, true).importedFiles;
    for (const item of imports) {
      const resolved = ts.resolveModuleName(item.fileName, absolute, compiler.options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved) {
        if (item.fileName.startsWith(".") || item.fileName.startsWith("@shared-types/")) {
          throw new Error(`無法解析本地程式依賴：${relative} → ${item.fileName}`);
        }
        continue;
      }
      await visit(path.resolve(resolved));
    }
  };

  await visit(path.join(backendRoot, ENTRY));
  // The embedding child is selected by a runtime filename, so static import traversal cannot see it.
  if (mode === "hybrid") await visit(path.join(backendRoot, EMBEDDING_WORKER));
  for (const name of MANIFESTS) await visit(path.join(backendRoot, name));

  const digest = createHash("sha256");
  const codeFiles = [...files.keys()].sort();
  for (const relative of codeFiles) {
    digest.update(relative).update("\0").update(files.get(relative)!).update("\0");
  }
  return { codeSha256: digest.digest("hex"), codeFiles };
}

export async function snapshotDevAiEmbeddingArtifacts(cacheDir: string, model: string, revision: string) {
  const root = path.join(cacheDir, model, revision);
  const files = [];
  const digest = createHash("sha256");
  for (const relative of MODEL_FILES) {
    const absolute = path.join(root, relative);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`embedding 模型檔案不是一般檔案：${relative}`);
    const fileDigest = createHash("sha256");
    for await (const chunk of createReadStream(absolute)) fileDigest.update(chunk);
    const sha256 = fileDigest.digest("hex");
    files.push({ path: relative, size: info.size, sha256 });
    digest.update(relative).update("\0").update(String(info.size)).update("\0").update(sha256).update("\0");
  }
  return { model, revision, artifactSha256: digest.digest("hex"), files };
}
