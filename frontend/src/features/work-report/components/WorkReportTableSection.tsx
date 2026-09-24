import { memo, useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import type { ColumnDisplayMode } from "../types";
import type { MarkedWorkOrder } from "../hooks/useWorkReportMarkedRow";
import { isWorkOrderClosedStatus, parseSemanticBoolean } from "../utils";
import {
  BackgroundLoadingIndicator,
  PageLoadingBoundary,
} from "../../../components/PageLoadingBoundary";
import { FixedHorizontalScrollbar } from "./FixedHorizontalScrollbar";
import { WorkReportRowMarkMenu } from "./WorkReportRowMarkMenu";
import { WorkReportListScrollHintButton } from "./WorkReportListScrollHintButton";

interface WorkReportTableSectionProps {
  columns: ColumnsType<WorkReportRecord>;
  columnDisplayMode: ColumnDisplayMode;
  visibleRecords: WorkReportRecord[];
  backgroundLoading: boolean;
  error: string | null;
  hasRenderableContent: boolean;
  softBusy: boolean;
  softBusyLabel: string | null;
  highlightedEntryId: string | null;
  markedRow: MarkedWorkOrder | null;
  onToggleMarkedRow: (record: WorkReportRecord) => void;
  showScrollHintButton?: boolean;
  onOpenDetail: (entryId: string) => void;
  onPreloadDetail: () => void;
  onRetry: () => void;
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
  backgroundLoading,
  error,
  hasRenderableContent,
  softBusy,
  softBusyLabel,
  highlightedEntryId,
  markedRow,
  onToggleMarkedRow,
  showScrollHintButton = false,
  onOpenDetail,
  onPreloadDetail,
  onRetry,
}: WorkReportTableSectionProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const hasTableContent = hasRenderableContent && visibleRecords.length > 0;
  const [toolbarHeight, setToolbarHeight] = useState(0);
  useEffect(() => {
    const toolbar = tableWrapRef.current?.closest(".work-report-list-workspace")
      ?.querySelector<HTMLElement>(".work-report-workspace-toolbar");
    if (!toolbar) return;
    const updateHeight = () => setToolbarHeight(toolbar.getBoundingClientRect().height);
    const observer = new ResizeObserver(updateHeight);
    observer.observe(toolbar);
    updateHeight();
    return () => observer.disconnect();
  }, [hasTableContent]);
  const getStickyContainer = useCallback(
    () => tableWrapRef.current?.closest<HTMLElement>(".ragic-list-main") ?? document.body,
    []
  );
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
      if (String(record.id) === markedRow?.entryId) {
        classes.push("row-marked");
      }
      return classes.join(" ");
    },
    [highlightedEntryId, markedRow]
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

  return (
    <section className="work-report-table-stage">
      <WorkReportRowMarkMenu records={visibleRecords}
        markedEntryId={markedRow?.entryId ?? null} onToggleMarkedRow={onToggleMarkedRow}>
      <div
        ref={tableWrapRef}
        className={`table-wrap ${softBusy ? "is-soft-busy" : ""}`}
        aria-busy={showAnyLoading}
      >
        {softBusy && softBusyLabel && (
          <div className="table-soft-busy-overlay">
            <BackgroundLoadingIndicator label={softBusyLabel} />
          </div>
        )}
        <Table
          className={`ragic-table ${columnDisplayMode === "fit" ? "is-fit" : ""}`}
          rowKey={(record) => String(record.id)}
          columns={columns}
          dataSource={visibleRecords}
          pagination={false}
          size="small"
          scroll={{ x: columnDisplayMode === "fit" ? "max-content" : 3200 }}
          sticky={{ offsetHeader: toolbarHeight, getContainer: getStickyContainer }}
          rowClassName={buildRowClassName}
          onRow={buildRowProps}
        />
      </div>
      </WorkReportRowMarkMenu>

      <FixedHorizontalScrollbar
        tableWrapRef={tableWrapRef}
        endInset={showScrollHintButton ? 72 : 0}
      />
      <WorkReportListScrollHintButton
        enabled={showScrollHintButton}
        tableWrapRef={tableWrapRef}
        rebindKey={String(visibleRecords.length)}
      />
    </section>
  );
});
