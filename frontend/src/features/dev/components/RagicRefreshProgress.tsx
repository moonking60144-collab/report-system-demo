import { useEffect, useRef, useState } from "react";
import type { RagicFieldRefreshProgress } from "../../../api/devRagicFieldIndex";

interface Props {
  progress: RagicFieldRefreshProgress | null;
  /** inline ("dev-mode" tokens) 或 modal ("ragic-modal" tokens) */
  variant: "inline" | "modal";
  /** parent 在 refresh 完成後保持顯示一段時間 → 設 true 把進度條鎖到 100% / "完成" */
  complete?: boolean;
}

const PHASE_LABEL: Record<RagicFieldRefreshProgress["phase"], string> = {
  downloading: "下載文件中",
  parsing: "解析欄位",
  writing: "寫入索引",
};

/**
 * 模擬 0%→100%：
 *   - downloading: 0%→70%。有 Content-Length → 用真實比例縮到 0-70；否則時間 asymptotic（τ=8s）
 *   - parsing:    target 88%
 *   - writing:    target 99%
 *   - complete=true: snap to 100%（parent 在 refresh 完成後 linger 一小段時間）
 *
 * 介於 target 之下時用 ease (15%) 緩步爬升，永遠單調遞增（不回退）。
 */
const PHASE_CEIL: Record<RagicFieldRefreshProgress["phase"], number> = {
  downloading: 70,
  parsing: 88,
  writing: 99,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function computeTarget(progress: RagicFieldRefreshProgress, elapsedMs: number): number {
  if (progress.phase === "downloading") {
    if (progress.totalBytes && progress.totalBytes > 0) {
      const ratio = progress.downloadedBytes / progress.totalBytes;
      return Math.max(0, Math.min(1, ratio)) * PHASE_CEIL.downloading;
    }
    // 沒 Content-Length：時間 asymptotic，到 8s 約 63%、20s 約 70%
    return PHASE_CEIL.downloading * (1 - Math.exp(-elapsedMs / 8000));
  }
  return PHASE_CEIL[progress.phase];
}

function buildValueLabel(progress: RagicFieldRefreshProgress, pct: number): string {
  if (progress.phase === "downloading") {
    if (progress.totalBytes && progress.totalBytes > 0) {
      return `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)} (${pct.toFixed(0)}%)`;
    }
    if (progress.downloadedBytes > 0) {
      return `已下載 ${formatBytes(progress.downloadedBytes)} (${pct.toFixed(0)}%)`;
    }
    return `${pct.toFixed(0)}%`;
  }
  return `${pct.toFixed(0)}%`;
}

/**
 * 注意：parent 應傳 key={progress?.startedAt ?? 'init'} 確保新一輪 refresh 從 0 開始。
 * 本元件不主動 reset state — 內部 pct 單調遞增，靠 remount 重置。
 */
export function RagicRefreshProgress({ progress, variant, complete = false }: Props) {
  const [pct, setPct] = useState(0);
  const pctRef = useRef(0);

  // useEffect deps 改用 primitives — 避免 progress 物件 reference 每 poll 變動
  // 導致 timer 被無謂地清掉重啟一次
  const phase = progress?.phase ?? null;
  const startedAt = progress?.startedAt ?? null;
  const downloadedBytes = progress?.downloadedBytes ?? 0;
  const totalBytes = progress?.totalBytes ?? null;

  useEffect(() => {
    if (!phase || !startedAt) return;
    const startedMs = Date.parse(startedAt);
    let timerId: number | null = null;
    function tick() {
      const elapsed = Math.max(0, Date.now() - startedMs);
      const snapshot: RagicFieldRefreshProgress = {
        phase: phase!,
        downloadedBytes,
        totalBytes,
        startedAt: startedAt!,
      };
      const target = computeTarget(snapshot, elapsed);
      const prev = pctRef.current;
      // Ease toward target — 15% closing per tick + minimal floor 0.4 → 平滑爬升不卡死
      const eased = prev + Math.max(0, target - prev) * 0.15 + (target > prev ? 0.4 : 0);
      const next = Math.min(99, Math.max(prev, Math.min(target, eased)));
      pctRef.current = next;
      setPct(next);
    }
    tick();
    timerId = window.setInterval(tick, 150);
    return () => {
      if (timerId !== null) {
        window.clearInterval(timerId);
      }
    };
  }, [phase, startedAt, downloadedBytes, totalBytes]);

  // 完成期間：snap pct 到 100；setState in effect 在這裡是必要的（一次性同步）
  useEffect(() => {
    if (complete) {
      pctRef.current = 100;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPct(100);
    }
  }, [complete]);

  if (!progress && !complete) return null;

  const phaseLabel = complete
    ? "完成"
    : progress
      ? PHASE_LABEL[progress.phase]
      : "";
  const valueLabel = complete
    ? "100%"
    : progress
      ? buildValueLabel(progress, pct)
      : "";
  const cls = `ragic-progress ragic-progress--${variant}${complete ? " ragic-progress--complete" : ""}`;
  return (
    <div className={cls} role="status" aria-live="polite">
      <div className="ragic-progress__header">
        <span className="ragic-progress__phase">{phaseLabel}</span>
        <span className="ragic-progress__value">{valueLabel}</span>
      </div>
      <div className="ragic-progress__bar">
        <div
          className="ragic-progress__bar-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
