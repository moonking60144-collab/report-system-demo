import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { env } from "../../src/config/env";
import { WorkReportReadSupport } from "../../src/services/work-report/shared/workReportReadSupport";
import { sqliteClient } from "../../src/storage/sqlite/sqliteClient";
import { READ_MODEL_SCHEMA_VERSION } from "../../src/storage/sqlite/readModelSchema";
import { workReportSqliteRepository } from "../../src/storage/sqlite/workReportSqliteRepository";
import type {
  ReportSortRule,
  WorkReportRecord,
} from "../../src/types/workReport";

const records: WorkReportRecord[] = [
  {
    id: "E1",
    reports: [],
    workOrderNo: "WO-A%B",
    prodType: "PA",
    machineCode: "UPSTREAM-A",
    filterMachineCode: "PA",
    previousMachine: "B",
    estimatedHours: "2",
    plannedEndDate: "2026-08-20",
    urgent: "Yes",
    workOrderRemark: "literal-percent",
  },
  {
    id: "E2",
    reports: [],
    workOrderNo: "WO-AXB",
    prodType: "PA",
    machineCode: "UPSTREAM-B",
    filterMachineCode: "MB41",
    previousMachine: "A",
    estimatedHours: "10",
    plannedEndDate: "2025-08-20",
    urgent: "No",
    workOrderRemark: "wildcard-percent",
  },
  {
    id: "E3",
    reports: [],
    workOrderNo: "WO-3",
    prodType: "PA",
    filterMachineCode: "PA",
    previousMachine: "C",
    estimatedHours: "abc",
    plannedEndDate: "invalid",
    urgent: "maybe",
    workOrderRemark: "other",
  },
  {
    id: "E4",
    reports: [],
    workOrderNo: "WO-4",
    prodType: "PA",
    filterMachineCode: "",
    previousMachine: "",
    estimatedHours: "",
    plannedEndDate: "",
    urgent: "",
    workOrderRemark: "blank",
  },
  {
    id: "E5",
    reports: [],
    workOrderNo: "WO-5",
    prodType: "PB",
    previousMachine: "D",
    estimatedHours: "5",
    plannedEndDate: "2024-08-20",
    urgent: "No",
    sortOrder: 99,
    workOrderRemark: "A_B",
  },
  {
    id: "E6",
    reports: [],
    workOrderNo: "WO  DOUBLE",
    prodType: "PB",
    customerPartNo: "TEST-PART",
    previousMachine: "E",
    estimatedHours: "6",
    plannedEndDate: "2023-08-20",
    urgent: "Yes",
    workOrderRemark: "ACB",
  },
];

