import { describe, expect, it } from "vitest";
import { extractErrorMessage } from "./apiErrors";

describe("extractErrorMessage", () => {
  it("優先顯示 backend HttpError 的 typed message", () => {
    const error = {
      isAxiosError: true,
      message: "Request failed with status code 502",
      response: {
        data: {
          error: {
            code: "DEV_AI_MINIMAX_BAD_RESPONSE",
            message: "MiniMax API 沒有回傳結構化 tool input",
          },
        },
      },
    };

    expect(extractErrorMessage(error, "送出失敗")).toBe(
      "MiniMax API 沒有回傳結構化 tool input"
    );
  });
});
