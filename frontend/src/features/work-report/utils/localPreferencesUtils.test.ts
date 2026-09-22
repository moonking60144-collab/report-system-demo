import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_REPORT_LOCAL_PREFS_STORAGE_KEY } from "../constants";
import {
  readWorkReportLocalPreferences,
  sanitizeWorkReportLocalPreferences,
  writeWorkReportLocalPreferences,
} from "./localPreferencesUtils";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: new MemoryStorage() });
});

describe("work report local preferences", () => {
  it("舊版 storage 缺少新增欄位時套用安全預設", () => {
    window.localStorage.setItem(
      WORK_REPORT_LOCAL_PREFS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        defaultLandingPageKey: "line-b-902",
        defaultFixedPresetId901: "all-data",
        defaultFixedPresetId902: "finished-orders",
        hideTestCustomerPartRecords: false,
      })
    );

    expect(readWorkReportLocalPreferences()).toMatchObject({
      defaultLandingPageKey: "line-b-902",
      hideTestCustomerPartRecords: false,
      hideSortOrder99Records: true,
      showListScrollHintButton: true,
    });
  });

  it("保留使用者明確選擇顯示排序 99 工令的設定", () => {
    const preferences = sanitizeWorkReportLocalPreferences({
      hideSortOrder99Records: false,
    });

    expect(writeWorkReportLocalPreferences(preferences)).toBe(true);

    expect(readWorkReportLocalPreferences().hideSortOrder99Records).toBe(false);
  });

  it("localStorage 寫入失敗時不回報儲存成功", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
    });

    expect(
      writeWorkReportLocalPreferences(
        sanitizeWorkReportLocalPreferences({ hideSortOrder99Records: false })
      )
    ).toBe(false);
  });

  it("保留使用者隱藏列表捲動提示按鈕的設定", () => {
    const preferences = sanitizeWorkReportLocalPreferences({
      showListScrollHintButton: false,
    });

    expect(writeWorkReportLocalPreferences(preferences)).toBe(true);
    expect(readWorkReportLocalPreferences().showListScrollHintButton).toBe(false);
  });
});
