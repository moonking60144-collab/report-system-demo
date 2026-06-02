import { HttpError } from "../../../utils/httpError";

export const FORM16_REPORT_TYPE_OPTIONS = new Set<string>([
  "HF-Forge",
  "TI-ProcessA",
  "PROC-LM",
  "PROC-EP",
  "CH-ManualInspect",
  "CH-MachineInspect",
  "PA-Pack",
  "SP-Stock",
]);

export const FORM16_FIELD_NAME_CANDIDATES = {
  depUnit: ["Dep.報工單位別"],
  prodType: ["Prod.Type製程大分類代碼"],
} as const;

export const FORM16_REQUIRED_FALLBACK_BY_REPORT_TYPE: Record<
  string,
  { depUnit: string; prodType: string }
> = {
  "HF-Forge": { depUnit: "DEPT-FORGE", prodType: "HF" },
  "TI-ProcessA": { depUnit: "DEPT-PROCA", prodType: "TI" },
  "PROC-LM": { depUnit: "DEPT-PROCA", prodType: "TI" },
  "PROC-EP": { depUnit: "DEPT-PROCA", prodType: "TI" },
  "CH-MachineInspect": { depUnit: "DEPT-QC", prodType: "CH" },
  "CH-ManualInspect": { depUnit: "DEPT-WAREHOUSE", prodType: "PA" },
  "PA-Pack": { depUnit: "DEPT-WAREHOUSE", prodType: "PA" },
  "SP-Stock": { depUnit: "DEPT-WAREHOUSE", prodType: "PA" },
};

export function mapProcessCodeToReportType(processCode: string): string | null {
  const normalized = processCode.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("HF")) {
    return "HF-Forge";
  }
  if (normalized.startsWith("LM")) {
    return "PROC-LM";
  }
  if (normalized.startsWith("EP")) {
    return "PROC-EP";
  }
  if (normalized.startsWith("PA")) {
    return "PA-Pack";
  }
  if (normalized.startsWith("SP")) {
    return "SP-Stock";
  }
  if (normalized.startsWith("CH")) {
    return "CH-ManualInspect";
  }
  if (
    normalized.startsWith("TI") ||
    normalized.startsWith("WP") ||
    normalized.startsWith("BU")
  ) {
    return "TI-ProcessA";
  }
  return null;
}

export function resolveForm16ReportType(
  workOrderNo: string,
  processCode: string,
  requestedReportType: string
): { type: string; source: string } {
  if (requestedReportType) {
    if (FORM16_REPORT_TYPE_OPTIONS.has(requestedReportType)) {
      return {
        type: requestedReportType,
        source: "payload",
      };
    }
    throw new HttpError(400, `報工類別無效：${requestedReportType}`, "INVALID_PAYLOAD");
  }

  const mappedType = mapProcessCodeToReportType(processCode);
  if (mappedType) {
    return {
      type: mappedType,
      source: "process-mapping",
    };
  }
  throw new HttpError(
    400,
    `無法推導 [16] 報工類別(Type)，工令=${workOrderNo}，製程=${processCode || "-"}`,
    "INVALID_PAYLOAD"
  );
}
