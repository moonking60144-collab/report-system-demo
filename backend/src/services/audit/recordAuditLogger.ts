import {
  recordAuditLogRepository,
  type RecordAuditLogInsertInput,
} from "../../storage/sqlite/recordAuditLogRepository";

/**
 * 安全寫入 audit log：絕對不能讓 audit insert 失敗影響本來的 update/delete。
 * 失敗只 log，不 throw。
 */
export async function safeInsertRecordAudit(
  input: RecordAuditLogInsertInput
): Promise<void> {
  try {
    await recordAuditLogRepository.insert(input);
  } catch (error) {
    console.warn("[record-audit-log][insert-failed]", {
      scope: input.scope,
      formId: input.formId,
      entryId: input.entryId,
      rowId: input.rowId ?? null,
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
