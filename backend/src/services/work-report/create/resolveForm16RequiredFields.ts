import { env } from "../../../config/env";
import { ragicClient } from "../../../ragic/client";
import { HttpError } from "../../../utils/httpError";
import { normalizeRows } from "../shared/ragicRowUtils";
import { getFirstFieldValue } from "../shared/subtableUtils";
import { normalizeComparableValue } from "../shared/valueUtils";
import {
  FORM16_FIELD_NAME_CANDIDATES,
  FORM16_REQUIRED_FALLBACK_BY_REPORT_TYPE,
} from "./form16ReportTypeRules";

export async function resolveForm16RequiredFields(
  form16Path: string,
  workOrderNo: string,
  processCode: string,
  reportType: string
): Promise<{ depUnit: string; prodType: string; source: string }> {
  const depFieldId = env.RAGIC_FORM_16_DEP_FIELD_ID;
  const prodTypeFieldId = env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID;
  const processFieldId = env.RAGIC_FORM_16_PROCESS_FIELD_ID;
  const typeFieldId = env.RAGIC_FORM_16_TYPE_FIELD_ID;
  const workOrderFieldId = env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID;

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
    // 使用者 create Form 16 時推導 depUnit/prodType，走 user lane（使用者正在等這個結果）
    const page = await ragicClient.getFormPage(
      form16Path,
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
          getFirstFieldValue(row.data, [depFieldId, ...FORM16_FIELD_NAME_CANDIDATES.depUnit])
        );
        const prodType = normalizeComparableValue(
          getFirstFieldValue(row.data, [
            prodTypeFieldId,
            ...FORM16_FIELD_NAME_CANDIDATES.prodType,
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

  const fallback = FORM16_REQUIRED_FALLBACK_BY_REPORT_TYPE[reportType];
  if (fallback) {
    return {
      depUnit: fallback.depUnit,
      prodType: fallback.prodType,
      source: "reportType-fallback-map",
    };
  }

  throw new HttpError(
    400,
    `無法補齊 [16] 必填欄位 Dep/Prod.Type，請先檢查對應規則：工令=${workOrderNo || "-"}，製程=${processCode || "-"}，報工類別=${reportType || "-"}`,
    "INVALID_PAYLOAD"
  );
}
