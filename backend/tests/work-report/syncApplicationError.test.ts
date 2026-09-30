import test from "node:test";
import assert from "node:assert/strict";
import { ragicClient } from "../../src/ragic/client";
import { workReportSyncService } from "../../src/services/work-report-sync/workReportSyncService";
import { workReportSqliteRepository } from "../../src/storage/sqlite/workReportSqliteRepository";
import { getFormConfig } from "../../src/config/forms";
import { resolveWorkReportDataPath } from "../../src/config/env";

test("真實 scanner 中間頁 application error 保留 SQLite active generation 與原資料", async (t) => {
  const formId = "902", snapshot = "2026-09-30T00:00:00.000Z";
  const original = { id: "preserved", workOrderNo: "KEEP", customerPartNo: null, erpPartNo: null, status: "未結案", reports: [] };
  await workReportSqliteRepository.replaceFormSnapshot(formId, [original], snapshot);
  await workReportSqliteRepository.upsertSyncState({ formId, status: "success", snapshotAt: snapshot, activeGenerationId: snapshot, totalEntries: 1, totalRows: 0 });
  const formPath = resolveWorkReportDataPath(formId, getFormConfig(formId).ragicPath);
  const offsets: number[] = [];
  const client = ragicClient as unknown as { axiosInstance: { get: (path: string, options: { params: { offset: number } }) => Promise<unknown> } };
  ragicClient.clearCache();
  t.mock.method(client.axiosInstance, "get", async (path: string, options: { params: { offset: number } }) => {
    if (path !== formPath) return { data: {} };
    const offset = options.params.offset; offsets.push(offset);
    return { data: offset === 0
      ? Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i + 1), { _ragicId: String(i + 1) }]))
      : { status: "ERROR", msg: "fixture upstream failure" } };
  });
  const result = await workReportSyncService.requestSync(formId, { triggeredBy: "audit-regression", waitForCompletion: true });
  assert.equal(result.status, "failed");
  assert.ok(offsets.includes(1000));
  const state = await workReportSqliteRepository.getSyncState(formId);
  assert.equal(state?.activeGenerationId, snapshot, "FAILED_PAGE_MUST_NOT_PROMOTE");
  assert.equal(state?.totalEntries, 1);
  assert.equal((await workReportSqliteRepository.getReportByEntryId(formId, "preserved"))?.workOrderNo, "KEEP");
});
