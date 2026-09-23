import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import type { ColumnDisplayMode } from "../types";
import { isWorkOrderClosedStatus, parseSemanticBoolean } from "../utils";
import {
  BackgroundLoadingIndicator,
  PageLoadingBoundary,
} from "../../../components/PageLoadingBoundary";
import { FixedHorizontalScrollbar } from "./FixedHorizontalScrollbar";
import { WorkReportListScrollHintButton } from "./WorkReportListScrollHintButton";

interface WorkReportTableSectionProps {
  columns: ColumnsType<WorkReportRecord>;
  columnDisplayMode: ColumnDisplayMode;
  visibleRecords: WorkReportRecord[];
  pageFrom: number;
  pageTo: number;
  page: number;
  loading: boolean;
  backgroundLoading: boolean;
  error: string | null;
  hasRenderableContent: boolean;
  submitting: boolean;
  isHydratingAllRecords: boolean;
  hasMoreForPager: boolean;
  softBusy: boolean;
  softBusyLabel: string | null;
  highlightedEntryId: string | null;
  showScrollHintButton?: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  onOpenDetail: (entryId: string) => void;
  onPreloadDetail: () => void;
  onRetry: () => void;
}

const LIST_VIRTUALIZATION_RECORD_THRESHOLD = 40;
const VIRTUAL_COLUMN_FALLBACK_WIDTH = 120;

function getVirtualScrollWidth(columns: ColumnsType<WorkReportRecord>): number {
  return columns.reduce((total, column) => {
    const width = "width" in column && typeof column.width === "number"
      ? column.width
      : VIRTUAL_COLUMN_FALLBACK_WIDTH;
    return total + width;
  }, 0);
}

function shouldIgnoreRowClick(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("button, a, input, select, textarea, [role='button']"));
}

