import { memo } from "react";

interface Props {
  detailRecordsCountText: string;
  batchCreateEditingText: string | null;
  editingText: string | null;
  focusedColHint: string | null;
}

export const WorkReportDetailTableSummaryBar = memo(function WorkReportDetailTableSummaryBar({
  detailRecordsCountText,
  batchCreateEditingText,
  editingText,
  focusedColHint,
}: Props) {
  return (
    <div className="detail-table-head-summary">
      <strong>{detailRecordsCountText}</strong>
      {batchCreateEditingText ? (
        <span className="detail-editing-pill" role="status" aria-live="polite">
          {batchCreateEditingText}
        </span>
      ) : editingText ? (
        <span className="detail-editing-pill" role="status" aria-live="polite">
          {editingText}
        </span>
      ) : null}
      {focusedColHint ? (
        <span className="detail-focus-hint" role="status" aria-live="polite">
          {focusedColHint}
        </span>
      ) : null}
    </div>
  );
});
