import { describe, expect, it, vi } from "vitest";
import type { WorkReportRecord } from "../../api/workReport";
import { getWorkReportCellCopyValue, getWorkReportCellFilterCondition, getWorkReportRowCopyValue } from "./workReportCellCopy";
import { applyWorkReportFilterGroup, getWorkReportFilterFields, normalizeWorkReportFilterGroup } from "./utils/customFilterUtils";
import { COLUMN_TYPE_MAP } from "./constants";

const record: WorkReportRecord = {
  id: "1", workOrderNo: "WO-123", status: "未結案", customerPartNo: "完整料號\n第二行", erpPartNo: "",
  machineCode: "W5", filterMachineCode: " F9 ", previousMachine: " HF ", sortOrder: 0,
  startSchedule: "Yes", urgent: "No", siteRunning: "true", prevStationRunning: "0",
  plannedEndDate: "2026-09-07", reports: [],
};

describe("cell copy business values", () => {
  it.each([
    ["workOrderNo", "WO-123"], ["customerPartNo", "完整料號\n第二行"], ["previousMachine", "HF"],
    ["sortOrder", "0"], ["startSchedule", "是"], ["urgent", "否"], ["siteRunning", "是"],
    ["prevStationRunning", "否"], ["plannedEndDate", "2026/09/07"], ["erpPartNo", ""],
  ])("%s copies its complete value without control text", (key, expected) => {
    expect(getWorkReportCellCopyValue(record, key, "901", "zh"), "BUSINESS_VALUE_COPY_CONTRACT").toBe(expected);
  });

  it("902 copies the displayed filter machine, not the separate machine field", () => {
    expect(getWorkReportCellCopyValue(record, "machineCode", "902", "zh"), "FORM_902_DISPLAYED_MACHINE_COPY").toBe("F9");
    expect(getWorkReportCellCopyValue(record, "machineCode", "901", "zh")).toBe("W5");
    expect(getWorkReportCellCopyValue({ ...record, filterMachineCode: null }, "machineCode", "902", "zh")).toBe("");
  });

  it("localized boolean values distinguish false from missing values", () => {
    expect(getWorkReportCellCopyValue(record, "urgent", "901", "en")).toBe("No");
    expect(getWorkReportCellCopyValue(record, "startSchedule", "901", "en")).toBe("Yes");
    expect(getWorkReportCellCopyValue({ ...record, urgent: "" }, "urgent", "901", "zh")).toBe("");
    expect(getWorkReportCellCopyValue({ ...record, urgent: "未確認" }, "urgent", "901", "zh")).toBe("未確認");
  });

  it("row TSV follows the supplied visible order and quotes embedded delimiters", () => {
    expect(getWorkReportRowCopyValue(record, ["sortOrder", "customerPartNo", "urgent", "machineCode"], "902", "zh"), "VISIBLE_ROW_TSV_ORDER")
      .toBe('0\t"完整料號\n第二行"\t否\tF9');
    expect(getWorkReportRowCopyValue({ ...record, customerPartNo: 'A\t"B"' }, ["customerPartNo"], "901", "zh"))
      .toBe('"A\t""B"""');
  });

  it("filter conditions use canonical fields and tokens, including the 105 displayed machine", () => {
    expect(getWorkReportCellFilterCondition(record, "machineCode", "902"), "FORM_902_FILTER_VALUE")
      .toMatchObject({ field: "machineCode", operator: "isAnyOf", values: ["F9"] });
    expect(getWorkReportCellFilterCondition(record, "customerPartNo", "901"))
      .toMatchObject({ operator: "equals", values: ["完整料號\n第二行"] });
    expect(getWorkReportCellFilterCondition(record, "siteRunning", "901"))
      .toMatchObject({ values: ["yes"] });
    expect(getWorkReportCellFilterCondition({ ...record, customerPartNo: "" }, "customerPartNo", "901"))
      .toMatchObject({ operator: "isEmpty", values: [] });
  });

  it("unsupported, unparseable and overlong filters are not silently changed", () => {
    expect(getWorkReportCellFilterCondition(record, "scheduleAction", "901")).toBeNull();
    expect(getWorkReportCellFilterCondition(record, "startSchedule", "902")).toBeNull();
    expect(getWorkReportCellFilterCondition({ ...record, siteRunning: "未指定" }, "siteRunning", "901")).toBeNull();
    expect(getWorkReportCellFilterCondition({ ...record, customerPartNo: "X".repeat(121) }, "customerPartNo", "901"), "FILTER_MUST_NOT_TRUNCATE").toBeNull();
  });

  it.each(["901", "902"] as const)("%s opens filters for every supported data field and retains only matching records", formId => {
    expect(getWorkReportFilterFields(formId), "FILTER_CATALOG_MUST_INCLUDE_DATA_COLUMNS").toHaveLength(formId === "901" ? 41 : 40);
    expect(getWorkReportFilterFields(formId)).toEqual(expect.arrayContaining([
      "size", "forgingMother", "previousMachine", "urgent", "sortOrder", "plannedEndDate", "estimatedHours", "targetQtyPc",
    ]));
    for (const field of getWorkReportFilterFields(formId)) {
      const type = COLUMN_TYPE_MAP[field];
      const value = type === "boolean" ? "Yes" : type === "date" ? "2026/09/07" : type === "number" ? "1,000.5" : "unique-value";
      const other = type === "boolean" ? "No" : type === "date" ? "2026/09/08" : type === "number" ? "1001" : "other-value";
      const source = { ...record, [field]: value, ...(field === "machineCode" && formId === "902" ? { filterMachineCode: value } : {}) };
      const excluded = { ...source, id: "excluded", [field]: other, ...(field === "machineCode" && formId === "902" ? { filterMachineCode: other } : {}) };
      const condition = getWorkReportCellFilterCondition(source, field, formId);
      expect(condition, "ALL_DATA_FIELDS_SUPPORT_QUICK_FILTER " + field).not.toBeNull();
      const group = normalizeWorkReportFilterGroup(JSON.parse(JSON.stringify({ joinMode: "all", conditions: [condition] })));
      expect(group.conditions).toHaveLength(1);
      expect(applyWorkReportFilterGroup([source, excluded], group, formId), "EXPANDED_FILTER_RETAINS_ONLY_SOURCE " + field).toEqual([source]);
    }
  });

  it("numeric comparisons use numbers, keep zero and exclude malformed or missing numbers", () => {
    const rows = ["0", "2", "10", "1,000", "abc", "", null, "1e400", "01", ".5"].map((estimatedHours, i) => ({ ...record, id: String(i), estimatedHours }));
    const filter = (operator: "equals" | "greaterThan" | "lessThan" | "atLeast" | "atMost", value: string) => applyWorkReportFilterGroup(rows, {
      joinMode: "all", conditions: [{ id: "number", field: "estimatedHours", operator, values: [value] }],
    }).map(row => row.id);
    expect(filter("greaterThan", "2"), "NUMERIC_COMPARISON_NOT_LEXICAL").toEqual(["2", "3"]);
    expect(filter("atLeast", "2")).toEqual(["1", "2", "3"]);
    expect(filter("lessThan", "2")).toEqual(["0"]);
    expect(filter("atMost", "2")).toEqual(["0", "1"]);
    expect(filter("equals", "0"), "INVALID_NUMBERS_MUST_NOT_MATCH_ZERO").toEqual(["0"]);
    expect(filter("equals", "1000")).toEqual(["3"]);
  });

  it("numeric filters reject boolean and structured values while accepting numeric zero and one", () => {
    const values = [false, true, 0, 1, "0", "1", [1], { value: 1 }, null];
    const rows: WorkReportRecord[] = JSON.parse(JSON.stringify(values.map((estimatedHours, index) => ({ ...record, id: String(index), estimatedHours }))));
    for (const [value, expected] of [["0", ["2", "4"]], ["1", ["3", "5"]]] as const) {
      expect(applyWorkReportFilterGroup(rows, {
        joinMode: "all", conditions: [{ id: "numeric-types", field: "estimatedHours", operator: "equals", values: [value] }],
      }).map(row => row.id), "NUMERIC_FILTER_REJECTS_NON_NUMERIC_JSON_TYPES").toEqual(expected);
    }
    for (const estimatedHours of [false, true, [1], { value: 1 }]) {
      expect(getWorkReportCellFilterCondition(JSON.parse(JSON.stringify({ ...record, estimatedHours })), "estimatedHours", "901")).toBeNull();
    }
  });

  it("date filters reject non-string values instead of coercing them into dates", () => {
    const rows: WorkReportRecord[] = JSON.parse(JSON.stringify(["2026/09/07", false, true, 0, 1, ["2026/09/07"]].map((plannedEndDate, index) => ({ ...record, id: String(index), plannedEndDate }))));
    expect(applyWorkReportFilterGroup(rows, {
      joinMode: "all", conditions: [{ id: "date-types", field: "plannedEndDate", operator: "between", values: ["2026-09-07", "2026-09-07"] }],
    }).map(row => row.id)).toEqual(["0"]);
    for (const plannedEndDate of [false, true, 0, 1, ["2026/09/07"]]) {
      expect(getWorkReportCellFilterCondition(JSON.parse(JSON.stringify({ ...record, plannedEndDate })), "plannedEndDate", "901")).toBeNull();
    }
  });

  it("text filters retain diameter symbols and treat JS whitespace as empty", () => {
    const diameter = { ...record, size: "\tΦAB06*15\u00a0" };
    const other = { ...record, id: "other", size: "φab06*15" };
    const condition = getWorkReportCellFilterCondition(diameter, "size", "901")!;
    expect(applyWorkReportFilterGroup([diameter, other], { joinMode: "all", conditions: [condition] }), "TEXT_FILTER_RETAINS_ORIGINAL_SYMBOL").toEqual([diameter]);
    const blank = { ...record, size: " \t\r\n\u00a0\ufeff " };
    const emptyCondition = getWorkReportCellFilterCondition(blank, "size", "901")!;
    expect(emptyCondition).toMatchObject({ operator: "isEmpty", values: [] });
    expect(applyWorkReportFilterGroup([blank, diameter], { joinMode: "all", conditions: [emptyCondition] })).toEqual([blank]);
  });

  it("last-updated filters select a complete calendar day", () => {
    expect(getWorkReportCellFilterCondition({ ...record, lastUpdatedAt: "2026/09/07 11:32:10" }, "lastUpdatedAt", "901"))
      .toMatchObject({ operator: "between", values: ["2026-09-07", "2026-09-07"] });
    expect(getWorkReportCellFilterCondition({ ...record, lastUpdatedAt: "unknown" }, "lastUpdatedAt", "901")).toBeNull();
  });

  it("padded ISO timestamps retain the clicked row after quick-filter apply", () => {
    vi.stubEnv("TZ", "Asia/Taipei");
    try {
      for (const [raw, day] of [[" 2026-09-07T23:30:00+0800 ", "2026-09-07"], ["\u00a02026-09-07T23:30:00Z\ufeff", "2026-09-08"]]) {
        for (const field of ["lastUpdatedAt", "plannedStartDate", "plannedEndDate", "prevPlanEndDate"] as const) {
          const source = { ...record, [field]: raw };
          const condition = getWorkReportCellFilterCondition(source, field, "901")!;
          expect(condition, "PADDED_ISO_QUICK_FILTER_MUST_RETAIN_SOURCE").not.toBeNull();
          expect(condition.values).toEqual([day, day]);
          const group = normalizeWorkReportFilterGroup(JSON.parse(JSON.stringify({ joinMode: "all", conditions: [condition] })));
          expect(applyWorkReportFilterGroup([source], group, "901"), "PADDED_ISO_QUICK_FILTER_MUST_RETAIN_SOURCE").toEqual([source]);
          for (const operator of ["before", "after"] as const) {
            expect(applyWorkReportFilterGroup([source], { joinMode: "all", conditions: [{ ...condition, operator, values: [day] }] }, "901")).toEqual([source]);
          }
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["UTC", "Asia/Taipei", "America/Los_Angeles"])("%s host uses Taiwan's calendar day and retains the clicked row", timezone => {
    vi.stubEnv("TZ", timezone);
    try {
      const timed = { ...record, lastUpdatedAt: "2026-09-17T20:00:00Z" };
      const condition = getWorkReportCellFilterCondition(timed, "lastUpdatedAt", "901")!;
      expect(condition.values, "TAIWAN_CALENDAR_DAY_FILTER").toEqual(["2026-09-18", "2026-09-18"]);
      const otherDay = { ...record, id: "other-day", lastUpdatedAt: "2026-09-18T20:00:00Z" };
      expect(applyWorkReportFilterGroup([timed, otherDay], { joinMode: "all", conditions: [condition] }, "901"), "FILTER_MUST_RETAIN_ONLY_SOURCE_DAY").toEqual([timed]);
      const midnight = { ...record, lastUpdatedAt: "2026-09-17T24:00:00" };
      const midnightCondition = getWorkReportCellFilterCondition(midnight, "lastUpdatedAt", "901")!;
      expect(midnightCondition.values).toEqual(["2026-09-18", "2026-09-18"]);
      expect(applyWorkReportFilterGroup([midnight], { joinMode: "all", conditions: [midnightCondition] }, "901")).toEqual([midnight]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
