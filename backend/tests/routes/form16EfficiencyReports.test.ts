import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import form16EfficiencyReportsRouter from "../../src/routes/form16EfficiencyReports";
import { errorHandler } from "../../src/middleware/errorHandler";
import { form16EfficiencyReportArchiveService } from "../../src/services/form16/form16EfficiencyReportArchiveService";
import type { EfficiencyReportSnapshotRecord } from "../../src/storage/efficiency-report/efficiencyReportArchiveRepository";

async function withTestServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use("/api", form16EfficiencyReportsRouter);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function snapshot(): EfficiencyReportSnapshotRecord {
  return {
    id: "snapshot-1",
    periodMonth: "2026-06",
    version: 1,
    status: "ready",
    sourceHash: "hash-1",
    sourceRowCount: 12,
    sourceSizeBytes: 1200,
    csvRelativePath: "2026-06/v1/source.csv",
    generatedBy: "client-a",
    createdAt: "2026-07-13T00:00:00.000Z",
    finalizedAt: null,
    artifacts: [
      {
        id: "artifact-1",
        snapshotId: "snapshot-1",
        attendanceDays: 22,
        templateVersion: "template-hash",
        calculationVersion: "v1",
        reportFingerprint: "report-fingerprint",
        xlsxRelativePath: "2026-06/v1/analysis.xlsx",
        xlsxSizeBytes: 2400,
        createdAt: "2026-07-13T00:01:00.000Z",
      },
    ],
  };
}

test("GET /api/downtime/efficiency-reports 回分頁歷史版本", async (t) => {
  t.mock.method(
    form16EfficiencyReportArchiveService,
    "listSnapshots",
    async (limit: number, offset: number) => {
      assert.equal(limit, 100);
      assert.equal(offset, 3);
      return { records: [snapshot()], totalCount: 4 };
    }
  );

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/efficiency-reports?limit=999&offset=3`);
    const payload = (await response.json()) as {
      data: Array<Record<string, unknown> & { periodMonth: string; artifacts: Record<string, unknown>[] }>;
      meta: { limit: number; offset: number; hasMore: boolean };
    };
    assert.equal(response.status, 200);
    assert.equal(payload.data[0].periodMonth, "2026-06");
    assert.equal(payload.meta.limit, 100);
    assert.equal(payload.meta.offset, 3);
    assert.equal(payload.meta.hasMore, false);
    assert.equal("sourceHash" in payload.data[0], false);
    assert.equal("csvRelativePath" in payload.data[0], false);
    assert.equal("generatedBy" in payload.data[0], false);
    assert.equal("reportFingerprint" in payload.data[0].artifacts[0], false);
    assert.equal("xlsxRelativePath" in payload.data[0].artifacts[0], false);
  });
});

test("既有 monthly-csv endpoint 改由 archive service 回傳檔案", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "efficiency-route-"));
  const filePath = path.join(root, "source.csv");
  await writeFile(filePath, "header\nvalue", "utf8");
  t.after(async () => rm(root, { recursive: true, force: true }));
  t.mock.method(form16EfficiencyReportArchiveService, "getOrCreateCurrentCsv", async () => ({
    snapshot: snapshot(),
    filePath,
    filename: "c1-6-2026-06-v1.csv",
  }));

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/downtime/export/monthly-csv`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /c1-6-2026-06-v1\.csv/);
    assert.equal(await response.text(), "header\nvalue");
  });
});

test("analysis-xlsx endpoint 驗證出勤天數後交給 archive service", async (t) => {
  let callCount = 0;
  t.mock.method(form16EfficiencyReportArchiveService, "getOrCreateCurrentAnalysis", async () => {
    callCount += 1;
    throw new Error("should not be called");
  });

  await withTestServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/downtime/export/analysis-xlsx?attendanceDays=99`
    );
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(payload.error.code, "INVALID_QUERY_PARAM");
    assert.equal(callCount, 0);
  });
});
