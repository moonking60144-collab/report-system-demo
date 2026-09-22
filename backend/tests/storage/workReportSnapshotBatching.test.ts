import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { env } from "../../src/config/env";
import { sqliteClient } from "../../src/storage/sqlite/sqliteClient";
import { workReportSqliteRepository as repo } from "../../src/storage/sqlite/workReportSqliteRepository";
import { WorkReportSyncService } from "../../src/services/work-report-sync/workReportSyncServiceFactory";
import { createWorkReportMutationSyncCoordinator } from "../../src/services/work-report-sync/workReportMutationSyncCoordinator";
import type { WorkReportRecord } from "../../src/types/workReport";
import { HttpError } from "../../src/utils/httpError";

const record = (id: string, workOrderNo = id): WorkReportRecord => ({
  id, workOrderNo, reports: [{ rowId: `${id}-row`, operatorId: workOrderNo }],
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function isolated(worker: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "snapshot-batching-"));
  const previous = {
    SQLITE_ENABLED: env.SQLITE_ENABLED,
    SQLITE_DB_FILE: env.SQLITE_DB_FILE,
    SQLITE_SYNC_BATCH_SIZE: env.SQLITE_SYNC_BATCH_SIZE,
  };
  Object.assign(env, { SQLITE_ENABLED: true, SQLITE_DB_FILE: join(root, "test.sqlite3"), SQLITE_SYNC_BATCH_SIZE: 2 });
  try { await worker(); } finally {
    await sqliteClient.close();
    Object.assign(env, previous);
  }
}

function service(records: WorkReportRecord[], refresh: (id: string) => Promise<WorkReportRecord>) {
  const coordinator = createWorkReportMutationSyncCoordinator();
  const sync = new WorkReportSyncService({
    coordinator,
    generateTaskId: () => `batch-sync-${Date.now()}`,
    scanFormRecords: async () => records,
    refreshEntry: async (_formId, id) => refresh(id),
    replaceFormSnapshot: repo.replaceFormSnapshot.bind(repo),
    upsertEntrySnapshot: repo.upsertEntrySnapshot.bind(repo),
    deleteEntrySnapshot: repo.deleteEntrySnapshot.bind(repo),
    getSyncState: repo.getSyncState.bind(repo),
    upsertSyncState: repo.upsertSyncState.bind(repo),
    getLatestProjectionSeq: repo.getLatestProjectionSeq.bind(repo),
    getOldestPendingProjectionSeq: repo.getOldestPendingProjectionSeq.bind(repo),
    listPendingProjectionEntries: repo.listPendingProjectionEntries.bind(repo),
    markProjectionRangeProcessed: repo.markProjectionRangeProcessed.bind(repo),
    cleanupProcessedProjectionEvents: repo.cleanupProcessedProjectionEvents.bind(repo),
    getFormSnapshotCounts: repo.getFormSnapshotCounts.bind(repo),
    publishWorkReportEntriesUpdated: () => undefined,
    publishWorkReportFormUpdated: () => undefined,
  });
  return { coordinator, sync };
}

