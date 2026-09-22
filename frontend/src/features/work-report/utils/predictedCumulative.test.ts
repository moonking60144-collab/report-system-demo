import { describe, expect, test } from "vitest";
import type { WorkReportItem } from "../../../api/workReport";
import type { FormState } from "../../../components/report-form/types";
import {
  computePredictedCumulative,
  predictModalCumulative,
} from "./predictedCumulative";

function makeRow(rowId: string, productionQty: string | number, extra?: Partial<WorkReportItem>): WorkReportItem {
  return {
    rowId,
    productionQty: String(productionQty),
    cumulativeQty: "0",
    ...extra,
  } as WorkReportItem;
}

function makeDraft(productionQty: string): FormState {
  return { productionQty } as unknown as FormState;
}

describe("computePredictedCumulative", () => {
  test("沒有 draft 時，既有列的累計量照原產量依序加總", () => {
    const rows = [makeRow("1", 10), makeRow("2", 20), makeRow("3", 5)];
    const map = computePredictedCumulative({
      detailRows: rows,
      editingRowId: null,
      editingRowDraft: null,
      batchCreateDraftsByRowId: {},
      batchCreateMode: false,
      displayRows: rows,
    });
    expect(map.get("1")?.cum).toBe(10);
    expect(map.get("2")?.cum).toBe(30);
    expect(map.get("3")?.cum).toBe(35);
    expect(map.get("1")?.isPredicted).toBe(false);
    expect(map.get("3")?.isPredicted).toBe(false);
  });

  test("inline edit 修改中間某列，該列起 cascade isPredicted=true", () => {
    const rows = [makeRow("1", 10), makeRow("2", 20), makeRow("3", 5)];
    const map = computePredictedCumulative({
      detailRows: rows,
      editingRowId: "2",
      editingRowDraft: makeDraft("50"),
      batchCreateDraftsByRowId: {},
      batchCreateMode: false,
      displayRows: rows,
    });
    expect(map.get("1")?.cum).toBe(10);
    expect(map.get("1")?.isPredicted).toBe(false);
    expect(map.get("2")?.cum).toBe(60);
    expect(map.get("2")?.isPredicted).toBe(true);
    expect(map.get("3")?.cum).toBe(65);
    expect(map.get("3")?.isPredicted).toBe(true);
  });

  test("batchCreateMode：placeholder 有 draft 才進 map，沒 draft 的 placeholder 被 skip", () => {
    const existing = [makeRow("1", 10)];
    const displayRows = [...existing, { rowId: "ph0" }, { rowId: "ph1" }];
    const map = computePredictedCumulative({
      detailRows: existing,
      editingRowId: null,
      editingRowDraft: null,
      batchCreateDraftsByRowId: { ph0: makeDraft("7") },
      batchCreateMode: true,
      displayRows,
    });
    expect(map.get("1")?.cum).toBe(10);
    expect(map.get("ph0")?.cum).toBe(17);
    expect(map.get("ph0")?.isPredicted).toBe(true);
    expect(map.has("ph1")).toBe(false);
  });

  test("editingRowDraft 在 editing row 覆蓋 batchCreateDraftsByRowId", () => {
    const displayRows = [{ rowId: "ph0" }, { rowId: "ph1" }];
    const map = computePredictedCumulative({
      detailRows: [],
      editingRowId: "ph0",
      editingRowDraft: makeDraft("99"),
      batchCreateDraftsByRowId: { ph0: makeDraft("1"), ph1: makeDraft("2") },
      batchCreateMode: true,
      displayRows,
    });
    expect(map.get("ph0")?.cum).toBe(99);
    expect(map.get("ph1")?.cum).toBe(101);
  });

  test("batchCreateMode=false 時忽略 batchCreateDraftsByRowId", () => {
    const rows = [makeRow("1", 10)];
    const map = computePredictedCumulative({
      detailRows: rows,
      editingRowId: null,
      editingRowDraft: null,
      batchCreateDraftsByRowId: { ph0: makeDraft("99") },
      batchCreateMode: false,
      displayRows: [...rows, { rowId: "ph0" }],
    });
    expect(map.has("ph0")).toBe(false);
    expect(map.get("1")?.cum).toBe(10);
  });

  test("draft 修改後但產量跟原本相等，不標 isPredicted", () => {
    const rows = [makeRow("1", 10), makeRow("2", 20)];
    const map = computePredictedCumulative({
      detailRows: rows,
      editingRowId: "2",
      editingRowDraft: makeDraft("20"),
      batchCreateDraftsByRowId: {},
      batchCreateMode: false,
      displayRows: rows,
    });
    expect(map.get("2")?.isPredicted).toBe(false);
  });

  test("非數字 productionQty 視為 0", () => {
    const rows = [makeRow("1", "abc"), makeRow("2", "  15  ")];
    const map = computePredictedCumulative({
      detailRows: rows,
      editingRowId: null,
      editingRowDraft: null,
      batchCreateDraftsByRowId: {},
      batchCreateMode: false,
      displayRows: rows,
    });
    expect(map.get("1")?.cum).toBe(0);
    expect(map.get("2")?.cum).toBe(15);
  });
});

describe("predictModalCumulative", () => {
  test("新增模式（selfRowId=null）= 全加 + draft", () => {
    const rows = [makeRow("1", 10), makeRow("2", 20)];
    expect(predictModalCumulative(rows, "5", null)).toBe(35);
  });

  test("編輯模式只加 rowId < self 的列，不吃自己跟後面的", () => {
    const rows = [makeRow("1", 10), makeRow("2", 20), makeRow("3", 5)];
    // 編輯 rowId=2，只加 rowId=1 + draft
    expect(predictModalCumulative(rows, "100", "2")).toBe(110);
  });

  test("編輯 rowId=最後一筆，等同加所有前面 + draft", () => {
    const rows = [makeRow("1", 10), makeRow("2", 20), makeRow("3", 5)];
    expect(predictModalCumulative(rows, "7", "3")).toBe(37);
  });

  test("非數字 rowId 略過不加", () => {
    const rows = [makeRow("1", 10), makeRow("ph0", 999)];
    expect(predictModalCumulative(rows, "0", null)).toBe(10);
  });

  test("空 draft 當 0", () => {
    const rows = [makeRow("1", 10)];
    expect(predictModalCumulative(rows, "", null)).toBe(10);
  });
});
