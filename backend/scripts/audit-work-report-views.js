#!/usr/bin/env node

const http = require("http");

const API_BASE_URL = process.env.AUDIT_API_BASE_URL || "http://127.0.0.1:3300/api";
const FORM_902_MACHINE_VIEWS = [
  "MB07",
  "MB09",
  "MB12",
  "MB15",
  "MB17",
  "MB18",
  "MB19",
  "MB20",
  "MB21",
  "MB22",
  "MB23",
  "MB24",
  "MB25",
  "MB26",
  "MB31",
  "MB35",
  "MB48",
  "MB50",
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
      "901-未結案可執行",
      "/forms/901/reports?limit=10&offset=0&status=%E6%9C%AA%E7%B5%90%E6%A1%88&startSchedule=yes&sort=machineCode:asc,sortOrder:asc"
    ),
    auditView(
      "902-未結案工單",
      "/forms/902/reports?limit=10&offset=0&status=%E6%9C%AA%E7%B5%90%E6%A1%88&sort=machineCode:asc,plannedStartDate:asc"
    ),
  ];
  const form902MachineReports = FORM_902_MACHINE_VIEWS.map((machineCode) =>
    auditView(
      `902-${machineCode}未結案`,
      `/forms/902/reports?limit=10&offset=0&status=%E6%9C%AA%E7%B5%90%E6%A1%88&filterMachineCode=${encodeURIComponent(
        machineCode
      )}&sort=machineCode:asc,sortOrder:asc`
    )
  );

  const reports = await Promise.all([...baseReports, ...form902MachineReports]);

  const full901 = await fetchJson("/forms/901/reports/full");
  const full902 = await fetchJson("/forms/902/reports/full");

  const summary = {
    apiBaseUrl: API_BASE_URL,
    reports,
    fullReports: {
      "901": {
        cacheSource: full901.meta?.cacheSource,
        cacheState: full901.meta?.cacheState,
        count: full901.meta?.count,
      },
      "902": {
        cacheSource: full902.meta?.cacheSource,
        cacheState: full902.meta?.cacheState,
        count: full902.meta?.count,
      },
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
