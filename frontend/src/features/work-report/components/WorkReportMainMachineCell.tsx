import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FormOptionItem, WorkReportRecord } from "../../../api/workReport";
import { isWorkOrderClosedStatus } from "../utils/workOrderStatus";
import { WorkReportEditableCell } from "./WorkReportEditableCell";

interface WorkReportMainMachineCellProps {
  value: unknown;
  record: WorkReportRecord;
  displayValue: ReactNode;
  options: FormOptionItem[];
  onSubmit: (record: WorkReportRecord, machineCode: string) => Promise<void>;
  syncing?: boolean;
  blocked?: boolean;
}

export function WorkReportMainMachineCell({
  value,
  record,
  displayValue,
  options,
  onSubmit,
  syncing = false,
  blocked = false,
}: WorkReportMainMachineCellProps) {
  const { t } = useTranslation(["workReport", "common"]);
  const isClosed = isWorkOrderClosedStatus(record.status);
  return (
    <WorkReportEditableCell
      kind="main-machine"
      value={value}
      record={record}
      displayValue={displayValue}
      disabled={isClosed || blocked || syncing}
      disabledStatusLabel={
        syncing ? t("workReport:table.mainMachineSynchronizing") : undefined
      }
      toDraft={(currentValue) => String(currentValue ?? "").trim()}
      parseDraft={(draft) => draft.trim() || null}
      isUnchanged={(machineCode, currentValue) =>
        machineCode === String(currentValue ?? "").trim()
      }
      onSubmit={onSubmit}
      label={t("workReport:table.mainMachineEditorLabel")}
      invalidMessage={t("workReport:table.mainMachineInvalid")}
      submittingLabel={t("workReport:table.mainMachineSubmitting")}
      saveLabel={t("common:actions.save")}
      cancelLabel={t("common:actions.cancel")}
      editAriaLabel={t("workReport:table.mainMachineEditAria", {
        workOrderNo: record.workOrderNo ?? record.id,
      })}
      inputProps={{ type: "text", autoComplete: "off" }}
      options={options.map((option) => ({
        value: option.value,
        label: option.display || option.label,
      }))}
    />
  );
}
