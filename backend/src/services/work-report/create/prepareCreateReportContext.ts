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

export interface ResolvedActivityLogReportType {
  type: string;
  source: string;
}

export interface ResolvedActivityLogRequiredFields {
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
  resolveActivityLogReportType: (
    workOrderNo: string,
    processCode: string,
    requestedReportType: string
  ) => Promise<ResolvedActivityLogReportType>;
  resolveActivityLogRequiredFields: (
    activityLogPath: string,
    workOrderNo: string,
    processCode: string,
    reportType: string
  ) => Promise<ResolvedActivityLogRequiredFields>;
}

export interface PreparedCreateReportContext {
  beforeRows: SubtableRow[];
  beforeRowIds: Set<string>;
  workOrderNo: string;
  activityLogWritePath: string;
  processCodeForType: string;
  requestedReportType: string;
  resolvedReportType: ResolvedActivityLogReportType;
  resolvedRequiredFields: ResolvedActivityLogRequiredFields;
  activityLogCreateBody: RagicRecord;
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
    resolveActivityLogReportType,
    resolveActivityLogRequiredFields,
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
    throw new HttpError(400, "找不到工令單號，無法從 [activity] 建立明細", "INVALID_WORK_ORDER");
  }
  const workOrderNo = String(workOrderNoValue).trim();

  const activityLogWritePath = resolveWritePath("903", env.UPSTREAM_ACTIVITY_LOG_PATH);
  if (!activityLogWritePath) {
    throw new HttpError(
      503,
      "寫回目標尚未就緒，請先設定 [activity] 測試表單路徑",
      "WRITE_TARGET_NOT_READY"
    );
  }

  const processCodeForType = String(normalizedPayload.processCode ?? "").trim();
  const requestedReportType =
    typeof normalizedPayload.reportType === "string"
      ? normalizedPayload.reportType.trim()
      : "";
  const resolvedReportType = await resolveActivityLogReportType(
    workOrderNo,
    processCodeForType,
    requestedReportType
  );
  const resolvedRequiredFields = await resolveActivityLogRequiredFields(
    activityLogWritePath,
    workOrderNo,
    processCodeForType,
    resolvedReportType.type
  );

  // form 901/902 subtableWriteFields.remark (e.g. 9001077) is not a valid field in activity log.
  // Strip it from subtableRowData and remap to the activity log remark field ID instead.
  const subtableRemarkFieldId = config.writeConfig.subtableWriteFields.remark;
  const subtableWithoutRemark: RagicRecord = { ...subtableRowData };
  if (subtableRemarkFieldId) {
    delete subtableWithoutRemark[subtableRemarkFieldId];
  }
  const activityLogCreateBody: RagicRecord = {
    ...subtableWithoutRemark,
    [env.UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID]: workOrderNo,
    [env.UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID]: resolvedReportType.type,
    [env.UPSTREAM_ACTIVITY_LOG_DEP_FIELD_ID]: resolvedRequiredFields.depUnit,
    [env.UPSTREAM_ACTIVITY_LOG_PROD_TYPE_FIELD_ID]: resolvedRequiredFields.prodType,
  };

  if (!isEmptyValue(normalizedPayload.remark) && env.UPSTREAM_ACTIVITY_LOG_REMARK_FIELD_ID) {
    activityLogCreateBody[env.UPSTREAM_ACTIVITY_LOG_REMARK_FIELD_ID] = normalizedPayload.remark;
  }

  return {
    beforeRows,
    beforeRowIds,
    workOrderNo,
    activityLogWritePath,
    processCodeForType,
    requestedReportType,
    resolvedReportType,
    resolvedRequiredFields,
    activityLogCreateBody,
  };
}
