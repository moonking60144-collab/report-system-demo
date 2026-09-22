import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import { isWorkOrderClosedStatus } from "../utils/workOrderStatus";
import { WorkReportEditableCell } from "./WorkReportEditableCell";

interface WorkReportSortOrderCellProps {
  value: unknown;
  record: WorkReportRecord;
  displayValue: ReactNode;
  onSubmit: (record: WorkReportRecord, sortOrder: number) => Promise<void>;
  syncing?: boolean;
  blocked?: boolean;
}

function toDraftValue(value: unknown): string {
  if (value === null || value === undefined || String(value).trim() === "") {
    return "";
  }
  return String(value).trim();
}

function parseSortOrder(draft: string): number | null {
  const parsed = Number(draft);
  return draft.trim() !== "" && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : null;
}

export function WorkReportSortOrderCell({
  value,
  record,
  displayValue,
  onSubmit,
  syncing = false,
  blocked = false,
}: WorkReportSortOrderCellProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const isClosed = isWorkOrderClosedStatus(record.status);
  return (
    <WorkReportEditableCell
      kind="sort-order"
      value={value}
      record={record}
      displayValue={displayValue}
      disabled={isClosed || blocked || syncing}
      disabledStatusLabel={syncing ? t("table.sortOrderSynchronizing") : undefined}
      toDraft={toDraftValue}
      parseDraft={parseSortOrder}
      onSubmit={onSubmit}
      label={t("table.sortOrderEditorLabel")}
      invalidMessage={t("table.sortOrderInvalid")}
      submittingLabel={t("table.sortOrderSubmitting")}
      saveLabel={t("common:actions.save")}
      cancelLabel={t("common:actions.cancel")}
      editAriaLabel={t("table.sortOrderEditAria", {
        workOrderNo: record.workOrderNo ?? record.id,
      })}
      inputProps={{ type: "number", min: 0, step: 1, inputMode: "numeric" }}
    />
  );
}
