import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { WorkReportRecord } from "../../../api/workReport";
import { normalizePlannedEndDate } from "../utils/plannedEndDateUtils";
import { isWorkOrderClosedStatus } from "../utils/workOrderStatus";
import { WorkReportEditableCell } from "./WorkReportEditableCell";

interface WorkReportPlannedEndDateCellProps {
  value: unknown;
  record: WorkReportRecord;
  displayValue: ReactNode;
  onSubmit: (record: WorkReportRecord, plannedEndDate: string) => Promise<void>;
  syncing?: boolean;
  blocked?: boolean;
}

function parsePlannedEndDate(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && normalizePlannedEndDate(value) === value
    ? value
    : null;
}

export function WorkReportPlannedEndDateCell({
  value,
  record,
  displayValue,
  onSubmit,
  syncing = false,
  blocked = false,
}: WorkReportPlannedEndDateCellProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const isClosed = isWorkOrderClosedStatus(record.status);
  return (
    <WorkReportEditableCell
      kind="planned-end-date"
      value={value}
      record={record}
      displayValue={displayValue}
      disabled={isClosed || blocked || syncing}
      disabledStatusLabel={
        syncing ? t("workReport:table.plannedEndDateSynchronizing") : undefined
      }
      toDraft={(currentValue) => normalizePlannedEndDate(currentValue) ?? ""}
      parseDraft={parsePlannedEndDate}
      isUnchanged={(date, currentValue) =>
        date === (normalizePlannedEndDate(currentValue) ?? "")
      }
      onSubmit={onSubmit}
      label={t("workReport:table.plannedEndDateEditorLabel")}
      invalidMessage={t("workReport:table.plannedEndDateInvalid")}
      submittingLabel={t("workReport:table.plannedEndDateSubmitting")}
      saveLabel={t("common:actions.save")}
      cancelLabel={t("common:actions.cancel")}
      editAriaLabel={t("workReport:table.plannedEndDateEditAria", {
        workOrderNo: record.workOrderNo ?? record.id,
      })}
      inputProps={{ type: "date", min: "1900-01-01", max: "9999-12-31" }}
    />
  );
}
