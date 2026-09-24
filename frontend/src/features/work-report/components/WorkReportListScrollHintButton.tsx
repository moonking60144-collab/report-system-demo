import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { WorkReportDetailScrollHintButton } from "./detail-table/WorkReportDetailScrollHintButton";

interface WorkReportListScrollHintButtonProps {
  enabled: boolean;
  tableWrapRef: RefObject<HTMLDivElement | null>;
  rebindKey: string;
}

type ScrollHintDirection = "down" | "up" | null;

export const WorkReportListScrollHintButton = memo(function WorkReportListScrollHintButton({
  enabled,
  tableWrapRef,
  rebindKey,
}: WorkReportListScrollHintButtonProps) {
  const { t } = useTranslation("workReport");
  const [direction, setDirection] = useState<ScrollHintDirection>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const wrapper = tableWrapRef.current;
    const outerScroller = wrapper?.closest<HTMLElement>(".ragic-list-main");
    if (!enabled || !wrapper || !outerScroller) {
      return;
    }

    const compute = () => {
      const outerMax = Math.max(0, outerScroller.scrollHeight - outerScroller.clientHeight);
      if (outerMax <= 40) {
        setDirection(null);
        return;
      }
      setDirection(outerScroller.scrollTop / outerMax < 0.5 ? "down" : "up");
    };
    const scheduleCompute = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        compute();
      });
    };
    const observer = new ResizeObserver(scheduleCompute);
    observer.observe(wrapper);
    observer.observe(outerScroller);
    outerScroller.addEventListener("scroll", scheduleCompute, { passive: true });
    window.addEventListener("resize", scheduleCompute);
    compute();
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      observer.disconnect();
      outerScroller.removeEventListener("scroll", scheduleCompute);
      window.removeEventListener("resize", scheduleCompute);
    };
  }, [enabled, rebindKey, tableWrapRef]);

  const handleJump = useCallback(() => {
    const wrapper = tableWrapRef.current;
    const outerScroller = wrapper?.closest<HTMLElement>(".ragic-list-main");
    if (!outerScroller || !direction) return;

    const toBottom = direction === "down";
    outerScroller.scrollTo({
      top: toBottom ? outerScroller.scrollHeight : 0,
      behavior: "smooth",
    });
  }, [direction, tableWrapRef]);

  return (
    <WorkReportDetailScrollHintButton
      visible={enabled ? direction : null}
      onJump={handleJump}
      backToTopLabel={t("detailPage.backToTop")}
      backToBottomLabel={t("detailPage.backToBottom")}
    />
  );
});
