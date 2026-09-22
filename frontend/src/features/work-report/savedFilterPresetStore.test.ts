import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WORK_REPORT_SAVED_FILTERS_STORAGE_KEY } from "./constants";
import {
  deleteWorkReportFilterPreset,
  normalizeSavedWorkReportFilterPresets,
  readSavedWorkReportFilters,
  saveWorkReportFilterPreset,
} from "./savedFilterPresetStore";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error("quota exceeded");
    }
    this.values.set(key, value);
  }
}

const filterGroup = {
  joinMode: "all" as const,
  conditions: [
    { id: "machine", field: "machineCode" as const, operator: "isAnyOf" as const, values: ["MA23", "MA18"] },
  ],
};

describe("savedFilterPresetStore", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("901 / 902 分開讀取，且名稱最多 24 字", () => {
    const saved901 = saveWorkReportFilterPreset({
      name: "A".repeat(30),
      formId: "901",
      landingPageKey: "line-a-901",
      filterGroup,
      sortRules: [],
    });
    saveWorkReportFilterPreset({
      name: "902 filter",
      formId: "902",
      landingPageKey: "line-b-902",
      filterGroup,
      sortRules: [],
    });

    expect(saved901?.name).toHaveLength(24);
    expect(readSavedWorkReportFilters("901", "line-a-901").map((item) => item.name)).toEqual([
      "A".repeat(24),
    ]);
  });

  test("每個頁面最多保存 8 組，刪除後可再新增", () => {
    for (let index = 0; index < 8; index += 1) {
      expect(
        saveWorkReportFilterPreset({
          name: `filter-${index}`,
          formId: "901",
          landingPageKey: "line-a-901",
          filterGroup,
          sortRules: [],
        })
      ).not.toBeNull();
    }
    expect(
      saveWorkReportFilterPreset({
        name: "overflow",
        formId: "901",
        landingPageKey: "line-a-901",
        filterGroup,
        sortRules: [],
      })
    ).toBeNull();

    const first = readSavedWorkReportFilters("901", "line-a-901")[0];
    deleteWorkReportFilterPreset(first!.id);
    expect(readSavedWorkReportFilters("901", "line-a-901")).toHaveLength(7);
  });

  test("損壞 JSON 與跨表 scope 的 preset 不會進入可套用清單", () => {
    window.localStorage.setItem(WORK_REPORT_SAVED_FILTERS_STORAGE_KEY, "not-json");
    expect(readSavedWorkReportFilters("901", "line-a-901")).toEqual([]);

    expect(
      normalizeSavedWorkReportFilterPresets([
        {
          schemaVersion: 1,
          id: "wrong-scope",
          name: "wrong",
          formId: "901",
          landingPageKey: "line-b-902",
          filterGroup,
          sortRules: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ])
    ).toEqual([]);
  });

  test("localStorage 寫入失敗時不回報儲存成功", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
    });

    expect(
      saveWorkReportFilterPreset({
        name: "cannot-save",
        formId: "901",
        landingPageKey: "line-a-901",
        filterGroup,
        sortRules: [],
      })
    ).toBeNull();
  });

  test("刪除寫入失敗時回報失敗並保留原條件", () => {
    const storage = window.localStorage as unknown as MemoryStorage;
    const saved = saveWorkReportFilterPreset({
      name: "keep-on-failure",
      formId: "901",
      landingPageKey: "line-a-901",
      filterGroup,
      sortRules: [],
    });
    expect(saved).not.toBeNull();

    storage.failWrites = true;
    expect(deleteWorkReportFilterPreset(saved!.id)).toBe(false);
    storage.failWrites = false;
    expect(readSavedWorkReportFilters("901", "line-a-901")).toHaveLength(1);
  });
});