test("SQLite 與 memory fallback 對 allowlisted sort/facet/filter 使用同一語意", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-report-column-parity-"));
  const dbPath = join(root, "read-model.sqlite3");
  const mutableEnv = env as { SQLITE_ENABLED: boolean; SQLITE_DB_FILE: string };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  const originalSqliteDbFile = mutableEnv.SQLITE_DB_FILE;
  mutableEnv.SQLITE_ENABLED = true;
  mutableEnv.SQLITE_DB_FILE = dbPath;
  const support = new WorkReportReadSupport();

  try {
    await workReportSqliteRepository.replaceFormSnapshot("902", records, "gen-parity");
    await workReportSqliteRepository.upsertSyncState({
      formId: "902",
      status: "success",
      snapshotAt: "public-parity",
      activeGenerationId: "gen-parity",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: records.length,
      totalRows: 0,
      message: "active-parity",
    });
    await workReportSqliteRepository.replaceFormSnapshot("901", records, "gen-parity-901");
    await workReportSqliteRepository.upsertSyncState({
      formId: "901",
      status: "success",
      snapshotAt: "public-parity-901",
      activeGenerationId: "gen-parity-901",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: records.length,
      totalRows: 0,
      message: "active-parity-901",
    });

    const rules: ReportSortRule[] = [
      { key: "estimatedHours", direction: "asc" },
      { key: "estimatedHours", direction: "desc" },
      { key: "plannedEndDate", direction: "asc" },
      { key: "urgent", direction: "asc" },
      { key: "previousMachine", direction: "asc" },
      { key: "filterMachineCode", direction: "asc" },
    ];
    for (const rule of rules) {
      const sqlite = await workReportSqliteRepository.getReports("902", {
        limit: 100,
        offset: 0,
        sortRules: [rule],
      });
      const memory = support.filterSortAndPaginateReports(records, {
        limit: 100,
        offset: 0,
        sortRules: [rule],
      });
      assert.deepEqual(
        sqlite.data.map((record) => record.id),
        memory.data.map((record) => record.id),
        `sort parity failed: ${rule.key}:${rule.direction}`
      );
    }

    const sqliteFacets = await workReportSqliteRepository.getFacetCounts(
      "902",
      {},
      ["previousMachine", "urgent", "filterMachineCode"]
    );
    const memoryFacets = support.buildFacetCountsFromRecords(
      records,
      ["previousMachine", "urgent", "filterMachineCode"],
      {}
    );
    assert.deepEqual(sqliteFacets, memoryFacets);
    assert.deepEqual(sqliteFacets.filterMachineCode, [
      { token: "MB41", count: 1 },
      { token: "PA", count: 2 },
      { token: "__blank__", count: 3 },
    ]);

    const filteredMachine = await workReportSqliteRepository.getReports("902", {
      limit: 100,
      offset: 0,
      columnFilters: {
        filterMachineCode: { type: "text", textQuery: "pa" },
      },
    });
    assert.deepEqual(filteredMachine.data.map((record) => record.id), ["E1", "E3"]);

    const literalPercent = await workReportSqliteRepository.getReports("902", {
      limit: 100,
      offset: 0,
      workOrderKeyword: "A%B",
    });
    assert.deepEqual(literalPercent.data.map((record) => record.id), ["E1"]);

    const literalUnderscore = await workReportSqliteRepository.getReports("902", {
      limit: 100,
      offset: 0,
      columnFilters: {
        workOrderRemark: { type: "text", textQuery: "A_B" },
      },
    });
    assert.deepEqual(literalUnderscore.data.map((record) => record.id), ["E5"]);

    const filterGroup = {
      joinMode: "any" as const,
      conditions: [
        { id: "a", field: "workOrderNo" as const, operator: "equals" as const, values: ["WO-A%B"] },
        { id: "b", field: "workOrderNo" as const, operator: "equals" as const, values: ["WO-5"] },
      ],
    };
    const sqliteCustom = await workReportSqliteRepository.getReports("902", {
      limit: 100,
      offset: 0,
      filterGroup,
    });
    const memoryCustom = support.filterSortAndPaginateReports(records, {
      formId: "902",
      limit: 100,
      offset: 0,
      filterGroup,
    });
    assert.deepEqual(sqliteCustom.data.map((record) => record.id), ["E1", "E5"]);
    assert.deepEqual(
      sqliteCustom.data.map((record) => record.id),
      memoryCustom.data.map((record) => record.id)
    );

    const form902MachineFilter = {
      joinMode: "all" as const,
      conditions: [
        { id: "m", field: "machineCode" as const, operator: "isAnyOf" as const, values: ["PA"] },
      ],
    };
    const sqliteMachine = await workReportSqliteRepository.getReports("902", {
      limit: 100,
      offset: 0,
      filterGroup: form902MachineFilter,
    });
    const memoryMachine = support.filterSortAndPaginateReports(records, {
      formId: "902",
      limit: 100,
      offset: 0,
      filterGroup: form902MachineFilter,
    });
    assert.deepEqual(sqliteMachine.data.map((record) => record.id), ["E1", "E3"]);
    assert.deepEqual(memoryMachine.data.map((record) => record.id), ["E1", "E3"]);

    const wrongMachineField = {
      ...form902MachineFilter,
      conditions: [{ ...form902MachineFilter.conditions[0], values: ["UPSTREAM-A"] }],
    };
    const sqliteWrongMachine = await workReportSqliteRepository.getReports("902", {
      limit: 100,
      offset: 0,
      filterGroup: wrongMachineField,
    });
    assert.deepEqual(sqliteWrongMachine.data, []);

    const localVisibilityQuery = {
      limit: 100,
      offset: 0,
      excludeTestCustomerPart: true,
      excludeSortOrder99: true,
    };
    const sqliteVisible = await workReportSqliteRepository.getReports(
      "902",
      localVisibilityQuery
    );
    const memoryVisible = support.filterSortAndPaginateReports(
      records,
      localVisibilityQuery
    );
    assert.deepEqual(sqliteVisible.data.map((record) => record.id), ["E1", "E2", "E3", "E4"]);
    assert.deepEqual(
      sqliteVisible.data.map((record) => record.id),
      memoryVisible.data.map((record) => record.id)
    );
    const pagedVisible = await workReportSqliteRepository.getReports("902", {
      ...localVisibilityQuery,
      limit: 2,
      offset: 2,
    });
    assert.deepEqual(pagedVisible.data.map((record) => record.id), ["E3", "E4"]);
    assert.equal(pagedVisible.totalCount, 4);
    assert.equal(pagedVisible.hasMore, false);

    const prodTypeQuery = { limit: 2, offset: 2, prodType: "pa" };
    const sqliteTiPage = await workReportSqliteRepository.getReports("901", prodTypeQuery);
    const memoryTiPage = support.filterSortAndPaginateReports(records, prodTypeQuery);
    assert.deepEqual(sqliteTiPage.data.map((record) => record.id), ["E3", "E4"]);
    assert.deepEqual(
      sqliteTiPage.data.map((record) => record.id),
      memoryTiPage.data.map((record) => record.id)
    );
    assert.equal(sqliteTiPage.totalCount, 4);
    assert.equal(memoryTiPage.totalCount, 4);
    assert.equal(sqliteTiPage.hasMore, false);

    const sqliteTiFacets = await workReportSqliteRepository.getFacetCounts(
      "901",
      { prodType: "PA" },
      ["filterMachineCode"]
    );
    const memoryTiFacets = support.buildFacetCountsFromRecords(
      records,
      ["filterMachineCode"],
      { prodType: "PA" }
    );
    assert.deepEqual(sqliteTiFacets, memoryTiFacets);
    assert.deepEqual(sqliteTiFacets.filterMachineCode, [
      { token: "MB41", count: 1 },
      { token: "PA", count: 2 },
      { token: "__blank__", count: 1 },
    ]);
    const tiAnalysisValues = await workReportSqliteRepository.getColumnValues(
      "901",
      { prodType: "PA" },
      "estimatedHours"
    );
    assert.deepEqual(
      tiAnalysisValues.map((value) => String(value ?? "")).sort(),
      ["", "10", "2", "abc"]
    );

    const collapsedWhitespaceFilter = {
      joinMode: "all" as const,
      conditions: [
        {
          id: "space",
          field: "workOrderNo" as const,
          operator: "equals" as const,
          values: ["WO DOUBLE"],
        },
      ],
    };
    const sqliteCollapsedWhitespace = await workReportSqliteRepository.getReports("902", {
      limit: 100,
      offset: 0,
      filterGroup: collapsedWhitespaceFilter,
    });
    const memoryCollapsedWhitespace = support.filterSortAndPaginateReports(records, {
      formId: "902",
      limit: 100,
      offset: 0,
      filterGroup: collapsedWhitespaceFilter,
    });
    assert.deepEqual(sqliteCollapsedWhitespace.data, []);
    assert.deepEqual(memoryCollapsedWhitespace.data, []);

    const exactWhitespaceFilter = {
      ...collapsedWhitespaceFilter,
      conditions: [
        { ...collapsedWhitespaceFilter.conditions[0], values: ["WO  DOUBLE"] },
      ],
    };
    const sqliteExactWhitespace = await workReportSqliteRepository.getReports("902", {
      limit: 100,
      offset: 0,
      filterGroup: exactWhitespaceFilter,
    });
    const memoryExactWhitespace = support.filterSortAndPaginateReports(records, {
      formId: "902",
      limit: 100,
      offset: 0,
      filterGroup: exactWhitespaceFilter,
    });
    assert.deepEqual(sqliteExactWhitespace.data.map((record) => record.id), ["E6"]);
    assert.deepEqual(memoryExactWhitespace.data.map((record) => record.id), ["E6"]);
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    await rm(root, { recursive: true, force: true });
  }
});

