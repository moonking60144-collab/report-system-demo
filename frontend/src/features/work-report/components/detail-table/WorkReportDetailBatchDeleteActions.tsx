import { memo } from "react";

interface Labels {
  selectAllOnPage: string;
  clearSelection: string;
  batchDeleteAction: string;
  cancel: string;
}

interface State {
  allBatchDeleteRowsSelected: boolean;
  selectedBatchDeleteCount: number;
  loading: boolean;
  refreshing: boolean;
  submitting: boolean;
}

interface Props {
  state: State;
  labels: Labels;
  onToggleSelectAll: () => void;
  onClearSelection: () => void;
  onHandleBatchDelete: () => void;
  onCancelBatchDeleteMode: () => void;
}

export const WorkReportDetailBatchDeleteActions = memo(function WorkReportDetailBatchDeleteActions({
  state,
  labels,
  onToggleSelectAll,
  onClearSelection,
  onHandleBatchDelete,
  onCancelBatchDeleteMode,
}: Props) {
  const { allBatchDeleteRowsSelected, selectedBatchDeleteCount, loading, refreshing, submitting } = state;
  return (
    <>
      <button
        type="button"
        onClick={onToggleSelectAll}
        disabled={loading || refreshing || submitting}
      >
        {allBatchDeleteRowsSelected
          ? labels.clearSelection
          : labels.selectAllOnPage}
      </button>
      <button
        type="button"
        onClick={onClearSelection}
        disabled={selectedBatchDeleteCount === 0}
      >
        {labels.clearSelection}
      </button>
      <button
        type="button"
        className="detail-delete-btn"
        onClick={onHandleBatchDelete}
        disabled={selectedBatchDeleteCount === 0 || loading || refreshing || submitting}
      >
        {labels.batchDeleteAction}
      </button>
      <button type="button" onClick={onCancelBatchDeleteMode}>
        {labels.cancel}
      </button>
    </>
  );
});
