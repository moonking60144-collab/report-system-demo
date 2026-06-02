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
  ENTRY_EDIT_LOCKED: "workReport:errors.codes.entryEditLocked",
  NOTICE_TOKEN_MISSING: "workReport:errors.codes.noticeTokenMissing",
  NOTICE_TOKEN_INVALID: "workReport:errors.codes.noticeTokenInvalid",
  NOTICE_LOGIN_INVALID: "workReport:errors.codes.noticeLoginInvalid",
  INTERNAL_SERVER_ERROR: "workReport:errors.codes.internalServerError",
};

function translateErrorCode(errorCode: unknown): string | null {
  if (typeof errorCode !== "string") {
    return null;
  }
  const key = ERROR_CODE_TRANSLATION_MAP[errorCode];
  if (!key) {
    return null;
  }
  return i18n.t(key);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const errorCode = error.response?.data?.error?.code;
    const errorMessage = error.response?.data?.error?.message ?? error.message;
    if (errorCode === "ENTRY_EDIT_LOCKED" && typeof errorMessage === "string" && errorMessage.trim()) {
      return errorMessage.trim();
    }
    return translateErrorCode(errorCode) ?? errorMessage;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return i18n.t("common:states.unknownError", { defaultValue: "發生未知錯誤" });
}
