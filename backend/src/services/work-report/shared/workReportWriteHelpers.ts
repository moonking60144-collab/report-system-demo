import { AxiosError } from "axios";
import { resolveWritePath } from "../../../config/env";
import {
  ragicClient,
  RagicRecord,
  RagicWriteOptions,
  RagicWriteRequestOptions,
} from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { HttpError, UpstreamError } from "../../../utils/httpError";
import { isRagicRequestAdmissionError } from "../../../infra/ragicRequestScheduler";

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
  if (error instanceof HttpError || isRagicRequestAdmissionError(error)) {
    throw error;
  }
  const { status, message } = extractRagicErrorDetail(error);
  throw new UpstreamError(
    `${options.messagePrefix}${status ? ` (HTTP ${status})` : ""}：${message}`,
    options.code,
    { status, message }
  );
}

export async function writeToRagic(
  formId: string,
  config: FormConfig,
  entryId: string,
  body: RagicRecord,
  doWorkflow = true,
  method: "POST" | "PATCH" | "PUT" = "PATCH",
  extraWriteOptions?: Omit<RagicWriteOptions, "doWorkflow">,
  requestOptions?: RagicWriteRequestOptions
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
    await ragicClient.updateEntry(
      writePath,
      entryId,
      body,
      method,
      {
        doWorkflow,
        ...(extraWriteOptions ?? {}),
      },
      requestOptions
    );
    if (writePath.replace(/\/$/, "") !== config.ragicPath.replace(/\/$/, "")) {
      ragicClient.clearFormCache(config.ragicPath);
    }
  } catch (error) {
    throwRagicHttpError(error, {
      code: "RAGIC_WRITE_FAILED",
      messagePrefix: "寫回 Ragic 失敗",
    });
  }
}

export async function saveActivityLogRow(
  activityLogPath: string,
  rowId: string,
  payload: RagicRecord
): Promise<void> {
  if (Object.keys(payload).length === 0) {
    return;
  }
  await ragicClient.updateEntry(activityLogPath, rowId, payload, "POST", {
    doWorkflow: true,
    doFormula: true,
    doLinkLoad: "all",
  });
}

export async function writeComputedTotalWorkTime(
  activityLogPath: string,
  rowId: string,
  totalWorkTimeFieldId: string,
  totalWorkTime: number
): Promise<void> {
  if (!totalWorkTimeFieldId) {
    return;
  }
  await saveActivityLogRow(activityLogPath, rowId, {
    [totalWorkTimeFieldId]: totalWorkTime.toFixed(2),
  });
}
