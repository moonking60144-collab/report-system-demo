import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";
import {
  getApiErrorCode,
  getErrorMessage,
  getWorkReportTaskErrorMessage,
} from "./errorUtils";

describe("getWorkReportTaskErrorMessage", () => {
  it("把任務錯誤碼翻成中文，不直接露出內部 code", () => {
    expect(
      getWorkReportTaskErrorMessage({
        errorCode: "ENTRY_CONFLICT",
        errorMessage: "Request failed with status code 409",
        message: null,
      })
    ).toBe("這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。");
  });

  it("保留業務上下文並替換內部 code", () => {
    expect(
      getWorkReportTaskErrorMessage({
        errorCode: "ENTRY_CONFLICT",
        errorMessage: "批次新增尚未開始：ENTRY_CONFLICT",
        message: null,
      })
    ).toBe("批次新增尚未開始：這筆工令在你編輯期間已被其他人更新，請先刷新後再重新送出。");
  });

  it("把工令狀態未知翻成使用者看得懂的訊息", () => {
    expect(
      getWorkReportTaskErrorMessage({
        errorCode: "ENTRY_STATUS_UNKNOWN",
        errorMessage: "Request failed with status code 409",
        message: null,
      })
    ).toBe("暫時無法從 Ragic 取得最新工令狀態，這筆報工尚未寫入；請稍後重送。");
  });

  it("把 Ragic circuit breaker fast-fail 翻成可重試提示", () => {
    expect(
      getWorkReportTaskErrorMessage({
        errorCode: "RAGIC_CIRCUIT_OPEN",
        errorMessage: "circuit breaker [mutation] is OPEN, retry after 11155ms",
        message: null,
      })
    ).toBe("Ragic 暫時無法回應，這筆變更尚未寫入；請稍後重送。");
  });
});

describe("getErrorMessage", () => {
  it("AxiosError 有 backend 具體訊息時優先顯示，不退成通用 HTTP 502", () => {
    const error = new AxiosError(
      "Request failed with status code 502",
      "ERR_BAD_RESPONSE",
      undefined,
      undefined,
      {
        status: 502,
        statusText: "Bad Gateway",
        headers: {},
        config: {} as never,
        data: {
          error: {
            code: "RAGIC_WRITE_FAILED",
            message: "Field Type報工類別 contains empty value (code: 202)",
          },
        },
      }
    );

    expect(getErrorMessage(error)).toBe("Field Type報工類別 contains empty value (code: 202)");
  });

  it("可辨識 TASK_NOT_FOUND，讓 polling freeze overlay 而非偽造 failed", () => {
    const error = new AxiosError(
      "Request failed with status code 404",
      "ERR_BAD_REQUEST",
      undefined,
      undefined,
      {
        status: 404,
        statusText: "Not Found",
        headers: {},
        config: {} as never,
        data: { error: { code: "TASK_NOT_FOUND", message: "找不到任務" } },
      }
    );

    expect(getApiErrorCode(error)).toBe("TASK_NOT_FOUND");
  });
});
