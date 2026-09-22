/**
 * In-memory refresh progress（不寫進 SQLite）。
 * Frontend 透過 GET /state 拉到的 progress 欄位讀這個值。
 *
 * 為何不入庫：refresh 期間進度更新非常頻繁（axios onDownloadProgress
 * 一秒可能呼叫幾十次），打進 SQLite 是無謂的 IO；前端 poll 每 1.5s
 * 拉一次，記憶體值剛好同步即可。
 *
 * 分相設計（discriminated union）：
 *   - phase: 'downloading' → 攜帶 downloadedBytes / totalBytes
 *   - phase: 'parsing'     → 攜帶 parsedForms / totalForms
 *   - phase: 'writing'     → 攜帶 writtenFields / totalFields
 *
 * patch() 只支援同 phase 部分更新（避免「parsing 階段 patch downloadedBytes」
 * 這種型別上能成立但語意錯亂的呼叫）。要切 phase 直接 set() 整包。
 */

import type {
  RagicFieldRefreshProgress,
  RagicFieldRefreshProgressDownloading,
  RagicFieldRefreshProgressParsing,
  RagicFieldRefreshProgressWriting,
} from "../../types/ragicFieldIndex";

export type RefreshPhase = RagicFieldRefreshProgress["phase"];
export type RefreshProgress = RagicFieldRefreshProgress;

export interface ProgressTracker {
  set(next: RefreshProgress | null): void;
  /**
   * 部分更新；只能在相同 phase 內 patch（不同 phase 一律 no-op）。
   *   - downloading 階段：downloadedBytes 取大值（避免 retry 文字回跳）
   *   - parsing 階段：parsedForms 取大值
   *   - writing 階段：writtenFields 取大值
   */
  patch(patch: PatchInput): void;
  get(): RefreshProgress | null;
  reset(): void;
}

export type PatchInput =
  | (Partial<Omit<RagicFieldRefreshProgressDownloading, "phase" | "startedAt">> & {
      phase: "downloading";
    })
  | (Partial<Omit<RagicFieldRefreshProgressParsing, "phase" | "startedAt">> & {
      phase: "parsing";
    })
  | (Partial<Omit<RagicFieldRefreshProgressWriting, "phase" | "startedAt">> & {
      phase: "writing";
    });

export function createProgressTracker(): ProgressTracker {
  let current: RefreshProgress | null = null;
  return {
    set(next) {
      current = next;
    },
    patch(patch) {
      if (!current) return;
      if (current.phase !== patch.phase) return;
      if (current.phase === "downloading" && patch.phase === "downloading") {
        const merged: RagicFieldRefreshProgressDownloading = {
          ...current,
          ...patch,
          phase: "downloading",
        };
        // 抓取 retry 時 onDownloadProgress 會 reset loaded=0 → 文字會跳回。
        // pct 在前端有 Math.max(prev, ...) 保護，bytes 文字必須在這裡 monotonic
        if (
          typeof patch.downloadedBytes === "number" &&
          patch.downloadedBytes < current.downloadedBytes
        ) {
          merged.downloadedBytes = current.downloadedBytes;
        }
        current = merged;
        return;
      }
      if (current.phase === "parsing" && patch.phase === "parsing") {
        const merged: RagicFieldRefreshProgressParsing = {
          ...current,
          ...patch,
          phase: "parsing",
        };
        if (
          typeof patch.parsedForms === "number" &&
          patch.parsedForms < current.parsedForms
        ) {
          merged.parsedForms = current.parsedForms;
        }
        current = merged;
        return;
      }
      if (current.phase === "writing" && patch.phase === "writing") {
        const merged: RagicFieldRefreshProgressWriting = {
          ...current,
          ...patch,
          phase: "writing",
        };
        if (
          typeof patch.writtenFields === "number" &&
          patch.writtenFields < current.writtenFields
        ) {
          merged.writtenFields = current.writtenFields;
        }
        current = merged;
        return;
      }
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

export function patchProgress(patch: PatchInput): void {
  defaultTracker.patch(patch);
}

export function getProgress(): RefreshProgress | null {
  return defaultTracker.get();
}

export function resetProgress(): void {
  defaultTracker.reset();
}
