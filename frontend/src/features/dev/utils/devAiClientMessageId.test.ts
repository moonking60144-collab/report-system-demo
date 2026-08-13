import { describe, expect, it } from "vitest";
import { resolveDevAiMessageSubmission } from "./devAiClientMessageId";

describe("resolveDevAiMessageSubmission", () => {
  it("相同 thread 與 payload 的重試會重用 clientMessageId", () => {
    const first = resolveDevAiMessageSubmission(null, "thread-1", {
      message: "同一題",
      mode: "auto",
      context: { formPath: "default/forms8/104", fieldId: "1000214" },
    });
    const retry = resolveDevAiMessageSubmission(first, "thread-1", {
      context: { fieldId: "1000214", formPath: "default/forms8/104" },
      mode: "auto",
      message: "同一題",
    });

    expect(retry.clientMessageId).toBe(first.clientMessageId);
    expect(retry.clientMessageId).toMatch(/^[A-Za-z0-9._:-]{8,100}$/);
  });

  it("thread 或 payload 改變時會產生新的 clientMessageId", () => {
    const first = resolveDevAiMessageSubmission(null, "thread-1", {
      message: "第一題",
    });
    const changedMessage = resolveDevAiMessageSubmission(first, "thread-1", {
      message: "第二題",
    });
    const changedThread = resolveDevAiMessageSubmission(first, "thread-2", {
      message: "第一題",
    });

    expect(changedMessage.clientMessageId).not.toBe(first.clientMessageId);
    expect(changedThread.clientMessageId).not.toBe(first.clientMessageId);
  });
});
