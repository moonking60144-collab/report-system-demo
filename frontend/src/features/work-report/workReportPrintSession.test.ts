import { describe, expect, it } from "vitest";
import {
  createWorkReportPrintSession,
  parseWorkReportPrintSessionId,
  readWorkReportPrintSession,
} from "./workReportPrintSession";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("workReportPrintSession", () => {
  it("將列印文件保存為同分頁短效 session 並產生可重載 route", () => {
    const storage = new MemoryStorage();
    const sessionId = "print-session-1234567890";
    const created = createWorkReportPrintSession(
      storage,
      "<!doctype html><h1>製程 A 排程表</h1>",
      "zh",
      1_000,
      sessionId
    );

    expect(created).toEqual({
      sessionId,
      path: `/work-report/print/${sessionId}`,
    });
    expect(readWorkReportPrintSession(storage, sessionId, 2_000)).toMatchObject({
      status: "ready",
      payload: {
        sessionId,
        language: "zh",
        documentHtml: "<!doctype html><h1>製程 A 排程表</h1>",
        createdAt: 1_000,
        expiresAt: 1_801_000,
      },
    });
  });

  it("超過 30 分鐘後移除 session 並回報 expired", () => {
    const storage = new MemoryStorage();
    const sessionId = "expired-session-123456";
    createWorkReportPrintSession(storage, "<h1>expired</h1>", "en", 1_000, sessionId);

    expect(readWorkReportPrintSession(storage, sessionId, 1_801_000)).toEqual({
      status: "expired",
      language: "en",
    });
    expect(readWorkReportPrintSession(storage, sessionId, 1_801_001)).toEqual({
      status: "missing",
      language: "zh",
    });
  });

  it("只辨識合法 print route，拒絕子路徑與壞編碼", () => {
    expect(parseWorkReportPrintSessionId("/work-report/print/print-session-1234567890")).toBe(
      "print-session-1234567890"
    );
    expect(parseWorkReportPrintSessionId("/reports/901/1")).toBeNull();
    expect(parseWorkReportPrintSessionId("/work-report/print/session/extra")).toBe("");
    expect(parseWorkReportPrintSessionId("/work-report/print/%E0%A4%A")).toBe("");
  });
});
