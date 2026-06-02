/**
 * In-memory refresh progress（不寫進 SQLite）。
 * Frontend 透過 GET /state 拉到的 progress 欄位讀這個值。
 *
 * 為何不入庫：refresh 期間進度更新非常頻繁（axios onDownloadProgress
 * 一秒可能呼叫幾十次），打進 SQLite 是無謂的 IO；前端 poll 每 1.5s
 * 拉一次，記憶體值剛好同步即可。
 */

export type RefreshPhase = "downloading" | "parsing" | "writing";

export interface RefreshProgress {
  phase: RefreshPhase;
  downloadedBytes: number;
  /** Content-Length 抓不到時 null（顯示 indeterminate）*/
  totalBytes: number | null;
  startedAt: string;
}

export interface ProgressTracker {
  set(next: RefreshProgress | null): void;
  /** 部分更新；downloadedBytes 永遠取大值（避免 retry 時文字回跳）*/
  patch(patch: Partial<RefreshProgress>): void;
  get(): RefreshProgress | null;
  reset(): void;
}

export function createProgressTracker(): ProgressTracker {
  let current: RefreshProgress | null = null;
  return {
    set(next) {
      current = next;
    },
    patch(patch) {
      if (!current) return;
      const merged = { ...current, ...patch };
      // 抓取 retry 時 onDownloadProgress 會 reset loaded=0 → 文字會跳回。
      // pct 在前端有 Math.max(prev, ...) 保護，bytes 文字必須在這裡 monotonic
      if (
        typeof patch.downloadedBytes === "number" &&
        patch.downloadedBytes < current.downloadedBytes
      ) {
        merged.downloadedBytes = current.downloadedBytes;
      }
      current = merged;
    },
    get() {
      return current;
    },
    reset() {
      current = null;
    },
  };
}

// Module-level singleton（生產用）；測試可用 createProgressTracker() 注入獨立 tracker
const defaultTracker = createProgressTracker();

export function setProgress(next: RefreshProgress | null): void {
  defaultTracker.set(next);
}

export function patchProgress(patch: Partial<RefreshProgress>): void {
  defaultTracker.patch(patch);
}

export function getProgress(): RefreshProgress | null {
  return defaultTracker.get();
}

export function resetProgress(): void {
  defaultTracker.reset();
}
