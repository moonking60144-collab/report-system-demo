import { existsSync, watch, type FSWatcher } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLogger } from "../../observability/logger";
import {
  publishRagicDefinitionsSyncStatus,
  type RagicDefinitionsSyncPayload,
} from "../../events/realtimeEventBus";
import {
  ragicDefinitionsReExportService,
  type RagicDefinitionsReExportService,
} from "./ragicDefinitionsReExportService";

const log = createLogger("ragic-definitions-watch");
const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_SETTLE_MS = 700;

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;
const DEFAULT_SUPPRESS_MS = 5_000;
const suppressedWatchPaths = new Map<string, number>();

export interface WatchHandle {
  close(): void;
}

export interface RagicDefinitionsWatchServiceOptions {
  builderRoot?: string;
  debounceMs?: number;
  settleMs?: number;
  reExportService?: Pick<RagicDefinitionsReExportService, "reExport">;
  rootExists?: (path: string) => boolean;
  watchRoot?: (builderRoot: string, listener: WatchListener) => WatchHandle;
  publish?: (payload: RagicDefinitionsSyncPayload) => void;
}

function normalizeWatchFilename(raw: string | Buffer | null): string {
  if (!raw) return "";
  const value = typeof raw === "string" ? raw : raw.toString("utf-8");
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeWatchKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function suppressPathKey(filePath: string, builderRoot: string): string {
  const trimmedRoot = builderRoot.trim();
  if (!trimmedRoot) return normalizeWatchKey(filePath);
  const root = resolve(trimmedRoot);
  const target = resolve(filePath);
  const rootCompare = process.platform === "win32" ? root.toLowerCase() : root;
  const targetCompare = process.platform === "win32" ? target.toLowerCase() : target;
  if (targetCompare === rootCompare || targetCompare.startsWith(`${rootCompare}${sep}`)) {
    return normalizeWatchKey(relative(root, target));
  }
  return normalizeWatchKey(filePath);
}

function isSuppressedWatchPath(filename: string): boolean {
  const key = normalizeWatchKey(filename);
  const expiresAt = suppressedWatchPaths.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    suppressedWatchPaths.delete(key);
    return false;
  }
  return true;
}

export function suppressRagicDefinitionsWatchPaths(
  filePaths: string[],
  options: { builderRoot?: string; durationMs?: number } = {}
): void {
  const durationMs = Math.max(0, Math.trunc(options.durationMs ?? DEFAULT_SUPPRESS_MS));
  const expiresAt = Date.now() + durationMs;
  const builderRoot = options.builderRoot ?? process.env.RAGIC_BUILDER_PATH ?? "";
  for (const filePath of filePaths) {
    suppressedWatchPaths.set(suppressPathKey(filePath, builderRoot), expiresAt);
  }
}

function isWatchedNuiPath(filename: string): boolean {
  const normalized = filename.trim();
  if (!normalized.toLowerCase().endsWith(".nui")) return false;
  const segments = normalized.toLowerCase().split("/").filter(Boolean);
  if (segments.length === 0) return false;
  return !segments.some(
    (segment) =>
      segment === "history" ||
      segment === "backup" ||
      segment === "backups" ||
      segment === "node_modules" ||
      segment === ".git" ||
      segment.startsWith(".")
  );
}

function defaultWatchRoot(builderRoot: string, listener: WatchListener): FSWatcher {
  return watch(builderRoot, { recursive: true }, listener);
}

export function createRagicDefinitionsWatchService(
  options: RagicDefinitionsWatchServiceOptions = {}
) {
  const builderRoot = String(options.builderRoot ?? process.env.RAGIC_BUILDER_PATH ?? "").trim();
  const debounceMs = Math.max(100, Math.trunc(options.debounceMs ?? DEFAULT_DEBOUNCE_MS));
  const settleMs = Math.max(0, Math.trunc(options.settleMs ?? DEFAULT_SETTLE_MS));
  const reExportService = options.reExportService ?? ragicDefinitionsReExportService;
  const rootExists = options.rootExists ?? existsSync;
  const watchRoot = options.watchRoot ?? defaultWatchRoot;
  const publish =
    options.publish ??
    ((payload: RagicDefinitionsSyncPayload) => {
      publishRagicDefinitionsSyncStatus(payload);
    });

  let watcher: WatchHandle | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  const pendingFiles = new Set<string>();

  function clearDebounce(): void {
    if (!debounceTimer) return;
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  function schedule(): void {
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSync();
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function noteFsEvent(_eventType: string, rawFilename: string | Buffer | null): void {
    const filename = normalizeWatchFilename(rawFilename);
    if (!isWatchedNuiPath(filename)) return;
    if (isSuppressedWatchPath(filename)) return;
    pendingFiles.add(filename);
    schedule();
  }

  async function runSync(): Promise<void> {
    if (inFlight) {
      return inFlight;
    }

    const changedCount = pendingFiles.size;
    pendingFiles.clear();
    if (changedCount === 0) return;

    inFlight = (async () => {
      publish({
        status: "syncing",
        message: "偵測到 Ragic Builder .nui 變更，正在重新匯入 definitions",
        changedCount,
      });
      try {
        if (settleMs > 0) {
          await delay(settleMs);
        }
        const result = await reExportService.reExport();
        publish({
          status: "synced",
          message: result.message,
          changedCount,
          summary: {
            forms: result.summary.forms,
            fields: result.summary.fields,
            formulas: result.summary.formulas,
            workflows: result.summary.workflows,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publish({
          status: "error",
          message: `Ragic definitions 自動重新匯入失敗：${message}`,
          changedCount,
        });
        log.warn({ event: "auto-reexport-failed", error: message });
      } finally {
        inFlight = null;
        if (pendingFiles.size > 0) {
          schedule();
        }
      }
    })();

    return inFlight;
  }

  function start(): boolean {
    if (watcher) return true;
    if (!builderRoot) {
      publish({
        status: "disabled",
        message: "未啟用 Ragic Builder .nui 監看：RAGIC_BUILDER_PATH 未設定",
      });
      log.debug({ event: "disabled", reason: "missing-builder-root" });
      return false;
    }
    if (!rootExists(builderRoot)) {
      publish({
        status: "disabled",
        message: "未啟用 Ragic Builder .nui 監看：RAGIC_BUILDER_PATH 不存在",
      });
      log.warn({ event: "disabled", reason: "builder-root-not-found" });
      return false;
    }

    try {
      watcher = watchRoot(builderRoot, noteFsEvent);
      publish({
        status: "watching",
        message: "正在監看 Ragic Builder .nui 變更",
      });
      log.info({ event: "started" });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publish({
        status: "error",
        message: `Ragic definitions watcher 啟動失敗：${message}`,
      });
      log.warn({ event: "start-failed", error: message });
      return false;
    }
  }

  function stop(): void {
    clearDebounce();
    if (!watcher) return;
    try {
      watcher.close();
    } catch (error) {
      log.warn({
        event: "stop-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    watcher = null;
  }

  return {
    start,
    stop,
  };
}

export type RagicDefinitionsWatchService = ReturnType<
  typeof createRagicDefinitionsWatchService
>;

export const ragicDefinitionsWatchService = createRagicDefinitionsWatchService();

export function startRagicDefinitionsWatch(): boolean {
  return ragicDefinitionsWatchService.start();
}

export function stopRagicDefinitionsWatch(): void {
  ragicDefinitionsWatchService.stop();
}