export const WorkReportTableSection = memo(function WorkReportTableSection({
  columns,
  columnDisplayMode,
  visibleRecords,
  pageFrom,
  pageTo,
  page,
  loading,
  backgroundLoading,
  error,
  hasRenderableContent,
  submitting,
  isHydratingAllRecords,
  hasMoreForPager,
  softBusy,
  softBusyLabel,
  highlightedEntryId,
  showScrollHintButton = false,
  onPrevPage,
  onNextPage,
  onOpenDetail,
  onPreloadDetail,
  onRetry,
}: WorkReportTableSectionProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = visibleRecords.length >= LIST_VIRTUALIZATION_RECORD_THRESHOLD;
  const [tableBodyHeight, setTableBodyHeight] = useState(400);
  const [hasContainedScrollbar, setHasContainedScrollbar] = useState(false);
  useEffect(() => {
    const wrapper = tableWrapRef.current;
    const stage = wrapper?.closest<HTMLElement>(".work-report-table-stage");
    const outerScroller = stage?.closest<HTMLElement>(".ragic-list-main");
    const managedViewport = wrapper?.closest(".work-report-viewport");
    if (!stage || !outerScroller || !managedViewport) {
      return;
    }

    let frame = 0;
    const update = () => {
      const outerRect = outerScroller.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const nextHeight = Math.max(1, Math.floor(outerScroller.clientHeight));
      const nextDocked = stageRect.top <= outerRect.top + 1;
      stage.style.setProperty("--work-report-focus-height", `${nextHeight}px`);
      stage.classList.toggle("is-focus-docked", nextDocked);
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const handOffWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tableScroller = target.closest<HTMLElement>(
        ".ant-table-body, .ant-table-tbody-virtual-holder"
      );
      if (!tableScroller) return;
      const outerMaxScrollTop = Math.max(0, outerScroller.scrollHeight - outerScroller.clientHeight);
      const shouldMoveOuterDown = event.deltaY > 0 && outerScroller.scrollTop < outerMaxScrollTop - 1;
      const shouldMoveOuterUp = event.deltaY < 0 && tableScroller.scrollTop <= 0 && outerScroller.scrollTop > 0;
      if (!shouldMoveOuterDown && !shouldMoveOuterUp) return;
      event.preventDefault();
      event.stopPropagation();
      outerScroller.scrollTop = Math.max(
        0,
        Math.min(outerMaxScrollTop, outerScroller.scrollTop + event.deltaY)
      );
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(outerScroller);
    observer.observe(stage);
    outerScroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    stage.addEventListener("wheel", handOffWheel, { passive: false, capture: true });
    window.addEventListener("resize", scheduleUpdate);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      outerScroller.removeEventListener("scroll", scheduleUpdate);
      stage.removeEventListener("wheel", handOffWheel, true);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, []);
  useEffect(() => {
    const wrapper = tableWrapRef.current;
    if (!wrapper) return;
    let frame = 0;
    const measure = () => {
      const header = wrapper.querySelector<HTMLElement>(".ant-table-header");
      const scrollbar = wrapper.querySelector<HTMLElement>(
        ".fixed-h-scrollbar-shell.is-contained:not(.is-hidden)"
      );
      const available = wrapper.closest(".work-report-viewport")
        ? wrapper.clientHeight
        : window.innerHeight - wrapper.getBoundingClientRect().top - 64;
      setTableBodyHeight(Math.max(1, Math.floor(
        available - (header?.offsetHeight ?? 0) - (scrollbar?.offsetHeight ?? 0) - 2
      )));
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(wrapper);
    const header = wrapper.querySelector<HTMLElement>(".ant-table-header");
    if (header) observer.observe(header);
    window.addEventListener("resize", scheduleMeasure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [hasRenderableContent, shouldVirtualize, hasContainedScrollbar]);
  const virtualScrollWidth = useMemo(() => getVirtualScrollWidth(columns), [columns]);
  const horizontalScrollWidth: number | string = shouldVirtualize
    ? columnDisplayMode === "fit"
      ? virtualScrollWidth
      : Math.max(3200, virtualScrollWidth)
    : columnDisplayMode === "fit"
      ? "max-content"
      : 3200;
  const tableScroll = { x: horizontalScrollWidth, y: tableBodyHeight };
  const buildRowClassName = useCallback(
    (record: WorkReportRecord) => {
      const value = parseSemanticBoolean(record.siteRunning);
      const classes = ["clickable-row"];
      if (value === true) {
        classes.push("row-running");
      }
      if (isWorkOrderClosedStatus(record.status)) {
        classes.push("row-closed");
      }
      if (highlightedEntryId && String(record.id) === highlightedEntryId) {
        classes.push("row-return-highlight");
      }
      return classes.join(" ");
    },
    [highlightedEntryId]
  );
  const buildRowProps = useCallback(
    (record: WorkReportRecord) => ({
      onMouseEnter: onPreloadDetail,
      onFocus: onPreloadDetail,
      onPointerDown: onPreloadDetail,
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (shouldIgnoreRowClick(event)) {
          return;
        }
        onOpenDetail(String(record.id));
      },
    }),
    [onOpenDetail, onPreloadDetail]
  );

  if (!hasRenderableContent) {
    if (!error) {
      return (
        <PageLoadingBoundary
          variant="section"
          state={{ kind: "pending", message: t("common:states.loadingData") }}
        />
      );
    }
    return (
      <PageLoadingBoundary
        variant="section"
        state={{
          kind: "error",
          title: t("common:states.loadFailedTitle"),
          message: t("workReport:status.loadFailed", { error }),
          action: {
            label: t("common:actions.retry"),
            onClick: onRetry,
          },
        }}
      />
    );
  }

  if (visibleRecords.length === 0) {
    return null;
  }

  const showAnyLoading = backgroundLoading || softBusy;
  const backgroundLoadingLabel =
    softBusyLabel || t("common:states.backgroundLoading");

  return (
    <section className="work-report-table-stage">
      <div
        ref={tableWrapRef}
        className={`table-wrap ${softBusy ? "is-soft-busy" : ""}`}
        style={{ "--work-report-table-body-height": `${tableBodyHeight}px` } as CSSProperties}
        aria-busy={showAnyLoading}
      >
        {softBusy && (
          <div className="table-soft-busy-overlay">
            <BackgroundLoadingIndicator label={backgroundLoadingLabel} />
          </div>
        )}
        {backgroundLoading && !softBusy ? (
          <div className="table-background-loading-indicator">
            <BackgroundLoadingIndicator label={backgroundLoadingLabel} />
          </div>
        ) : null}
        <Table
          className={`ragic-table ${columnDisplayMode === "fit" ? "is-fit" : ""}`}
          rowKey={(record) => String(record.id)}
          columns={columns}
          dataSource={visibleRecords}
          pagination={false}
          size="small"
          scroll={tableScroll}
          virtual={shouldVirtualize}
          rowClassName={buildRowClassName}
          onRow={buildRowProps}
        />
        <FixedHorizontalScrollbar
          tableWrapRef={tableWrapRef}
          enabled={!shouldVirtualize}
          placement="contained"
          onVisibilityChange={setHasContainedScrollbar}
        />
      </div>

      <div className="pager">
        <span>{t("common:pager.showingRange", { from: pageFrom, to: pageTo })}</span>
        <div className="pager-actions">
          <button type="button" onClick={onPrevPage} disabled={loading || submitting || isHydratingAllRecords || page <= 1}>
            {t("common:pager.prev")}
          </button>
          <span>{t("common:pager.page", { page })}</span>
          <button
            type="button"
            onClick={onNextPage}
            disabled={loading || submitting || isHydratingAllRecords || !hasMoreForPager}
          >
            {t("common:pager.next")}
          </button>
        </div>
      </div>
      <WorkReportListScrollHintButton
        enabled={showScrollHintButton}
        tableWrapRef={tableWrapRef}
        rebindKey={`${shouldVirtualize}:${visibleRecords.length}`}
      />
    </section>
  );
});
