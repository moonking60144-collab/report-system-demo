import { memo } from "react";

interface Props {
  visible: "down" | "up" | null;
  onJump: () => void;
  backToTopLabel: string;
  backToBottomLabel: string;
}

export const WorkReportDetailScrollHintButton = memo(function WorkReportDetailScrollHintButton({
  visible,
  onJump,
  backToTopLabel,
  backToBottomLabel,
}: Props) {
  if (!visible) {
    return null;
  }

  return (
    <button
      type="button"
      className="detail-scroll-top-btn"
      onClick={onJump}
      aria-label={visible === "up" ? backToTopLabel : backToBottomLabel}
      title={visible === "up" ? backToTopLabel : backToBottomLabel}
    >
      <span
        className={`detail-scroll-chevron detail-scroll-chevron--${visible}`}
        aria-hidden="true"
      />
    </button>
  );
});
