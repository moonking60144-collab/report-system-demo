import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { env } from "../../src/config/env";
import { startSqliteAutoSync, stopSqliteAutoSync } from "../../src/bootstrap/sqliteAutoSync";
import { workReportSyncService } from "../../src/services/work-report-sync/workReportSyncService";
import { activityLogDowntimeService } from "../../src/services/activityLog/activityLogDowntimeService";
import { getSqliteAutoSyncStatus } from "../../src/services/work-report-sync/sqliteAutoSyncStatus";
import { realtimeEventBus } from "../../src/events/realtimeEventBus";
import realtimeEventsRouter from "../../src/routes/realtimeEvents";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}

test("auto-sync 排程實際執行期間發布狀態，901 失敗後繼續 16 並清除狀態", async (t) => {
  const overrides = {
    SQLITE_ENABLED: true, SQLITE_AUTO_SYNC_ENABLED: true, SQLITE_AUTO_SYNC_FORMS: ["901"],
    SQLITE_READ_FORMS: ["901"], SQLITE_AUTO_SYNC_STARTUP_DELAY_MS: 1,
    SQLITE_AUTO_SYNC_INTERVAL_MS: 3_600_000, ACTIVITY_LOG_SQLITE_AUTO_SYNC_ENABLED: true,
  };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, env[key as keyof typeof env]]));
  Object.assign(env, overrides);
  const events: string[][] = [];
  const unsubscribe = realtimeEventBus.subscribe(event => {
    if (event.sqliteAutoSync) events.push(event.sqliteAutoSync.activeFormIds);
  });
  let reject901!: (error: Error) => void;
  let finishActivity!: (rows: []) => void;
  t.mock.method(workReportSyncService, "shouldDeferAutoSyncForMutation", () => false);
  t.mock.method(workReportSyncService, "requestSync", () => new Promise((_resolve, reject) => { reject901 = reject; }));
  t.mock.method(activityLogDowntimeService, "checkSnapshotStaleness", async () => ({ isStale: true }));
  t.mock.method(activityLogDowntimeService, "refreshSqliteSnapshotFromRagic", () => new Promise(resolve => { finishActivity = resolve; }));
  const app = express();
  app.use("/api", realtimeEventsRouter);
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auto-sync/status`;
  try {
    startSqliteAutoSync();
    await waitFor(() => reject901 !== undefined);
    assert.deepEqual(await (await fetch(url)).json(), { data: { activeFormIds: ["901"] } });
    reject901(new Error("test upstream failure"));
    await waitFor(() => finishActivity !== undefined);
    assert.deepEqual(getSqliteAutoSyncStatus(), { activeFormIds: ["903"] });
    finishActivity([]);
    await waitFor(() => getSqliteAutoSyncStatus().activeFormIds.length === 0);
    assert.deepEqual(events, [["901"], [], ["903"], []]);
    assert.deepEqual(await (await fetch(url)).json(), { data: { activeFormIds: [] } });
  } finally {
    stopSqliteAutoSync();
    unsubscribe();
    Object.assign(env, original);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
