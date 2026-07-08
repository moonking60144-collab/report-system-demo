import { useEffect, useRef, useState } from "react";
import type {
  RagicFieldRefreshPhase,
  RagicFieldRefreshProgress,
} from "../../../api/devRagicFieldIndex";

interface Props {
  progress: RagicFieldRefreshProgress | null;
  /** inline ("dev-mode" tokens) 或 modal ("ragic-modal" tokens) */
  variant: "inline" | "modal";
  /** parent 在 refresh 完成後保持顯示一段時間 → 設 true 把進度條鎖到 100% / "完成" */
  complete?: boolean;
  /** 顯示「中止」按鈕；點擊時呼叫。falsy 則不顯示 */
  onCancel?: () => void;
  /** 覆蓋 phase label（背景自動更新時不顯示逐相文字，改顯示整體狀態）；complete 時忽略 */
  phaseLabelOverride?: string;
}

const PHASE_LABEL: Record<RagicFieldRefreshPhase, string> = {
  downloading: "下載文件中",
  parsing: "解析欄位",
  writing: "寫入索引",
};

/**
 * 模擬 0%→100%：
 *   - downloading: 0%→70%。有 Content-Length → 用真實比例縮到 0-70；否則時間 asymptotic（τ=8s）
 *   - parsing:    target 88% (有 totalForms 時用比例縮放到 70-88)
 *   - writing:    target 99% (有 totalFields 時用比例縮放到 88-99)
 *   - complete=true: snap to 100%（parent 在 refresh 完成後 linger 一小段時間）
 *
 * 介於 target 之下時用 ease (15%) 緩步爬升，永遠單調遞增（不回退）。
 */
