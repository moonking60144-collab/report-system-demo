import { AxiosError } from "axios";
import { resolveWritePath } from "../../../config/env";
import { ragicClient, RagicRecord, RagicWriteOptions } from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { HttpError } from "../../../utils/httpError";

export function extractRagicErrorDetail(error: unknown): {
  status?: number;
  message: string;
} {
  const axiosError = error as AxiosError;
  const status = axiosError.response?.status;
  const message =
    typeof axiosError.response?.data === "string"
      ? axiosError.response.data
      : axiosError.message;
  return { status, message };
}

export function throwRagicHttpError(
  error: unknown,
  options: {
    code: "RAGIC_WRITE_FAILED" | "RAGIC_ACTION_BUTTON_FAILED";
    messagePrefix: string;
  }
): never {
  if (error instanceof HttpError) {
    throw error;
  }
  const { status, message } = extractRagicErrorDetail(error);
  throw new HttpError(
    502,
    `${options.messagePrefix}${status ? ` (HTTP ${status})` : ""}：${message}`,
    options.code
  );
}

export async function writeToRagic(
  formId: string,
  config: FormConfig,
  entryId: string,
  body: RagicRecord,
  doWorkflow = true,
  method: "POST" | "PATCH" | "PUT" = "PATCH",
  extraWriteOptions?: Omit<RagicWriteOptions, "doWorkflow">
): Promise<void> {
  const writePath = resolveWritePath(formId, config.ragicPath);
  if (!writePath) {
    throw new HttpError(
      503,
      "寫回目標尚未就緒，請先設定測試表單路徑",
      "WRITE_TARGET_NOT_READY"
    );
  }

  try {
    await ragicClient.updateEntry(writePath, entryId, body, method, {
      doWorkflow,
      ...(extraWriteOptions ?? {}),
    });
    ragicClient.clearFormCache(config.ragicPath);
    if (writePath !== config.ragicPath) {
      ragicClient.clearFormCache(writePath);
    }
  } catch (error) {
    throwRagicHttpError(error, {
      code: "RAGIC_WRITE_FAILED",
      messagePrefix: "寫回 Ragic 失敗",
    });
  }
}

export async function saveForm16Row(
  form16Path: string,
  rowId: string,
  payload: RagicRecord
): Promise<void> {
  if (Object.keys(payload).length === 0) {
    return;
  }
  await ragicClient.updateEntry(form16Path, rowId, payload, "POST", {
    doWorkflow: true,
    doFormula: true,
    doLinkLoad: "all",
  });
  ragicClient.clearFormCache(form16Path);
}

export async function writeComputedTotalWorkTime(
  form16Path: string,
  rowId: string,
  totalWorkTimeFieldId: string,
  totalWorkTime: number
): Promise<void> {
  if (!totalWorkTimeFieldId) {
    return;
  }
  await saveForm16Row(form16Path, rowId, {
    [totalWorkTimeFieldId]: totalWorkTime.toFixed(2),
  });
}