for (const overlapBatch of [1, 2, 4]) {
  test(`snapshot 第 ${overlapBatch} 批允許報工事件先落盤，切換後保留新增修改刪除`, async (t) => isolated(async () => {
    const records = Array.from({ length: 7 }, (_, i) => record(String(i), `old-${i}`));
    await repo.replaceFormSnapshot("902", records, "2019-stale");
    await repo.replaceFormSnapshot("902", records, "2020-active");
    await repo.upsertSyncState({ formId: "902", status: "success", activeGenerationId: "2020-active", snapshotAt: "2020-active" });
    const { coordinator, sync } = service(records, async (id) => {
      if (id === "1") throw new HttpError(404, "deleted", "REPORT_NOT_FOUND");
      return record(id, `live-${id}`);
    });
    const entered = deferred(), release = deferred();
    const db = await sqliteClient.getDb(), run = db.run.bind(db);
    let entryBatch = 0, snapshotComplete = false;
    t.mock.method(db, "run", async (sql: string, ...params: unknown[]) => {
      const result = await run(sql, ...params);
      if (sql.includes("INSERT INTO work_report_entries") && ++entryBatch === overlapBatch) {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const pendingSync = sync.requestSync("902", { triggeredBy: "auto-schedule", waitForCompletion: true })
      .then((result) => { snapshotComplete = true; return result; });
    await Promise.race([
      entered.promise,
      pendingSync.then(() => { throw new Error("sync finished before reaching the batch gate"); }),
    ]);
    const releaseMutation = await coordinator.acquireMutationSlot();
    let cleanup: Promise<number> | undefined;
    try {
      const visible = await repo.getReports("902", { limit: 20, offset: 0 });
      assert.deepEqual(visible.data.map(x => x.workOrderNo), records.map(x => x.workOrderNo));
      const queued = repo.enqueueProjectionEvent("902", "0", "update");
      cleanup = repo.cleanupOldFormGenerations("902", "2020-active", { batchSize: 2, keepRecentGenerations: 1 });
      release.resolve();
      await queued;
      // The writer must be released before finishing the remaining snapshot batches.
      const partial = await db.get<{ n: number }>(
        "SELECT count(*) AS n FROM work_report_rows WHERE form_id = ? AND generation_id > ?", "902", "2020-active"
      );
      assert.ok((partial?.n ?? 0) < 7, "MUTATION_MUST_COMMIT_BETWEEN_BATCHES");
      assert.equal(snapshotComplete, false);
      await repo.enqueueProjectionEvent("902", "1", "delete");
      await repo.enqueueProjectionEvent("902", "new", "create");
    } finally {
      release.resolve();
      releaseMutation();
      await Promise.allSettled([pendingSync, ...(cleanup ? [cleanup] : [])]);
    }
    const finished = await pendingSync;
    assert.equal(await cleanup, 7);
    assert.equal(finished.status, "success");
    assert.equal(finished.syncedEntries, 7);
    assert.equal(finished.syncedRows, 7);
    assert.equal((await repo.getReportByEntryId("902", "0"))?.workOrderNo, "live-0");
    assert.equal(await repo.getReportByEntryId("902", "1"), null);
    assert.equal((await repo.getReportByEntryId("902", "new"))?.workOrderNo, "live-new");
    assert.equal(await repo.getOldestPendingProjectionSeq("902"), null);
  }));
}

for (const failedTable of ["work_report_entries", "work_report_rows"]) {
test(`${failedTable} 批次失敗及重開 DB 仍讀舊版本，重試清除半成品且拒絕覆寫 active`, async (t) => isolated(async () => {
  await repo.replaceFormSnapshot("902", [record("old")], "2020-active");
  await repo.upsertSyncState({ formId: "902", status: "success", activeGenerationId: "2020-active", snapshotAt: "2020-active" });
  await repo.enqueueProjectionEvent("902", "pending", "update");
  const records = Array.from({ length: 7 }, (_, i) => record(String(i)));
  const db = await sqliteClient.getDb(), run = db.run.bind(db);
  let batches = 0;
  const mocked = t.mock.method(db, "run", async (sql: string, ...params: unknown[]) => {
    if (sql.includes(`INSERT INTO ${failedTable}`) && ++batches === 2) throw new Error("injected batch failure");
    return run(sql, ...params);
  });
  await assert.rejects(repo.replaceFormSnapshot("902", records, "2021-incomplete"), /injected batch failure/);
  mocked.mock.restore();
  assert.deepEqual(await repo.getFormSnapshotCounts("902", { generationId: "2021-incomplete" }),
    failedTable === "work_report_entries" ? { entryCount: 2, rowCount: 0 } : { entryCount: 7, rowCount: 4 });
  await sqliteClient.close();
  assert.deepEqual((await repo.getReports("902", { limit: 20, offset: 0 })).data.map(x => x.id), ["old"]);
  assert.ok(await repo.getOldestPendingProjectionSeq("902"));
  await assert.rejects(repo.replaceFormSnapshot("902", records, "2020-active"), /Cannot replace the active/, "ACTIVE_GENERATION_MUST_REMAIN_UNCHANGED");
  assert.equal((await repo.getReportByEntryId("902", "old"))?.id, "old");
  assert.deepEqual(await repo.replaceFormSnapshot("902", records, "2021-incomplete"), { entryCount: 7, rowCount: 7 });
  await repo.replaceFormSnapshot("902", [record("next")], "2022-next");
  await repo.upsertSyncState({ formId: "902", status: "success", activeGenerationId: "2022-next", snapshotAt: "2022-next" });
  await repo.cleanupOldFormGenerations("902", "2022-next", { batchSize: 2, keepRecentGenerations: 1 });
  assert.deepEqual(await repo.getFormSnapshotCounts("902", { generationId: "2021-incomplete" }), { entryCount: 0, rowCount: 0 });
  assert.equal((await repo.getReportByEntryId("902", "next"))?.id, "next");
}));
}

test("首次同步在建構中及未發布前不曝光部分版本", async (t) => isolated(async () => {
  const entered = deferred(), release = deferred();
  const db = await sqliteClient.getDb(), run = db.run.bind(db);
  let batches = 0;
  t.mock.method(db, "run", async (sql: string, ...params: unknown[]) => {
    const result = await run(sql, ...params);
    if (sql.includes("INSERT INTO work_report_entries") && ++batches === 2) {
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  const building = repo.replaceFormSnapshot("901", Array.from({ length: 7 }, (_, i) => record(String(i))), "first-generation");
  await Promise.race([
    entered.promise,
    building.then(() => { throw new Error("snapshot finished before reaching the batch gate"); }),
  ]);
  try {
    assert.equal((await repo.getReports("901", { limit: 20, offset: 0 })).totalCount, 0);
    assert.equal(await repo.getReportByEntryId("901", "0"), null);
  } finally {
    release.resolve();
    await Promise.allSettled([building]);
  }
  await building;
  assert.equal((await repo.getReports("901", { limit: 20, offset: 0 })).totalCount, 0);
  await repo.upsertSyncState({ formId: "901", status: "success", activeGenerationId: "first-generation", snapshotAt: "first-generation" });
  assert.equal((await repo.getReports("901", { limit: 20, offset: 0 })).totalCount, 7);
}));

for (const failedTable of ["work_report_entries", "work_report_rows"]) {
  test(`${failedTable} 同交易第二條 SQL 失敗會回滾整批，保留前批提交`, async (t) => isolated(async () => {
    Object.assign(env, { SQLITE_SYNC_BATCH_SIZE: 50 });
    await repo.replaceFormSnapshot("902", [record("old")], "2020-active");
    await repo.upsertSyncState({ formId: "902", status: "success", activeGenerationId: "2020-active", snapshotAt: "2020-active" });
    const db = await sqliteClient.getDb(), run = db.run.bind(db);
    let statements = 0;
    t.mock.method(db, "run", async (sql: string, ...params: unknown[]) => {
      if (sql.includes(`INSERT INTO ${failedTable}`) && ++statements === 4) throw new Error("inner SQL failed");
      return run(sql, ...params);
    });
    await assert.rejects(repo.replaceFormSnapshot("902", Array.from({ length: 250 }, (_, i) => record(String(i))), "2021-incomplete"), /inner SQL failed/);
    assert.deepEqual(await repo.getFormSnapshotCounts("902", { generationId: "2021-incomplete" }),
      failedTable === "work_report_entries" ? { entryCount: 50, rowCount: 0 } : { entryCount: 250, rowCount: 100 });
    assert.deepEqual((await repo.getReports("902", { limit: 20, offset: 0 })).data.map(x => x.id), ["old"]);
  }));
}
