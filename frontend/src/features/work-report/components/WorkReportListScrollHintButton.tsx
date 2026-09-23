import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { WorkReportDetailScrollHintButton } from "./detail-table/WorkReportDetailScrollHintButton";

interface WorkReportListScrollHintButtonProps {
  enabled: boolean;
  tableWrapRef: RefObject<HTMLDivElement | null>;
  rebindKey: string;
}

type ScrollHintDirection = "down" | "up" | null;

function findTableScroller(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(
    ".ant-table-tbody-virtual-holder, .ant-table-body"
  );
}

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
    const tableScroller = wrapper ? findTableScroller(wrapper) : null;
    if (!enabled || !wrapper || !outerScroller || !tableScroller) {
      return;
    }

    const compute = () => {
      const outerMax = Math.max(0, outerScroller.scrollHeight - outerScroller.clientHeight);
      const tableMax = Math.max(0, tableScroller.scrollHeight - tableScroller.clientHeight);
      const totalMax = outerMax + tableMax;
      if (totalMax <= 40) {
        setDirection(null);
        return;
      }
      const totalTop = outerScroller.scrollTop + tableScroller.scrollTop;
      setDirection(totalTop / totalMax < 0.5 ? "down" : "up");
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
    observer.observe(tableScroller);
    outerScroller.addEventListener("scroll", scheduleCompute, { passive: true });
    tableScroller.addEventListener("scroll", scheduleCompute, { passive: true });
    window.addEventListener("resize", scheduleCompute);
    compute();
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      observer.disconnect();
      outerScroller.removeEventListener("scroll", scheduleCompute);
      tableScroller.removeEventListener("scroll", scheduleCompute);
      window.removeEventListener("resize", scheduleCompute);
    };
  }, [enabled, rebindKey, tableWrapRef]);

  const handleJump = useCallback(() => {
    const wrapper = tableWrapRef.current;
    const outerScroller = wrapper?.closest<HTMLElement>(".ragic-list-main");
    const tableScroller = wrapper ? findTableScroller(wrapper) : null;
    if (!outerScroller || !tableScroller || !direction) return;

    const toBottom = direction === "down";
    outerScroller.scrollTo({
      top: toBottom ? outerScroller.scrollHeight : 0,
      behavior: "smooth",
    });
    if (toBottom && tableScroller.matches(".ant-table-body")) {
      tableScroller.addEventListener("scrollend", () => {
        if (tableWrapRef.current?.contains(tableScroller)) {
          const remaining = tableScroller.scrollHeight - tableScroller.clientHeight - tableScroller.scrollTop;
          // Page-size changes can settle the final body height a few pixels after scrolling starts.
          if (remaining > 0 && remaining <= 4) {
            tableScroller.scrollTop = tableScroller.scrollHeight;
          }
        }
      }, { once: true });
    }
    tableScroller.scrollTo({
      top: toBottom ? tableScroller.scrollHeight : 0,
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
