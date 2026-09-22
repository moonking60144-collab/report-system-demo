import { HttpError } from "../../../utils/httpError";

export const ACTIVITY_LOG_REPORT_TYPE_OPTIONS = new Set<string>([
  "PROC-A",
  "PROC-B",
  "PROC-C",
  "PROC-D",
  "PROC-QA-MANUAL",
  "PROC-QA-MACHINE",
  "PROC-PACK",
  "PROC-STOCK",
]);

export const ACTIVITY_LOG_FIELD_NAME_CANDIDATES = {
  depUnit: ["demo_department_group"],
  prodType: ["demo_prod_type"],
} as const;

export const ACTIVITY_LOG_REQUIRED_FALLBACK_BY_REPORT_TYPE: Record<
  string,
  { depUnit: string; prodType: string }
> = {
  "PROC-A": { depUnit: "P01加工一組", prodType: "PA" },
  "PROC-B": { depUnit: "P02加工二組", prodType: "PB" },
  "PROC-C": { depUnit: "P01加工一組", prodType: "PC" },
  "PROC-D": { depUnit: "P02加工二組", prodType: "PD" },
  "PROC-QA-MANUAL": { depUnit: "P03檢驗組", prodType: "QA" },
  "PROC-QA-MACHINE": { depUnit: "P03檢驗組", prodType: "QA" },
  "PROC-PACK": { depUnit: "P04物流組", prodType: "PK" },
  "PROC-STOCK": { depUnit: "P04物流組", prodType: "ST" },
};

export function mapProcessCodeToReportType(processCode: string): string | null {
  const normalized = processCode.trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("A")) {
    return "PROC-A";
  }
  if (normalized.startsWith("B")) {
    return "PROC-B";
  }
  if (normalized.startsWith("C")) {
    return "PROC-C";
  }
  if (normalized.startsWith("D")) {
    return "PROC-D";
  }
  if (normalized.startsWith("PK")) {
    return "PROC-PACK";
  }
  if (normalized.startsWith("ST")) {
    return "PROC-STOCK";
  }
  if (normalized.startsWith("QA")) {
    return "PROC-QA-MANUAL";
  }
  return null;
}

export function resolveActivityLogReportType(
  workOrderNo: string,
  processCode: string,
  requestedReportType: string
): { type: string; source: string } {
  if (requestedReportType) {
    if (ACTIVITY_LOG_REPORT_TYPE_OPTIONS.has(requestedReportType)) {
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
    `無法推導 [activity] 報工類別(Type)，工令=${workOrderNo}，製程=${processCode || "-"}`,
    "INVALID_PAYLOAD"
  );
}