test("排序 99 僅放行已可執行的後續 B 站，且 SQLite 與 memory fallback 一致", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-report-sort-99-visibility-"));
  const dbPath = join(root, "read-model.sqlite3");
  const mutableEnv = env as { SQLITE_ENABLED: boolean; SQLITE_DB_FILE: string };
  const originalSqliteEnabled = mutableEnv.SQLITE_ENABLED;
  const originalSqliteDbFile = mutableEnv.SQLITE_DB_FILE;
  mutableEnv.SQLITE_ENABLED = true;
  mutableEnv.SQLITE_DB_FILE = dbPath;
  const support = new WorkReportReadSupport();
  const visibilityRecords: WorkReportRecord[] = [
    {
      id: "ordinary-99",
      reports: [],
      sortOrder: 99,
      prodType: "PB",
      defaultProcessCode: "B01",
      defaultMainMaterial: "RAW-MATERIAL",
    },
    {
      id: "current-hf03",
      reports: [],
      sortOrder: 99,
      prodType: "PB",
      defaultProcessCode: "B03",
      defaultMainMaterial: "PART-A-02PB",
      siteRunning: "Yes",
    },
    {
      id: "previous-hf04",
      reports: [],
      sortOrder: 99,
      prodType: "PB",
      defaultProcessCode: "B04",
      defaultMainMaterial: "PART-A-03PB",
      prevCompletePc: "1,000",
    },
    {
      id: "future-hf04",
      reports: [],
      sortOrder: 99,
      prodType: "PB",
      defaultProcessCode: "B04",
      defaultMainMaterial: "PART-B-03PB",
      siteRunning: "No",
      reportCount: 0,
      prevCompletePc: 0,
    },
    {
      id: "subtable-only-hf",
      reports: [{ rowId: "empty-report" }],
      reportCount: 0,
      sortOrder: 99,
      prodType: "PB",
      defaultProcessCode: "B02",
      defaultMainMaterial: "PART-A-01PB",
    },
    {
      id: "non-consecutive-hf",
      reports: [],
      sortOrder: 99,
      prodType: "PB",
      defaultProcessCode: "B02",
      defaultMainMaterial: "RAW-MATERIAL",
      prevReportQtyPc: 100,
    },
  ];

  try {
    await workReportSqliteRepository.replaceFormSnapshot("902", visibilityRecords, "gen-902");
    await workReportSqliteRepository.upsertSyncState({
      formId: "902",
      status: "success",
      snapshotAt: "snapshot-902",
      activeGenerationId: "gen-902",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: visibilityRecords.length,
      totalRows: 0,
      message: "ready",
    });
    await workReportSqliteRepository.replaceFormSnapshot("901", visibilityRecords, "gen-901");
    await workReportSqliteRepository.upsertSyncState({
      formId: "901",
      status: "success",
      snapshotAt: "snapshot-901",
      activeGenerationId: "gen-901",
      readModelVersion: READ_MODEL_SCHEMA_VERSION,
      totalEntries: visibilityRecords.length,
      totalRows: 0,
      message: "ready",
    });

    const hiddenByDefaultQuery = {
      formId: "902" as const,
      limit: 100,
      offset: 0,
      excludeSortOrder99: true,
    };
    const sqliteVisible = await workReportSqliteRepository.getReports(
      "902",
      hiddenByDefaultQuery
    );
    const memoryVisible = support.filterSortAndPaginateReports(
      visibilityRecords,
      hiddenByDefaultQuery
    );
    assert.deepEqual(
      sqliteVisible.data.map((record) => record.id),
      ["current-hf03", "previous-hf04"]
    );
    assert.deepEqual(
      memoryVisible.data.map((record) => record.id),
      sqliteVisible.data.map((record) => record.id)
    );

    const sqliteShowAll = await workReportSqliteRepository.getReports("902", {
      limit: 100,
      offset: 0,
      excludeSortOrder99: false,
    });
    assert.deepEqual(
      sqliteShowAll.data.map((record) => record.id),
      visibilityRecords.map((record) => record.id)
    );

    const sqlite901Visible = await workReportSqliteRepository.getReports("901", {
      limit: 100,
      offset: 0,
      excludeSortOrder99: true,
    });
    const memory901Visible = support.filterSortAndPaginateReports(visibilityRecords, {
      formId: "901",
      limit: 100,
      offset: 0,
      excludeSortOrder99: true,
    });
    assert.deepEqual(sqlite901Visible.data, []);
    assert.deepEqual(memory901Visible.data, []);
  } finally {
    await sqliteClient.close();
    mutableEnv.SQLITE_ENABLED = originalSqliteEnabled;
    mutableEnv.SQLITE_DB_FILE = originalSqliteDbFile;
    await rm(root, { recursive: true, force: true });
  }
});
