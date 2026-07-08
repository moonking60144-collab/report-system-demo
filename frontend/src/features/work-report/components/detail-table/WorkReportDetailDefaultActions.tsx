import { memo } from "react";

interface Labels {
  refresh: string;
  taskQueue: string;
  changeMainMachine: string;
  manualClose: string;
  manualReopen: string;
  addDetail: string;
  batchDeleteButton: string;
  saving: string;
}

interface State {
  disableRefresh: boolean;
  disableTaskQueue: boolean;
  disableMainMachine: boolean;
  disableBatchDelete: boolean;
  disableClose: boolean;
  disableReopen: boolean;
  disableAddDetail: boolean;
  isRecordClosed: boolean;
  workOrderClosing: boolean;
}

interface Props {
  state: State;
  labels: Labels;
  onRefresh: () => void;
  onOpenTaskQueue: () => void;
  onOpenMainMachineModal: () => void;
  onManualClose: () => void;
  onManualReopen: () => void;
  onOpenCreateModal: () => void;
  onEnterBatchDeleteMode: () => void;
}

export const WorkReportDetailDefaultActions = memo(function WorkReportDetailDefaultActions({
  state,
  labels,
  onRefresh,
  onOpenTaskQueue,
  onOpenMainMachineModal,
  onManualClose,
  onManualReopen,
  onOpenCreateModal,
  onEnterBatchDeleteMode,
}: Props) {
  return (
    <>
      <button
        type="button"
        onClick={onRefresh}
        disabled={state.disableRefresh}
      >
        {labels.refresh}
      </button>
      <button
        type="button"
        className="detail-page-task-btn"
        onClick={onOpenTaskQueue}
        disabled={state.disableTaskQueue}
      >
        {labels.taskQueue}
      </button>
      <button
        type="button"
        className={`detail-delete-btn${state.isRecordClosed ? " is-locked" : ""}`}
        onClick={onEnterBatchDeleteMode}
        disabled={state.disableBatchDelete}
      >
        {labels.batchDeleteButton}
      </button>
      <button
        type="button"
        className={state.isRecordClosed ? "is-locked" : undefined}
        onClick={onOpenMainMachineModal}
        disabled={state.disableMainMachine}
      >
        {labels.changeMainMachine}
      </button>
      {state.isRecordClosed ? (
        <button
          type="button"
          className="detail-page-reopen-btn"
          onClick={onManualReopen}
          disabled={state.disableReopen}
        >
          {state.workOrderClosing ? labels.saving : labels.manualReopen}
        </button>
      ) : (
        <button
          type="button"
          className="detail-page-close-btn"
          onClick={onManualClose}
          disabled={state.disableClose}
        >
          {state.workOrderClosing ? labels.saving : labels.manualClose}
        </button>
      )}
      <button
        type="button"
        className={`detail-page-primary-btn${state.isRecordClosed ? " is-locked" : ""}`}
        onClick={onOpenCreateModal}
        disabled={state.disableAddDetail}
      >
        {labels.addDetail}
      </button>
    </>
  );
});
