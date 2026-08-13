import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import type { ColumnDisplayMode } from "../types";
import { parseSemanticBoolean } from "../utils";
import { FixedHorizontalScrollbar } from "./FixedHorizontalScrollbar";

interface WorkReportTableSectionProps {
  columns: ColumnsType<WorkReportRecord>;
  columnDisplayMode: ColumnDisplayMode;
  visibleRecords: WorkReportRecord[];
  pageFrom: number;
  pageTo: number;
  page: number;
  loading: boolean;
  submitting: boolean;
  isHydratingAllRecords: boolean;
  hasMoreForPager: boolean;
  softBusy: boolean;
  softBusyLabel: string | null;
  stickyHeaderOffset: number;
  highlightedEntryId: string | null;
  onPrevPage: () => void;
  onNextPage: () => void;
  onOpenDetail: (entryId: string) => void;
}

const LIST_VIRTUALIZATION_RECORD_THRESHOLD = 40;
const VIRTUAL_TABLE_MIN_HEIGHT = 360;
const VIRTUAL_TABLE_MAX_HEIGHT = 640;
const VIRTUAL_TABLE_RESERVED_HEIGHT = 160;
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
  submitting,
  isHydratingAllRecords,
  hasMoreForPager,
  softBusy,
  softBusyLabel,
  stickyHeaderOffset,
  highlightedEntryId,
  onPrevPage,
  onNextPage,
  onOpenDetail,
}: WorkReportTableSectionProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = visibleRecords.length >= LIST_VIRTUALIZATION_RECORD_THRESHOLD;
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 900 : window.innerHeight
  );
  useEffect(() => {
    if (!shouldVirtualize) {
      return;
    }
    const updateViewportHeight = () => {
      setViewportHeight(window.innerHeight);
    };
    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => {
      window.removeEventListener("resize", updateViewportHeight);
    };
  }, [shouldVirtualize]);
  const virtualScrollHeight = Math.max(
    VIRTUAL_TABLE_MIN_HEIGHT,
    Math.min(
      VIRTUAL_TABLE_MAX_HEIGHT,
      viewportHeight - stickyHeaderOffset - VIRTUAL_TABLE_RESERVED_HEIGHT
    )
  );
  const virtualScrollWidth = useMemo(() => getVirtualScrollWidth(columns), [columns]);
  const horizontalScrollWidth: number | string = shouldVirtualize
    ? columnDisplayMode === "fit"
      ? virtualScrollWidth
      : Math.max(3200, virtualScrollWidth)
    : columnDisplayMode === "fit"
      ? "max-content"
      : 3200;
  const tableScroll = shouldVirtualize
    ? { x: horizontalScrollWidth, y: virtualScrollHeight }
    : { x: horizontalScrollWidth };
  const buildRowClassName = useCallback(
    (record: WorkReportRecord) => {
      const value = parseSemanticBoolean(record.siteRunning);
      const classes = ["clickable-row"];
      if (value === true) {
        classes.push("row-running");
      }
      if (record.status === "已結案") {
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
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (shouldIgnoreRowClick(event)) {
          return;
        }
        onOpenDetail(String(record.id));
      },
    }),
    [onOpenDetail]
  );

  if (visibleRecords.length === 0) {
    return null;
  }

  return (
    <>
      <div
        ref={tableWrapRef}
        className={`table-wrap ${softBusy ? "is-soft-busy" : ""}`}
        aria-busy={softBusy}
      >
        {softBusy && softBusyLabel && (
          <div className="table-soft-busy-overlay" role="status" aria-live="polite">
            {softBusyLabel}
          </div>
        )}
        <Table
          className={`ragic-table ${columnDisplayMode === "fit" ? "is-fit" : ""}`}
          rowKey={(record) => String(record.id)}
          columns={columns}
          dataSource={visibleRecords}
          pagination={false}
          size="small"
          scroll={tableScroll}
          virtual={shouldVirtualize}
          sticky={{ offsetHeader: stickyHeaderOffset, offsetScroll: 8 }}
          rowClassName={buildRowClassName}
          onRow={buildRowProps}
        />
      </div>
      <FixedHorizontalScrollbar tableWrapRef={tableWrapRef} enabled={!shouldVirtualize} />

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
    </>
  );
});
