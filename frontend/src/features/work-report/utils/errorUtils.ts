import { AxiosError } from "axios";
import i18n from "../../../i18n";

const ERROR_CODE_TRANSLATION_MAP: Record<string, string> = {
  RAGIC_WRITE_FAILED: "workReport:errors.codes.ragicWriteFailed",
  RAGIC_ACTION_BUTTON_FAILED: "workReport:errors.codes.ragicActionButtonFailed",
  REPORT_NOT_FOUND: "workReport:errors.codes.reportNotFound",
  TASK_NOT_FOUND: "workReport:errors.codes.taskNotFound",
  FORM_NOT_SUPPORTED: "workReport:errors.codes.formNotSupported",
  FORM_NOT_CONFIGURED: "workReport:errors.codes.formNotConfigured",
  INVALID_PAYLOAD: "workReport:errors.codes.invalidPayload",
  INVALID_ROW_ID: "workReport:errors.codes.invalidRowId",
  INVALID_OPERATOR_ID: "workReport:errors.codes.invalidOperatorId",
  INVALID_OPERATOR_MAPPING: "workReport:errors.codes.invalidOperatorMapping",
  ENTRY_CONFLICT: "workReport:errors.codes.entryConflict",
  ENTRY_STATUS_UNKNOWN: "workReport:errors.codes.entryStatusUnknown",
  ENTRY_EDIT_LOCKED: "workReport:errors.codes.entryEditLocked",
  CLIENT_MUTATION_ID_REQUIRED: "workReport:errors.codes.clientMutationIdRequired",
  BATCH_CREATE_PAYLOAD_INVALID: "workReport:errors.codes.batchCreatePayloadInvalid",
  BATCH_CREATE_ROWS_REQUIRED: "workReport:errors.codes.batchCreateRowsRequired",
  BATCH_CREATE_EMPTY: "workReport:errors.codes.batchCreateRowsRequired",
  BATCH_CREATE_ROW_KEY_REQUIRED: "workReport:errors.codes.batchCreateRowKeyRequired",
  BATCH_CREATE_ROW_KEY_STORE_UNAVAILABLE: "workReport:errors.codes.batchCreateRowKeyStoreUnavailable",
  BATCH_CREATE_ROW_KEY_CONFLICT: "workReport:errors.codes.batchCreateRowKeyConflict",
  BATCH_CREATE_ROW_KEY_RECORD_FAILED: "workReport:errors.codes.batchCreateRowKeyRecordFailed",
  BATCH_CREATE_ROW_INDETERMINATE: "workReport:errors.codes.batchCreateRowIndeterminate",
  BATCH_CREATE_ROW_FINALIZE_FAILED: "workReport:errors.codes.batchCreateRowFinalizeFailed",
  BATCH_CREATE_FINALIZE_RETRY_UNAVAILABLE: "workReport:errors.codes.batchCreateFinalizeRetryUnavailable",
  BATCH_CREATE_PARTIAL_FAILURE: "workReport:errors.codes.batchCreatePartialFailure",
  TASK_RECOVERED_AFTER_RESTART: "workReport:errors.codes.taskRecoveredAfterRestart",
  TASK_REGISTRY_RECOVERED_AFTER_RESTART: "workReport:errors.codes.taskRecoveredAfterRestart",
  NOTICE_TOKEN_MISSING: "workReport:errors.codes.noticeTokenMissing",
  NOTICE_TOKEN_INVALID: "workReport:errors.codes.noticeTokenInvalid",
  NOTICE_LOGIN_INVALID: "workReport:errors.codes.noticeLoginInvalid",
  INTERNAL_SERVER_ERROR: "workReport:errors.codes.internalServerError",
};

interface WorkReportTaskErrorLike {
  errorCode?: string | null;
  errorMessage?: string | null;
  message?: string | null;
  error?: {
    code?: string | null;
    message?: string | null;
  } | null;
}

const GENERIC_HTTP_STATUS_MESSAGE_PATTERN = /^request failed with status code \d+$/i;

export function translateWorkReportErrorCode(errorCode: unknown): string | null {
  if (typeof errorCode !== "string") {
    return null;
  }
  const key = ERROR_CODE_TRANSLATION_MAP[errorCode];
  if (!key) {
    return null;
  }
  return i18n.t(key);
}

function replaceKnownErrorCodes(text: string): string {
  return Object.keys(ERROR_CODE_TRANSLATION_MAP).reduce((nextText, code) => {
    if (!nextText.includes(code)) {
      return nextText;
    }
    const translatedCode = translateWorkReportErrorCode(code);
    return translatedCode ? nextText.replaceAll(code, translatedCode) : nextText;
  }, text);
}

function normalizeErrorText(value: unknown): string {
  return typeof value === "string" ? replaceKnownErrorCodes(value.trim()) : "";
}

export function getWorkReportTaskErrorMessage(task: WorkReportTaskErrorLike): string {
  const errorCode = task.errorCode ?? task.error?.code ?? null;
  const translatedCode = translateWorkReportErrorCode(errorCode);
  const rawMessage =
    normalizeErrorText(task.errorMessage) ||
    normalizeErrorText(task.error?.message) ||
    normalizeErrorText(task.message);

  if (translatedCode && (!rawMessage || GENERIC_HTTP_STATUS_MESSAGE_PATTERN.test(rawMessage))) {
    return translatedCode;
  }
  return rawMessage || translatedCode || "";
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const errorCode = error.response?.data?.error?.code;
    const rawMessage = error.response?.data?.error?.message;
    // backend 已附具體原因（如 Ragic 拒絕訊息）時優先顯示；缺訊息或只是通用
    // HTTP 字串才退回錯誤碼翻譯——與 getWorkReportTaskErrorMessage 同一準則
    if (
      typeof rawMessage === "string" &&
      rawMessage.trim() &&
      !GENERIC_HTTP_STATUS_MESSAGE_PATTERN.test(rawMessage.trim())
    ) {
      return rawMessage.trim();
    }
    return translateWorkReportErrorCode(errorCode) ?? rawMessage ?? error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return i18n.t("common:states.unknownError", { defaultValue: "發生未知錯誤" });
}
