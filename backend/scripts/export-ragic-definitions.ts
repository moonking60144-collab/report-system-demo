/**
 * 匯出 Ragic Builder .nui 成可 Git diff 的 normalized definition。
 *
 * 用法：
 *   tsx scripts/export-ragic-definitions.ts [builder-root] [out-dir] [namespaces]
 */
import dotenv from "dotenv";
import {
  exportRagicDefinitions,
  formatRagicDefinitionsExportMessage,
  ragicDefinitionsExportUsage,
} from "../src/services/dev/ragicDefinitionsExportService";
import { withDefinitionsWriteLock } from "../src/services/dev/ragicDefinitionsIoLock";

dotenv.config();

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(ragicDefinitionsExportUsage());
    return;
  }

  const result = await withDefinitionsWriteLock(async () =>
    exportRagicDefinitions({
      builderRoot: process.argv[2] || process.env.RAGIC_BUILDER_PATH || "",
      outDir: process.argv[3] || "../ragic-definitions",
      namespaces: process.argv[4] || process.env.RAGIC_DEFINITION_NAMESPACES || "default",
      ragicNuiEncoding: process.env.RAGIC_NUI_ENCODING,
    })
  );
  console.log(formatRagicDefinitionsExportMessage(result));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
