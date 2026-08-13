import {
  exportRagicDefinitions,
  type RagicDefinitionsExportParams,
} from "./ragicDefinitionsExportService";

interface ExportWorkerRequest {
  type: "export";
  params: RagicDefinitionsExportParams;
}

function isExportWorkerRequest(message: unknown): message is ExportWorkerRequest {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "export"
  );
}

process.once("message", (message: unknown) => {
  if (!isExportWorkerRequest(message)) {
    process.send!({
      ok: false,
      error: { message: "Ragic definitions 匯出子程序收到無效請求" },
    });
    return;
  }

  try {
    const result = exportRagicDefinitions(message.params);
    process.send!({ ok: true, result });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    process.send!({
      ok: false,
      error: {
        message: normalized.message,
        stack: normalized.stack,
      },
    });
  }
});
