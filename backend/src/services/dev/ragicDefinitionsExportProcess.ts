import { fork } from "node:child_process";
import { resolve } from "node:path";
import { env } from "../../config/env";
import type {
  RagicDefinitionsExportParams,
  RagicDefinitionsExportResult,
} from "./ragicDefinitionsExportService";

interface ExportWorkerSuccessMessage {
  ok: true;
  result: RagicDefinitionsExportResult;
}

interface ExportWorkerFailureMessage {
  ok: false;
  error: {
    message: string;
    stack?: string;
  };
}

type ExportWorkerMessage = ExportWorkerSuccessMessage | ExportWorkerFailureMessage;

function isExportWorkerMessage(message: unknown): message is ExportWorkerMessage {
  if (!message || typeof message !== "object") return false;
  return typeof (message as { ok?: unknown }).ok === "boolean";
}

export function exportRagicDefinitionsInChildProcess(
  params: RagicDefinitionsExportParams
): Promise<RagicDefinitionsExportResult> {
  const sourceRuntime = __filename.endsWith(".ts");
  const workerPath = resolve(
    __dirname,
    `ragicDefinitionsExportWorker.${sourceRuntime ? "ts" : "js"}`
  );
  const child = fork(workerPath, [], {
    execArgv: sourceRuntime ? ["--import", "tsx"] : [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  return new Promise<RagicDefinitionsExportResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (
      callback: () => void,
      options: { terminate?: boolean } = {}
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (options.terminate && child.connected) {
        child.kill("SIGTERM");
      }
      callback();
    };
    const timeout = setTimeout(() => {
      finish(
        () =>
          rejectPromise(
            new Error(
              `Ragic definitions 匯出超過 ${env.RAGIC_DEFINITIONS_EXPORT_TIMEOUT_MS}ms`
            )
          ),
        { terminate: true }
      );
    }, env.RAGIC_DEFINITIONS_EXPORT_TIMEOUT_MS);
    timeout.unref();

    child.once("message", (message: unknown) => {
      if (!isExportWorkerMessage(message)) {
        finish(() => rejectPromise(new Error("Ragic definitions 匯出子程序回傳格式無效")), {
          terminate: true,
        });
        return;
      }
      if (message.ok) {
        finish(() => resolvePromise(message.result), { terminate: true });
        return;
      }
      const error = new Error(message.error.message);
      error.stack = message.error.stack ?? error.stack;
      finish(() => rejectPromise(error), { terminate: true });
    });
    child.once("error", (error) => {
      finish(() => rejectPromise(error));
    });
    child.once("exit", (code, signal) => {
      finish(() =>
        rejectPromise(
          new Error(
            `Ragic definitions 匯出子程序提前結束：code=${String(code)} signal=${String(signal)}`
          )
        )
      );
    });

    child.send({ type: "export", params });
  });
}
