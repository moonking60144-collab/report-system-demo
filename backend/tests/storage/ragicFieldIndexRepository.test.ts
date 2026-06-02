import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createRagicFieldIndexRepository } from "../../src/storage/sqlite/ragicFieldIndexRepository";
import { ensureRagicFieldIndexSchema } from "../../src/storage/sqlite/ragicFieldIndexSchema";

async function buildRepo() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  return { db, repo };
}

const SAMPLE_ENTRIES = [
  {
    formPath: "default/forms8/104",
    formName: "[104] Work Order Report — Process A",
    scope: "main" as const,
    subtableKey: "1005987",
    fieldPos: "B1",
    fieldName: "工令單單號",
    fieldId: "1005984",
    fieldType: "文字",
    fieldNote: "唯讀",
  },
  {
    formPath: "default/forms8/104",
    formName: "[104] Work Order Report — Process A",
    scope: "main" as const,
    subtableKey: "1005987",
    fieldPos: "E1",
    fieldName: "工令單種類",
    fieldId: "1006401",
    fieldType: "選項",
  },
  {
    formPath: "default/forms8/104",
    formName: "[104] Work Order Report — Process A",
    scope: "subtable" as const,
    subtableName: "報工明細",
    subtableKey: "1006400",
    fieldPos: "B1",
    fieldName: "操作員",
    fieldId: "1010920",
    fieldType: "選項",
  },
  {
    formPath: "default/forms8/105",
    formName: "[105] 報工表",
    scope: "main" as const,
    subtableKey: "999",
    fieldPos: "A1",
    fieldName: "單號",
    fieldId: "1234567",
    fieldType: "文字",
  },
];

test("初始狀態 status='idle' 且 totalForms=0", async () => {
  const { repo } = await buildRepo();
  const state = await repo.getState();
  assert.equal(state.status, "idle");
  assert.equal(state.totalForms, 0);
  assert.equal(state.totalFields, 0);
});

test("replaceAll 寫入後 countAll 回正確統計", async () => {
  const { repo } = await buildRepo();
  const counts = await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
  assert.equal(counts.totalForms, 2); // 104, 105
  assert.equal(counts.totalFields, 4);
  const re = await repo.countAll();
  assert.equal(re.totalForms, 2);
  assert.equal(re.totalFields, 4);
});

test("replaceAll 重新 import 會清掉舊資料", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-01-01T00:00:00.000Z");
  await repo.replaceAll(
    [SAMPLE_ENTRIES[0]!],
    "2026-05-08T00:00:00.000Z"
  );
  const counts = await repo.countAll();
  assert.equal(counts.totalForms, 1);
  assert.equal(counts.totalFields, 1);
});

test("search 用 q LIKE 比對 form 名 / 欄位名 / id", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");

  // 搜 form 名（"104"）
  const r1 = await repo.search({ q: "104" });
  assert.equal(r1.length, 3); // 104 主 2 + 子 1

  // 搜欄位名
  const r2 = await repo.search({ q: "工令" });
  assert.ok(r2.length >= 2);

  // 搜 field id（明確）
  const r3 = await repo.search({ q: "1010920" });
  assert.equal(r3.length, 1);
  assert.equal(r3[0]?.fieldId, "1010920");
});

test("search 用 formPath 過濾", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
  const r = await repo.search({ formPath: "default/forms8/105" });
  assert.equal(r.length, 1);
  assert.equal(r[0]?.fieldId, "1234567");
});

test("search 用 fieldId 過濾（精確比對）", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
  const r = await repo.search({ fieldId: "1006401" });
  assert.equal(r.length, 1);
  assert.equal(r[0]?.fieldName, "工令單種類");
});

test("search limit 上限 2000、下限 1", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
  const r1 = await repo.search({ limit: 1 });
  assert.equal(r1.length, 1);
});

test("setState 狀態欄位反映變動", async () => {
  const { repo } = await buildRepo();
  await repo.setState({ status: "refreshing", message: "fetching" });
  let state = await repo.getState();
  assert.equal(state.status, "refreshing");
  assert.equal(state.message, "fetching");

  await repo.setState({
    status: "ready",
    refreshedAt: "2026-05-08T00:00:00.000Z",
    totalForms: 869,
    totalFields: 26000,
    message: null,
  });
  state = await repo.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.totalForms, 869);
  assert.equal(state.totalFields, 26000);
  assert.equal(state.message, null);
});

test("setState 不指定的欄位會保留舊值", async () => {
  const { repo } = await buildRepo();
  await repo.setState({
    status: "ready",
    refreshedAt: "2026-05-08T00:00:00.000Z",
    totalForms: 100,
    totalFields: 5000,
    message: "ok",
  });
  // 只更新 status，其他欄位應保留
  await repo.setState({ status: "refreshing" });
  const state = await repo.getState();
  assert.equal(state.status, "refreshing");
  assert.equal(state.totalForms, 100);
  assert.equal(state.totalFields, 5000);
  assert.equal(state.refreshedAt, "2026-05-08T00:00:00.000Z");
  assert.equal(state.message, "ok");
});

test("claimRefresh 第一次呼叫成功，第二次（state=refreshing）失敗", async () => {
  const { repo } = await buildRepo();
  const first = await repo.claimRefresh("first attempt");
  assert.equal(first, true);
  let state = await repo.getState();
  assert.equal(state.status, "refreshing");
  assert.equal(state.message, "first attempt");

  // 第二次：state 還是 refreshing → 不能再 claim
  const second = await repo.claimRefresh("second attempt");
  assert.equal(second, false);
  state = await repo.getState();
  // message 維持第一次寫入的內容（沒被覆蓋）
  assert.equal(state.message, "first attempt");
});

test("claimRefresh 從 'error' 狀態可以重新 claim", async () => {
  const { repo } = await buildRepo();
  await repo.setState({ status: "error", message: "previous failure" });
  const claimed = await repo.claimRefresh("retry");
  assert.equal(claimed, true);
  const state = await repo.getState();
  assert.equal(state.status, "refreshing");
});

test("resetStuckRefreshing 把 'refreshing' 重設成 'idle'", async () => {
  const { repo } = await buildRepo();
  await repo.setState({ status: "refreshing", message: "in flight" });
  const reset = await repo.resetStuckRefreshing("recovered on startup");
  assert.equal(reset, true);
  const state = await repo.getState();
  assert.equal(state.status, "idle");
  assert.equal(state.message, "recovered on startup");
});

test("resetStuckRefreshing 對非 refreshing 狀態 no-op", async () => {
  const { repo } = await buildRepo();
  await repo.setState({ status: "ready" });
  const reset = await repo.resetStuckRefreshing("should not fire");
  assert.equal(reset, false);
  const state = await repo.getState();
  assert.equal(state.status, "ready");
});
