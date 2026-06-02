import { memo, useCallback, useRef, type MouseEvent } from "react";
import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import { parseSemanticBoolean } from "../utils";
import { FixedHorizontalScrollbar } from "./FixedHorizontalScrollbar";

interface WorkReportTableSectionProps {
  columns: ColumnsType<WorkReportRecord>;
  columnDisplayMode: "compact" | "fit" | "full";
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
  highlightedEntryId: string | null;
  onPrevPage: () => void;
  onNextPage: () => void;
  onOpenDetail: (entryId: string) => void;
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
  highlightedEntryId,
  onPrevPage,
  onNextPage,
  onOpenDetail,
}: WorkReportTableSectionProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const horizontalScrollWidth: number | string =
    columnDisplayMode === "fit" ? "max-content" : 3200;
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
          scroll={{ x: horizontalScrollWidth }}
          sticky={{ offsetHeader: 0, offsetScroll: 8 }}
          rowClassName={buildRowClassName}
          onRow={buildRowProps}
        />
      </div>
      <FixedHorizontalScrollbar tableWrapRef={tableWrapRef} />

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
