import { memo } from "react";

interface Labels {
  save: string;
  saving: string;
  cancel: string;
  clearAll: string;
}

interface Props {
  submitting: boolean;
  labels: Labels;
  onSaveBatchCreate: () => void;
  onCancelBatchCreate: () => void;
  onClearBatchCreate: () => void;
}

export const WorkReportDetailBatchCreateActions = memo(function WorkReportDetailBatchCreateActions({
  submitting,
  labels,
  onSaveBatchCreate,
  onCancelBatchCreate,
  onClearBatchCreate,
}: Props) {
  return (
    <>
      <button
        type="button"
        className="detail-batch-create-save-btn"
        onClick={onSaveBatchCreate}
        disabled={submitting}
      >
        {submitting ? labels.saving : labels.save}
      </button>
      <button
        type="button"
        className="detail-batch-create-cancel-btn"
        onClick={onCancelBatchCreate}
        disabled={submitting}
      >
        {labels.cancel}
      </button>
      <button
        type="button"
        className="detail-clear-btn"
        onClick={onClearBatchCreate}
        disabled={submitting}
      >
        {labels.clearAll}
      </button>
    </>
  );
});
