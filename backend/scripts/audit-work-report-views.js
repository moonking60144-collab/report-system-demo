#!/usr/bin/env node

const http = require("http");

const API_BASE_URL = process.env.AUDIT_API_BASE_URL || "http://127.0.0.1:3300/api";
const FORM_105_MACHINE_VIEWS = [
  "F7",
  "F9",
  "FC",
  "FF",
  "FH",
  "FI",
  "FJ",
  "FK",
  "FL",
  "FM",
  "FN",
  "FO",
  "FP",
  "FQ",
  "H1",
  "HF",
  "P8",
  "P10",
];

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`${API_BASE_URL}${path}`, (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

function summarizeRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    workOrderNo: row.workOrderNo,
    machineCode: row.machineCode,
    filterMachineCode: row.filterMachineCode,
    plannedStartDate: row.plannedStartDate,
    sortOrder: row.sortOrder,
    status: row.status,
    prodType: row.prodType,
    modificationStatus: row.modificationStatus,
  }));
}

async function auditView(label, path) {
  const response = await fetchJson(path);
  const rows = Array.isArray(response.data) ? response.data : [];
  return {
    label,
    totalCount: response.meta?.totalCount ?? response.meta?.count ?? rows.length,
    count: response.meta?.count ?? rows.length,
    sample: summarizeRows(rows.slice(0, 10)),
  };
}

async function main() {
  const baseReports = [
    auditView(
      "104-未結案可執行",
      "/forms/104/reports?limit=10&offset=0&status=%E6%9C%AA%E7%B5%90%E6%A1%88&startSchedule=yes&sort=machineCode:asc,sortOrder:asc"
    ),
    auditView(
      "105-未結案工單",
      "/forms/105/reports?limit=10&offset=0&status=%E6%9C%AA%E7%B5%90%E6%A1%88&sort=machineCode:asc,plannedStartDate:asc"
    ),
  ];
  const form105MachineReports = FORM_105_MACHINE_VIEWS.map((machineCode) =>
    auditView(
      `105-${machineCode}未結案`,
      `/forms/105/reports?limit=10&offset=0&status=%E6%9C%AA%E7%B5%90%E6%A1%88&filterMachineCode=${encodeURIComponent(
        machineCode
      )}&sort=machineCode:asc,sortOrder:asc`
    )
  );

  const reports = await Promise.all([...baseReports, ...form105MachineReports]);

  const full104 = await fetchJson("/forms/104/reports/full");
  const full105 = await fetchJson("/forms/105/reports/full");

  const summary = {
    apiBaseUrl: API_BASE_URL,
    reports,
    fullReports: {
      "104": {
        cacheSource: full104.meta?.cacheSource,
        cacheState: full104.meta?.cacheState,
        count: full104.meta?.count,
      },
      "105": {
        cacheSource: full105.meta?.cacheSource,
        cacheState: full105.meta?.cacheState,
        count: full105.meta?.count,
      },
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
