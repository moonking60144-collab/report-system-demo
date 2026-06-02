import { memo } from "react";
import { Pagination } from "antd";
import type { Form16DowntimeRecord } from "../../../api/downtime";
import { DetailInlinePickerTrigger } from "./DetailLinkedPicker";

export interface DowntimeEditDraft {
  date: string;
  machineId: string;
  processCode: string;
  operatorId: string;
  plannedIdleMinutes: string;
  remark: string;
}

export type DowntimeEditPickerKey = "machineId" | "processCode" | "operatorId";

interface WorkReportDowntimeRecordsTableProps {
  loading: boolean;
  records: Form16DowntimeRecord[];
  totalCount: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number, pageSize: number) => void;
  loadingText: string;
  emptyText: string;
  labels: {
    date: string;
    machineId: string;
    processCode: string;
    operator: string;
    reportType: string;
    plannedIdleMinutes: string;
    timeRange: string;
    remark: string;
    entryId: string;
    actions: string;
    edit: string;
    save: string;
    cancel: string;
    delete: string;
    saving: string;
    deleting: string;
    deleteConfirmTitle: string;
    deleteConfirmContent: string;
    deleteConfirmOk: string;
    deleteConfirmCancel: string;
    pickerPlaceholder: string;
  };
  editingRecordId: string | null;
  editingDraft: DowntimeEditDraft | null;
  editBusyRecordId: string | null;
  deletingRecordId: string | null;
  /** options（機台/製程/操作者）還在載入時禁用編輯/刪除，避免 picker 開出來空空 */
  rowActionsDisabled?: boolean;
  resolveOperatorDisplay: (operatorId: string) => string;
  /** 編輯中根據 processCode 即時推算的 reportType；給使用者預覽，實際還是 backend 重算 */
  editingDerivedReportType?: string;
  onEditStart: (record: Form16DowntimeRecord) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onEditFieldChange: (field: keyof DowntimeEditDraft, value: string) => void;
  onEditOpenPicker: (key: DowntimeEditPickerKey) => void;
  onDelete: (record: Form16DowntimeRecord) => void;
}

