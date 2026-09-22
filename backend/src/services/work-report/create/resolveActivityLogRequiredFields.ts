import { env } from "../../../config/env";
import { ragicClient } from "../../../ragic/client";
import { HttpError } from "../../../utils/httpError";
import { normalizeRows } from "../shared/ragicRowUtils";
import { getFirstFieldValue } from "../shared/subtableUtils";
import { normalizeComparableValue } from "../shared/valueUtils";
import {
  ACTIVITY_LOG_FIELD_NAME_CANDIDATES,
  ACTIVITY_LOG_REQUIRED_FALLBACK_BY_REPORT_TYPE,
} from "./activityLogReportTypeRules";

interface ResolvedActivityLogRequiredFields {
  depUnit: string;
  prodType: string;
  source: string;
}

const REQUIRED_FIELDS_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUIRED_FIELDS_CACHE_MAX_ENTRIES = 500;

const requiredFieldsCache = new Map<
  string,
  { expiresAt: number; value: ResolvedActivityLogRequiredFields }
>();
const requiredFieldsInFlight = new Map<string, Promise<ResolvedActivityLogRequiredFields>>();

export async function resolveActivityLogRequiredFields(
  activityLogPath: string,
  workOrderNo: string,
  processCode: string,
  reportType: string
): Promise<ResolvedActivityLogRequiredFields> {
  const cacheKey = buildRequiredFieldsCacheKey(
    activityLogPath,
    workOrderNo,
    processCode,
    reportType
  );
  const cached = getCachedRequiredFields(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = requiredFieldsInFlight.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = resolveActivityLogRequiredFieldsUncached(
    activityLogPath,
    workOrderNo,
    processCode,
    reportType
  )
    .then((result) => {
      setCachedRequiredFields(cacheKey, result);
      return result;
    })
    .finally(() => {
      if (requiredFieldsInFlight.get(cacheKey) === request) {
        requiredFieldsInFlight.delete(cacheKey);
      }
    });

  requiredFieldsInFlight.set(cacheKey, request);
  return request;
}

export function clearActivityLogRequiredFieldsCache(): void {
  requiredFieldsCache.clear();
  requiredFieldsInFlight.clear();
}

async function resolveActivityLogRequiredFieldsUncached(
  activityLogPath: string,
  workOrderNo: string,
  processCode: string,
  reportType: string
): Promise<ResolvedActivityLogRequiredFields> {
  const fallback = ACTIVITY_LOG_REQUIRED_FALLBACK_BY_REPORT_TYPE[reportType];
  if (fallback) {
    return {
      depUnit: fallback.depUnit,
      prodType: fallback.prodType,
      source: "reportType-fallback-map",
    };
  }

  const depFieldId = env.UPSTREAM_ACTIVITY_LOG_DEP_FIELD_ID;
  const prodTypeFieldId = env.UPSTREAM_ACTIVITY_LOG_PROD_TYPE_FIELD_ID;
  const processFieldId = env.UPSTREAM_ACTIVITY_LOG_PROCESS_FIELD_ID;
  const typeFieldId = env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID;
  const workOrderFieldId = env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID;

  const whereCandidates: Array<{ where: string; source: string }> = [];
  if (processCode) {
    whereCandidates.push({
      where: `${processFieldId},eq,${processCode}`,
      source: "processCode-history",
    });
  }
  if (reportType) {
    whereCandidates.push({
      where: `${typeFieldId},eq,${reportType}`,
      source: "reportType-history",
    });
  }
  if (workOrderNo) {
    whereCandidates.push({
      where: `${workOrderFieldId},eq,${workOrderNo}`,
      source: "workOrder-history",
    });
  }

  for (const candidate of whereCandidates) {
    // 使用者 create activity log 時推導 depUnit/prodType，走 user lane（使用者正在等這個結果）
    const page = await ragicClient.getFormPage(
      activityLogPath,
      {
        limit: 200,
        offset: 0,
        where: candidate.where,
      },
      false,
      { priority: "user" }
    );
    const rows = normalizeRows(page)
      .map((row) => {
        const depUnit = normalizeComparableValue(
          getFirstFieldValue(row.data, [depFieldId, ...ACTIVITY_LOG_FIELD_NAME_CANDIDATES.depUnit])
        );
        const prodType = normalizeComparableValue(
          getFirstFieldValue(row.data, [
            prodTypeFieldId,
            ...ACTIVITY_LOG_FIELD_NAME_CANDIDATES.prodType,
          ])
        );
        return {
          entryId: row.entryId,
          depUnit,
          prodType,
        };
      })
      .filter((row) => row.depUnit && row.prodType)
      .sort((a, b) => Number(b.entryId) - Number(a.entryId));

    if (rows.length > 0) {
      return {
        depUnit: rows[0].depUnit,
        prodType: rows[0].prodType,
        source: candidate.source,
      };
    }
  }

  throw new HttpError(
    400,
    `無法補齊 [activity] 必填欄位 Dep/Prod.Type，請先檢查對應規則：工令=${workOrderNo || "-"}，製程=${processCode || "-"}，報工類別=${reportType || "-"}`,
    "INVALID_PAYLOAD"
  );
}

function buildRequiredFieldsCacheKey(
  activityLogPath: string,
  workOrderNo: string,
  processCode: string,
  reportType: string
): string {
  return [
    normalizeComparableValue(activityLogPath),
    normalizeComparableValue(workOrderNo),
    normalizeComparableValue(processCode),
    normalizeComparableValue(reportType),
  ].join("\0");
}

function getCachedRequiredFields(cacheKey: string): ResolvedActivityLogRequiredFields | null {
  const cached = requiredFieldsCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    requiredFieldsCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function setCachedRequiredFields(
  cacheKey: string,
  value: ResolvedActivityLogRequiredFields
): void {
  if (!requiredFieldsCache.has(cacheKey) && requiredFieldsCache.size >= REQUIRED_FIELDS_CACHE_MAX_ENTRIES) {
    const oldestKey = requiredFieldsCache.keys().next().value;
    if (oldestKey) {
      requiredFieldsCache.delete(oldestKey);
    }
  }
  requiredFieldsCache.set(cacheKey, {
    expiresAt: Date.now() + REQUIRED_FIELDS_CACHE_TTL_MS,
    value,
  });
}
