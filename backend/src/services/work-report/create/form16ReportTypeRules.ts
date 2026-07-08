import { HttpError } from "../../../utils/httpError";

export const FORM16_REPORT_TYPE_OPTIONS = new Set<string>([
  "HF鍛造",
  "TI搓牙",
  "3F加工-LM",
  "3F加工-EP",
  "CH人工全檢A",
  "CH機台全檢H",
  "PA包裝",
  "SP備貨",
]);

export const FORM16_FIELD_NAME_CANDIDATES = {
  depUnit: ["Dep.報工單位別"],
  prodType: ["Prod.Type製程大分類代碼"],
} as const;

export const FORM16_REQUIRED_FALLBACK_BY_REPORT_TYPE: Record<
  string,
  { depUnit: string; prodType: string }
> = {
  HF鍛造: { depUnit: "C01鍛造組", prodType: "HF" },
  TI搓牙: { depUnit: "C02搓牙組", prodType: "TI" },
  "3F加工-LM": { depUnit: "C02搓牙組", prodType: "TI" },
  "3F加工-EP": { depUnit: "C02搓牙組", prodType: "TI" },
  CH機台全檢H: { depUnit: "Q03全檢組", prodType: "CH" },
  CH人工全檢A: { depUnit: "D02倉儲組", prodType: "PA" },
  PA包裝: { depUnit: "D02倉儲組", prodType: "PA" },
  SP備貨: { depUnit: "D02倉儲組", prodType: "PA" },
};

export function mapProcessCodeToReportType(processCode: string): string | null {
  const normalized = processCode.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("HF")) {
    return "HF鍛造";
  }
  if (normalized.startsWith("LM")) {
    return "3F加工-LM";
  }
  if (normalized.startsWith("EP")) {
    return "3F加工-EP";
  }
  if (normalized.startsWith("PA")) {
    return "PA包裝";
  }
  if (normalized.startsWith("SP")) {
    return "SP備貨";
  }
  if (normalized.startsWith("CH")) {
    return "CH人工全檢A";
  }
  if (
    normalized.startsWith("TI") ||
    normalized.startsWith("WP") ||
    normalized.startsWith("BU")
  ) {
    return "TI搓牙";
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