export const WorkReportDowntimeRecordsTable = memo(function WorkReportDowntimeRecordsTable({
  loading,
  records,
  totalCount,
  page,
  pageSize,
  onPageChange,
  loadingText,
  emptyText,
  labels,
  editingRecordId,
  editingDraft,
  editBusyRecordId,
  deletingRecordId,
  rowActionsDisabled = false,
  resolveOperatorDisplay,
  editingDerivedReportType,
  onEditStart,
  onEditCancel,
  onEditSave,
  onEditFieldChange,
  onEditOpenPicker,
  onDelete,
}: WorkReportDowntimeRecordsTableProps) {
  if (loading && records.length === 0) {
    return <div className="downtime-empty-state">{loadingText}</div>;
  }

  if (totalCount === 0) {
    return <div className="downtime-empty-state">{emptyText}</div>;
  }

  return (
    <div className="downtime-records-section">
      <div className="downtime-record-table-wrap">
        <table className="downtime-record-table">
          <thead>
            <tr>
              <th>{labels.date}</th>
              <th>{labels.machineId}</th>
              <th>{labels.processCode}</th>
              <th>{labels.operator}</th>
              <th>{labels.reportType}</th>
              <th>{labels.plannedIdleMinutes}</th>
              <th>{labels.timeRange}</th>
              <th>{labels.remark}</th>
              <th>{labels.entryId}</th>
              <th>{labels.actions}</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => {
              const isEditing = editingRecordId === record.id && editingDraft !== null;
              const isSaving = editBusyRecordId === record.id;
              const isDeleting = deletingRecordId === record.id;
              const editingOperatorDisplay =
                isEditing && editingDraft?.operatorId
                  ? resolveOperatorDisplay(editingDraft.operatorId)
                  : "";

              return (
                <tr key={record.id} className={isEditing ? "is-editing" : ""}>
                  <td>
                    {isEditing ? (
                      <input
                        type="date"
                        className="downtime-inline-input"
                        value={editingDraft!.date}
                        onChange={(event) =>
                          onEditFieldChange("date", event.target.value)
                        }
                        disabled={isSaving}
                      />
                    ) : (
                      record.date || "-"
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <DetailInlinePickerTrigger
                        value={editingDraft!.machineId}
                        blankLabel={labels.pickerPlaceholder}
                        editorKey={`edit-machine-${record.id}`}
                        onOpen={() => onEditOpenPicker("machineId")}
                        disabled={isSaving}
                      />
                    ) : (
                      record.machineId || "-"
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <DetailInlinePickerTrigger
                        value={editingDraft!.processCode}
                        blankLabel={labels.pickerPlaceholder}
                        editorKey={`edit-process-${record.id}`}
                        onOpen={() => onEditOpenPicker("processCode")}
                        disabled={isSaving}
                      />
                    ) : (
                      record.processCode || "-"
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <DetailInlinePickerTrigger
                        value={
                          editingDraft!.operatorId
                            ? editingOperatorDisplay || editingDraft!.operatorId
                            : ""
                        }
                        blankLabel={labels.pickerPlaceholder}
                        editorKey={`edit-operator-${record.id}`}
                        onOpen={() => onEditOpenPicker("operatorId")}
                        disabled={isSaving}
                      />
                    ) : (
                      <>
                        {record.operatorId || "-"}
                        {record.operatorName ? ` / ${record.operatorName}` : ""}
                      </>
                    )}
                  </td>
                  <td>
                    {isEditing
                      ? editingDerivedReportType || record.reportType || "-"
                      : record.reportType || "-"}
                  </td>
                  <td>
                    {isEditing ? (
                      <input
                        type="number"
                        className="downtime-inline-input downtime-inline-input--narrow"
                        value={editingDraft!.plannedIdleMinutes}
                        onChange={(event) =>
                          onEditFieldChange("plannedIdleMinutes", event.target.value)
                        }
                        min={0}
                        disabled={isSaving}
                      />
                    ) : (
                      record.plannedIdleMinutes ?? "-"
                    )}
                  </td>
                  <td>
                    {record.startTime && record.endTime ? `${record.startTime} - ${record.endTime}` : "-"}
                  </td>
                  <td>
                    {isEditing ? (
                      <input
                        type="text"
                        className="downtime-inline-input"
                        value={editingDraft!.remark}
                        onChange={(event) =>
                          onEditFieldChange("remark", event.target.value)
                        }
                        disabled={isSaving}
                      />
                    ) : (
                      record.remark || "-"
                    )}
                  </td>
                  <td>{record.id}</td>
                  <td className="downtime-record-actions-cell">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          className="downtime-record-action-btn downtime-record-action-btn--primary"
                          onClick={onEditSave}
                          disabled={isSaving}
                        >
                          {isSaving ? (
                            <>
                              <span className="toolbar-btn-spinner" aria-hidden="true" />
                              {labels.saving}
                            </>
                          ) : (
                            labels.save
                          )}
                        </button>
                        <button
                          type="button"
                          className="downtime-record-action-btn"
                          onClick={onEditCancel}
                          disabled={isSaving}
                        >
                          {labels.cancel}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="downtime-record-action-btn"
                          onClick={() => onEditStart(record)}
                          disabled={editingRecordId !== null || isDeleting || rowActionsDisabled}
                        >
                          {labels.edit}
                        </button>
                        <button
                          type="button"
                          className="downtime-record-action-btn downtime-record-action-btn--danger"
                          onClick={() => onDelete(record)}
                          disabled={editingRecordId !== null || isDeleting || rowActionsDisabled}
                        >
                          {isDeleting ? (
                            <>
                              <span
                                className="toolbar-btn-spinner downtime-record-action-spinner--danger"
                                aria-hidden="true"
                              />
                              {labels.deleting}
                            </>
                          ) : (
                            labels.delete
                          )}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="downtime-records-footer">
        <Pagination
          current={page}
          pageSize={pageSize}
          total={totalCount}
          showSizeChanger
          pageSizeOptions={["20", "50", "100"]}
          onChange={onPageChange}
          disabled={loading}
        />
      </div>
    </div>
  );
});
