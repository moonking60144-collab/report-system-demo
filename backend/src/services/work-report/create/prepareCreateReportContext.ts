import { env, resolveWritePath } from "../../../config/env";
import { RagicRecord } from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { ReportWritePayload } from "../../../types/workReport";
import { HttpError } from "../../../utils/httpError";
import {
  collectSubtableRows,
  getFirstFieldValue,
  SubtableRow,
} from "../shared/subtableUtils";
import { isEmptyValue } from "../shared/valueUtils";

export interface ResolvedForm16ReportType {
  type: string;
  source: string;
}

export interface ResolvedForm16RequiredFields {
  depUnit: string;
  prodType: string;
  source: string;
}

export interface PrepareCreateReportContextParams {
  config: FormConfig;
  entryId: string;
  beforeEntry?: RagicRecord;
  beforeRows?: SubtableRow[];
  workOrderNo?: string;
  normalizedPayload: ReportWritePayload;
  subtableRowData: RagicRecord;
  resolveForm16ReportType: (
    workOrderNo: string,
    processCode: string,
    requestedReportType: string
  ) => Promise<ResolvedForm16ReportType>;
  resolveForm16RequiredFields: (
    form16Path: string,
    workOrderNo: string,
    processCode: string,
    reportType: string
  ) => Promise<ResolvedForm16RequiredFields>;
}

export interface PreparedCreateReportContext {
  beforeRows: SubtableRow[];
  beforeRowIds: Set<string>;
  workOrderNo: string;
  form16WritePath: string;
  processCodeForType: string;
  requestedReportType: string;
  resolvedReportType: ResolvedForm16ReportType;
  resolvedRequiredFields: ResolvedForm16RequiredFields;
  form16CreateBody: RagicRecord;
}

export async function prepareCreateReportContext(
  params: PrepareCreateReportContextParams
): Promise<PreparedCreateReportContext> {
  const {
    config,
    entryId: _entryId,
    beforeEntry,
    beforeRows: providedBeforeRows,
    workOrderNo: providedWorkOrderNo,
    normalizedPayload,
    subtableRowData,
    resolveForm16ReportType,
    resolveForm16RequiredFields,
  } = params;
  void _entryId;

  const beforeRows = providedBeforeRows ??
    (beforeEntry
      ? collectSubtableRows(beforeEntry[config.writeConfig.subtableId])
      : []);
  const beforeRowIds = new Set(beforeRows.map((row) => row.rowId));
  const workOrderNoValue =
    providedWorkOrderNo ??
    (beforeEntry
      ? getFirstFieldValue(beforeEntry, [
          config.mainFieldFallbacks?.workOrderNo ?? "",
          config.mainFields.workOrderNo,
        ])
      : undefined);
  if (isEmptyValue(workOrderNoValue)) {
    throw new HttpError(400, "找不到工令單號，無法從 [16] 建立明細", "INVALID_WORK_ORDER");
  }
  const workOrderNo = String(workOrderNoValue).trim();

  const form16WritePath = resolveWritePath("16", env.RAGIC_FORM_16_PATH);
  if (!form16WritePath) {
    throw new HttpError(
      503,
      "寫回目標尚未就緒，請先設定 [16] 測試表單路徑",
      "WRITE_TARGET_NOT_READY"
    );
  }

  const processCodeForType = String(normalizedPayload.processCode ?? "").trim();
  const requestedReportType =
    typeof normalizedPayload.reportType === "string"
      ? normalizedPayload.reportType.trim()
      : "";
  const resolvedReportType = await resolveForm16ReportType(
    workOrderNo,
    processCodeForType,
    requestedReportType
  );
  const resolvedRequiredFields = await resolveForm16RequiredFields(
    form16WritePath,
    workOrderNo,
    processCodeForType,
    resolvedReportType.type
  );

  // form 104/105 subtableWriteFields.remark (e.g. 1017751) is not a valid field in form 16.
  // Strip it from subtableRowData and remap to the form 16 remark field ID instead.
  const subtableRemarkFieldId = config.writeConfig.subtableWriteFields.remark;
  const subtableWithoutRemark: RagicRecord = { ...subtableRowData };
  if (subtableRemarkFieldId) {
    delete subtableWithoutRemark[subtableRemarkFieldId];
  }

  const form16CreateBody: RagicRecord = {
    ...subtableWithoutRemark,
    [env.RAGIC_FORM_16_WORK_ORDER_FIELD_ID]: workOrderNo,
    [env.RAGIC_FORM_16_TYPE_FIELD_ID]: resolvedReportType.type,
    [env.RAGIC_FORM_16_DEP_FIELD_ID]: resolvedRequiredFields.depUnit,
    [env.RAGIC_FORM_16_PROD_TYPE_FIELD_ID]: resolvedRequiredFields.prodType,
  };

  if (!isEmptyValue(normalizedPayload.remark) && env.RAGIC_FORM_16_REMARK_FIELD_ID) {
    form16CreateBody[env.RAGIC_FORM_16_REMARK_FIELD_ID] = normalizedPayload.remark;
  }

  return {
    beforeRows,
    beforeRowIds,
    workOrderNo,
    form16WritePath,
    processCodeForType,
    requestedReportType,
    resolvedReportType,
    resolvedRequiredFields,
    form16CreateBody,
  };
}
