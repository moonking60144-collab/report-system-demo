import { describe, expect, test } from "vitest";
import type { WorkReportRecord } from "../../../api/workReport";
import {
  applyPageReportGroupFilter,
  dedupeRecordsById,
  getColumnCellValue,
  matchesPageReportGroup,
  matchesRecordGlobalKeyword,
  mergeEntryRecordList,
  normalizeRecord,
} from "./recordUtils";

function makeRecord(fields: Partial<WorkReportRecord> & { id: string }): WorkReportRecord {
  return { workOrderNo: null, ...fields } as WorkReportRecord;
}

describe("getColumnCellValue", () => {
  test("一般欄位直接取值", () => {
    const record = makeRecord({ id: "1", workOrderNo: "WO-100" });
    expect(getColumnCellValue(record, "workOrderNo")).toBe("WO-100");
  });

  test("machineCode 有值時回 machineCode", () => {
    const record = makeRecord({ id: "1", machineCode: "F7", filterMachineCode: "F8" });
    expect(getColumnCellValue(record, "machineCode")).toBe("F7");
  });

  test("machineCode 空白時 fallback 到 filterMachineCode", () => {
    const record = makeRecord({ id: "1", machineCode: "   ", filterMachineCode: "F8" });
    expect(getColumnCellValue(record, "machineCode")).toBe("F8");
  });

  test("machineCode 為 null 時 fallback 到 filterMachineCode", () => {
    const record = makeRecord({ id: "1", machineCode: null, filterMachineCode: "F8" });
    expect(getColumnCellValue(record, "machineCode")).toBe("F8");
  });

  test("兩者都空回空字串（被 String+trim 處理）", () => {
    const record = makeRecord({ id: "1", machineCode: null, filterMachineCode: null });
    expect(getColumnCellValue(record, "machineCode")).toBe("");
  });
});

describe("matchesPageReportGroup", () => {
  test("prodType 等於目標回 true", () => {
    expect(matchesPageReportGroup(makeRecord({ id: "1", prodType: "TI" }), "TI")).toBe(true);
  });

  test("prodType 不等於目標回 false", () => {
    expect(matchesPageReportGroup(makeRecord({ id: "1", prodType: "HF" }), "TI")).toBe(false);
  });

  test("大小寫不敏感", () => {
    expect(matchesPageReportGroup(makeRecord({ id: "1", prodType: "ti" }), "TI")).toBe(true);
  });

  test("目標空字串表示接受所有", () => {
    expect(matchesPageReportGroup(makeRecord({ id: "1", prodType: "X" }), "")).toBe(true);
  });
});

describe("applyPageReportGroupFilter", () => {
  test("無任何 record 帶 prodType 時不過濾（避免空畫面）", () => {
    const records = [makeRecord({ id: "1" }), makeRecord({ id: "2" })];
    expect(applyPageReportGroupFilter(records, "TI")).toEqual(records);
  });

  test("有 prodType 時依 prodTypeCode 過濾", () => {
    const records = [
      makeRecord({ id: "1", prodType: "TI" }),
      makeRecord({ id: "2", prodType: "HF" }),
      makeRecord({ id: "3", prodType: "TI" }),
    ];
    const result = applyPageReportGroupFilter(records, "TI");
    expect(result.map((r) => r.id)).toEqual(["1", "3"]);
  });

  test("預設 prodTypeCode 為 TI", () => {
    const records = [
      makeRecord({ id: "1", prodType: "TI" }),
      makeRecord({ id: "2", prodType: "HF" }),
    ];
    expect(applyPageReportGroupFilter(records)).toHaveLength(1);
  });
});

describe("normalizeRecord", () => {
  test("id 轉成 string，reports 預設空陣列", () => {
    const input = { id: 123 as unknown as string } as WorkReportRecord;
    const result = normalizeRecord(input);
    expect(result.id).toBe("123");
    expect(result.reports).toEqual([]);
    expect(result.reportsLoaded).toBe(false);
  });

  test("保留既有 reports", () => {
    const reports = [{ rowId: "a" }] as WorkReportRecord["reports"];
    const result = normalizeRecord(makeRecord({ id: "1", reports }), true);
    expect(result.reports).toBe(reports);
    expect(result.reportsLoaded).toBe(true);
  });
});

describe("dedupeRecordsById", () => {
  test("同 id 後者覆蓋前者", () => {
    const records = [
      makeRecord({ id: "1", workOrderNo: "A" }),
      makeRecord({ id: "1", workOrderNo: "B" }),
      makeRecord({ id: "2", workOrderNo: "C" }),
    ];
    const result = dedupeRecordsById(records);
    expect(result).toHaveLength(2);
    expect(result[0].workOrderNo).toBe("B");
    expect(result[1].workOrderNo).toBe("C");
  });

  test("不同 id 全部保留", () => {
    const records = [makeRecord({ id: "1" }), makeRecord({ id: "2" }), makeRecord({ id: "3" })];
    expect(dedupeRecordsById(records)).toHaveLength(3);
  });

  test("空陣列", () => {
    expect(dedupeRecordsById([])).toEqual([]);
  });
});

describe("mergeEntryRecordList", () => {
  test("找到 entryId 會合併，replaced=true", () => {
    const original = [
      makeRecord({ id: "1", workOrderNo: "A" }),
      makeRecord({ id: "2", workOrderNo: "B" }),
    ];
    const { next, replaced } = mergeEntryRecordList(
      original,
      "1",
      makeRecord({ id: "1", workOrderNo: "A-updated" })
    );
    expect(replaced).toBe(true);
    expect(next[0].workOrderNo).toBe("A-updated");
    expect(next[0].reportsLoaded).toBe(true);
    expect(next[1].workOrderNo).toBe("B");
  });

  test("找不到 entryId 原陣列不變、replaced=false", () => {
    const original = [makeRecord({ id: "1" })];
    const { next, replaced } = mergeEntryRecordList(original, "999", makeRecord({ id: "999" }));
    expect(replaced).toBe(false);
    expect(next).toEqual(original);
  });
});

describe("matchesRecordGlobalKeyword", () => {
  test("空 keyword 回 true（不過濾）", () => {
    expect(matchesRecordGlobalKeyword(makeRecord({ id: "1" }), "")).toBe(true);
    expect(matchesRecordGlobalKeyword(makeRecord({ id: "1" }), "   ")).toBe(true);
  });

  test("keyword 在任一 searchable 欄位裡匹配回 true", () => {
    const record = makeRecord({ id: "1", workOrderNo: "WO-251" });
    expect(matchesRecordGlobalKeyword(record, "251")).toBe(true);
    expect(matchesRecordGlobalKeyword(record, "wo-")).toBe(true);
  });

  test("keyword 沒匹配回 false", () => {
    const record = makeRecord({ id: "1", workOrderNo: "WO-251" });
    expect(matchesRecordGlobalKeyword(record, "999")).toBe(false);
  });

  test("大小寫不敏感", () => {
    const record = makeRecord({ id: "1", workOrderNo: "WO-TEST" });
    expect(matchesRecordGlobalKeyword(record, "test")).toBe(true);
    expect(matchesRecordGlobalKeyword(record, "TEST")).toBe(true);
  });

  test("限定 searchableKeys 只看特定欄位", () => {
    const record = makeRecord({ id: "1", workOrderNo: "WO-HIT", customerPartNo: "PART-MISS" });
    expect(matchesRecordGlobalKeyword(record, "hit", ["workOrderNo"])).toBe(true);
    expect(matchesRecordGlobalKeyword(record, "miss", ["workOrderNo"])).toBe(false);
  });
});