const PHASE_CEIL: Record<RagicFieldRefreshPhase, number> = {
  downloading: 70,
  parsing: 88,
  writing: 99,
};
const PHASE_FLOOR: Record<RagicFieldRefreshPhase, number> = {
  downloading: 0,
  parsing: 70,
  writing: 88,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

function computeTarget(
  progress: RagicFieldRefreshProgress,
  elapsedMs: number
): number {
  const floor = PHASE_FLOOR[progress.phase];
  const ceil = PHASE_CEIL[progress.phase];
  const span = ceil - floor;
  if (progress.phase === "downloading") {
    if (progress.totalBytes && progress.totalBytes > 0) {
      const ratio = progress.downloadedBytes / progress.totalBytes;
      return floor + Math.max(0, Math.min(1, ratio)) * span;
    }
    // 沒 Content-Length：時間 asymptotic
    return floor + span * (1 - Math.exp(-elapsedMs / 8000));
  }
  if (progress.phase === "parsing") {
    if (progress.totalForms && progress.totalForms > 0) {
      const ratio = progress.parsedForms / progress.totalForms;
      return floor + Math.max(0, Math.min(1, ratio)) * span;
    }
    return ceil;
  }
  // writing
  if (progress.totalFields && progress.totalFields > 0) {
    const ratio = progress.writtenFields / progress.totalFields;
    return floor + Math.max(0, Math.min(1, ratio)) * span;
  }
  return ceil;
}

function buildValueLabel(
  progress: RagicFieldRefreshProgress,
  pct: number,
  elapsedMs: number
): string {
  if (progress.phase === "downloading") {
    const speed =
      elapsedMs > 200 && progress.downloadedBytes > 0
        ? progress.downloadedBytes / 1024 / 1024 / (elapsedMs / 1000)
        : null;
    const speedLabel = speed !== null ? `${speed.toFixed(2)} MB/s` : null;
    if (progress.totalBytes && progress.totalBytes > 0) {
      const ratio = progress.downloadedBytes / progress.totalBytes;
      const etaSec =
        speed && ratio > 0 && ratio < 1
          ? Math.max(0, ((1 - ratio) * progress.totalBytes) / 1024 / 1024 / speed)
          : null;
      const etaLabel =
        etaSec !== null ? `ETA ${formatDuration(etaSec * 1000)}` : null;
      const bytesLabel = `${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)} (${pct.toFixed(0)}%)`;
      return [bytesLabel, speedLabel, etaLabel].filter(Boolean).join(" · ");
    }
    if (progress.downloadedBytes > 0) {
      const bytesLabel = `已下載 ${formatBytes(progress.downloadedBytes)} (${pct.toFixed(0)}%)`;
      return [bytesLabel, speedLabel].filter(Boolean).join(" · ");
    }
    return `${pct.toFixed(0)}%`;
  }
  if (progress.phase === "parsing") {
    if (progress.totalForms && progress.totalForms > 0) {
      return `${progress.parsedForms} / ${progress.totalForms} forms`;
    }
    return `${progress.parsedForms} forms`;
  }
  // writing
  if (progress.totalFields && progress.totalFields > 0) {
    return `${progress.writtenFields} / ${progress.totalFields} fields`;
  }
  return `${progress.writtenFields} fields`;
}

/**
 * 注意：parent 應傳 key={progress?.startedAt ?? 'init'} 確保新一輪 refresh 從 0 開始。
 * 本元件不主動 reset state — 內部 pct 單調遞增，靠 remount 重置。
 */
export function RagicRefreshProgress({
  progress,
  variant,
  complete = false,
  onCancel,
  phaseLabelOverride,
}: Props) {
  const [pct, setPct] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const pctRef = useRef(0);

  // useEffect deps 改用 primitives — 避免 progress 物件 reference 每 poll 變動
  // 導致 timer 被無謂地清掉重啟一次。三相 counter 各自取出。
  const phase = progress?.phase ?? null;
  const startedAt = progress?.startedAt ?? null;
  const downloadedBytes =
    progress?.phase === "downloading" ? progress.downloadedBytes : 0;
  const totalBytes =
    progress?.phase === "downloading" ? progress.totalBytes : null;
  const parsedForms =
    progress?.phase === "parsing" ? progress.parsedForms : 0;
  const totalForms = progress?.phase === "parsing" ? progress.totalForms : null;
  const writtenFields =
    progress?.phase === "writing" ? progress.writtenFields : 0;
  const totalFields =
    progress?.phase === "writing" ? progress.totalFields : null;

  useEffect(() => {
    if (!phase || !startedAt) return;
    const startedMs = Date.parse(startedAt);
    let timerId: number | null = null;
    function tick() {
      const elapsed = Math.max(0, Date.now() - startedMs);
      let snapshot: RagicFieldRefreshProgress;
      if (phase === "downloading") {
        snapshot = {
          phase: "downloading",
          downloadedBytes,
          totalBytes,
          startedAt: startedAt!,
        };
      } else if (phase === "parsing") {
        snapshot = {
          phase: "parsing",
          parsedForms,
          totalForms,
          startedAt: startedAt!,
        };
      } else {
        snapshot = {
          phase: "writing",
          writtenFields,
          totalFields,
          startedAt: startedAt!,
        };
      }
      const target = computeTarget(snapshot, elapsed);
      const prev = pctRef.current;
      // Ease toward target — 15% closing per tick + minimal floor 0.4 → 平滑爬升不卡死
      const eased =
        prev + Math.max(0, target - prev) * 0.15 + (target > prev ? 0.4 : 0);
      const next = Math.min(99, Math.max(prev, Math.min(target, eased)));
      pctRef.current = next;
      setPct(next);
      setElapsedMs(elapsed);
    }
    tick();
    timerId = window.setInterval(tick, 150);
    return () => {
      if (timerId !== null) {
        window.clearInterval(timerId);
      }
    };
  }, [
    phase,
    startedAt,
    downloadedBytes,
    totalBytes,
    parsedForms,
    totalForms,
    writtenFields,
    totalFields,
  ]);

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
    : (phaseLabelOverride ??
      (progress ? PHASE_LABEL[progress.phase] : ""));
  const valueLabel = complete
    ? "100%"
    : progress
      ? buildValueLabel(progress, pct, elapsedMs)
      : "";
  const cls = `ragic-progress ragic-progress--${variant}${complete ? " ragic-progress--complete" : ""}`;
  return (
    <div className={cls} role="status" aria-live="polite">
      <div className="ragic-progress__header">
        <span className="ragic-progress__phase">{phaseLabel}</span>
        <span className="ragic-progress__value">{valueLabel}</span>
        {onCancel && !complete ? (
          <button
            type="button"
            className="ragic-progress__cancel"
            onClick={onCancel}
            title="中止本次重新抓取"
          >
            中止
          </button>
        ) : null}
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
