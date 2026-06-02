import type { FormOptionItem, WorkReportRecord } from "../../../api/workReport";
import {
  REPORT_TYPE_VALUE,
  SHIFT_TYPE_ALIAS_TO_CANONICAL,
} from "../constants";

export function inferReportTypeFromProcessCode(processCode: string): string {
  const normalized = processCode.trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("HF")) {
    return REPORT_TYPE_VALUE.HF_FORGING;
  }
  if (normalized.startsWith("LM")) {
    return REPORT_TYPE_VALUE.PROCESSING_LM;
  }
  if (normalized.startsWith("EP")) {
    return REPORT_TYPE_VALUE.PROCESSING_EP;
  }
  if (normalized.startsWith("PA")) {
    return REPORT_TYPE_VALUE.PACKAGING;
  }
  if (normalized.startsWith("SP")) {
    return REPORT_TYPE_VALUE.STOCK_PREP;
  }
  if (normalized.startsWith("CH")) {
    return REPORT_TYPE_VALUE.MANUAL_INSPECTION_A;
  }
  if (
    normalized.startsWith("TI") ||
    normalized.startsWith("WP") ||
    normalized.startsWith("BU")
  ) {
    return REPORT_TYPE_VALUE.TI_THREAD_ROLLING;
  }
  return "";
}

function parseRowIdForSort(rowId: string | undefined): number {
  if (!rowId) {
    return Number.MIN_SAFE_INTEGER;
  }
  const parsed = Number(rowId);
  return Number.isFinite(parsed) ? parsed : Number.MIN_SAFE_INTEGER;
}

export function inferOperatorDefaultByMachine(
  machineId: string,
  machineOptions: FormOptionItem[] = []
): {
  operatorId?: string;
  operatorName?: string;
  processCode?: string;
  reportType?: string;
} {
  const normalizedMachineId = machineId.trim();
  if (!normalizedMachineId) {
    return {};
  }

  const machineOption = machineOptions.find(
    (option) => option.value.trim() === normalizedMachineId
  );
  if (!machineOption?.machineDefault) {
    return {};
  }

  const machineDefaultStatus = machineOption.machineDefault.status?.trim();
  if (machineDefaultStatus !== "使用中") {
    return {};
  }

  const operatorId = machineOption.machineDefault.mainOperatorId?.trim();
  const operatorName = machineOption.machineDefault.mainOperatorName?.trim();
  const processCode = machineOption.machineDefault.processCode?.trim();
  const reportType = processCode
    ? inferReportTypeFromProcessCode(processCode)
    : undefined;

  if (!operatorId && !operatorName && !processCode && !reportType) {
    return {};
  }

  return {
    operatorId: operatorId || undefined,
    operatorName: operatorName || undefined,
    processCode: processCode || undefined,
    reportType,
  };
}

export function inferOperatorDefaultSelection(
  operatorId: string,
  entryContext?: WorkReportRecord | null,
  machineOptions: FormOptionItem[] = []
): {
  processCode?: string;
  machineId?: string;
  reportType?: string;
} {
  const normalizedOperatorId = operatorId.trim();
  if (!normalizedOperatorId) {
    return {};
  }

  const reports = entryContext?.reports ?? [];
  if (reports.length > 0) {
    const matchedRows = reports
      .filter((row) => String(row.operatorId ?? "").trim() === normalizedOperatorId)
      .sort((a, b) => parseRowIdForSort(b.rowId) - parseRowIdForSort(a.rowId));

    if (matchedRows.length > 0) {
      const latest = matchedRows[0];
      const processCode = String(latest.processCode ?? "").trim();
      const machineId = String(latest.machineId ?? "").trim();
      const reportType = String(latest.reportType ?? "").trim();

      return {
        processCode: processCode || undefined,
        machineId: machineId || undefined,
        reportType:
          reportType || (processCode ? inferReportTypeFromProcessCode(processCode) : undefined),
      };
    }
  }

  return inferEntryMachineDefaultSelection(entryContext, machineOptions);
}

export function resolveMachineOptionByMachineCode(
  machineCode: string,
  machineOptions: FormOptionItem[] = []
): FormOptionItem | null {
  const normalizedMachineCode = String(machineCode ?? "").trim();
  if (!normalizedMachineCode) {
    return null;
  }

  const directMachineOption = machineOptions.find(
    (option) => option.value.trim() === normalizedMachineCode
  );
  if (directMachineOption) {
    return directMachineOption;
  }

  return (
    machineOptions.find(
      (option) => option.machineDefault?.machineCode?.trim() === normalizedMachineCode
    ) ?? null
  );
}

export function inferEntryMachineDefaultSelection(
  entryContext?: WorkReportRecord | null,
  machineOptions: FormOptionItem[] = []
): {
  processCode?: string;
  machineId?: string;
  reportType?: string;
} {
  const machineCode = String(entryContext?.machineCode ?? "").trim();
  if (!machineCode) {
    return {};
  }

  const machineOption = resolveMachineOptionByMachineCode(machineCode, machineOptions);
  if (!machineOption) {
    return {};
  }

  const processCode = machineOption.machineDefault?.processCode?.trim();

  return {
    machineId: machineOption.value.trim() || undefined,
    processCode: processCode || undefined,
    reportType: processCode ? inferReportTypeFromProcessCode(processCode) : undefined,
  };
}

export function normalizeShiftTypeValue(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return SHIFT_TYPE_ALIAS_TO_CANONICAL[trimmed] ?? trimmed;
}
