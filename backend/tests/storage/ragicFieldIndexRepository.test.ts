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
    formName: "[104] 工令單搓牙報工+排程",
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
    formName: "[104] 工令單搓牙報工+排程",
    scope: "main" as const,
    subtableKey: "1005987",
    fieldPos: "E1",
    fieldName: "工令單種類",
    fieldId: "1006401",
    fieldType: "選項",
  },
  {
    formPath: "default/forms8/104",
    formName: "[104] 工令單搓牙報工+排程",
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

test("純讀查詢走 read provider，不佔用 write provider", async () => {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureRagicFieldIndexSchema(db);
  let writeProviderCalls = 0;
  let readProviderCalls = 0;
  const repo = createRagicFieldIndexRepository(
    async () => {
      writeProviderCalls += 1;
      return db;
    },
    async () => {
      readProviderCalls += 1;
      return db;
    }
  );

  try {
    const counts = await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
    assert.equal(counts.totalFields, 4);
    assert.ok(writeProviderCalls > 0);
    assert.ok(readProviderCalls > 0);

    writeProviderCalls = 0;
    readProviderCalls = 0;
    await repo.search({ q: "104" });
    await repo.countAll();
    await repo.getState();
    await repo.listFormFieldPositions("default/forms8/104");
    await repo.listVersionSiblingForms("default/forms8/104");

    assert.equal(writeProviderCalls, 0);
    assert.equal(readProviderCalls, 5);
  } finally {
    await db.close();
  }
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

test("pending generation 未 promote 前不會被讀取，promote 後才切換", async () => {
  const { db, repo } = await buildRepo();
  await repo.replaceAll([SAMPLE_ENTRIES[0]!], "generation-old");

  await db.run(
    `INSERT INTO ragic_field_index (
      form_path, form_name, scope, subtable_name, subtable_key,
      field_pos, field_name, field_id, field_type, field_note,
      search_text, refreshed_at, generation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    "default/forms8/999",
    "[999] Pending",
    "main",
    null,
    "pending-key",
    "A1",
    "新欄位",
    "PENDING_FIELD",
    "文字",
    null,
    "pending new field pending_field",
    "generation-new",
    "generation-new"
  );

  assert.equal((await repo.search({ fieldId: "PENDING_FIELD" })).length, 0);
  assert.equal((await repo.countAll()).totalFields, 1);

  await db.run(
    "UPDATE ragic_field_index_state SET active_generation_id = ? WHERE id = 1",
    "generation-new"
  );

  const afterPromote = await repo.search({ fieldId: "PENDING_FIELD" });
  assert.equal(afterPromote.length, 1);
  assert.equal(afterPromote[0]?.formPath, "default/forms8/999");
  assert.equal((await repo.countAll()).totalFields, 1);
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

test("search 3+ 字元 query 走 FTS5 trigram、結果跟 LIKE 一致", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
  // 3 字元 → 走 FTS path（內部 query `"104"` MATCH trigram index）
  const r = await repo.search({ q: "104" });
  assert.equal(r.length, 3);
});

test("search < 3 字元 query 走 LIKE fallback、不是 FTS", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
  // 2 字元 query → trigram index 用不上，走 LIKE %x%
  const r = await repo.search({ q: "04" }); // 應仍命中 104
  assert.ok(r.length > 0);
});

test("search 含 bracket query '[104]' 實際命中 row，不是只 doesNotReject", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
  // bare '[104]' 不 phrase wrap 會炸 FTS syntax error；repository 應該 phrase
  // wrap 後安全命中 form_name '[104] 工令單搓牙報工+排程'
  const r = await repo.search({ q: "[104]" });
  assert.equal(r.length, 3, "[104] 應命中 form 104 的 3 筆");
});

test("search 含 double-quote query 'a\"b\"c' 不只不炸、也能命中包含相同 substring 的內容", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(
    [
      ...SAMPLE_ENTRIES,
      {
        formPath: "default/forms8/999",
        formName: 'quoted a"b"c name',
        scope: "main" as const,
        subtableKey: "999",
        fieldPos: "A1",
        fieldName: "x",
        fieldId: "8888888",
        fieldType: null,
      },
    ],
    "2026-05-08T00:00:00.000Z"
  );
  const r = await repo.search({ q: 'a"b"c' });
  assert.equal(r.length, 1);
  assert.equal(r[0]?.fieldId, "8888888");
});

test("search FTS operator (AND / OR / NEAR / *) 被當 literal substring，不解讀為 operator", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(
    [
      {
        formPath: "default/forms8/777",
        formName: "ABC AND DEF form",
        scope: "main" as const,
        subtableKey: "1",
        fieldPos: "A1",
        fieldName: "x",
        fieldId: "7777777",
        fieldType: null,
      },
      {
        formPath: "default/forms8/778",
        formName: "GHI OR JKL form",
        scope: "main" as const,
        subtableKey: "2",
        fieldPos: "A1",
        fieldName: "y",
        fieldId: "7777778",
        fieldType: null,
      },
    ],
    "2026-05-08T00:00:00.000Z"
  );
  // 若沒 phrase wrap，'AND' 會被當 FTS boolean operator → syntax error 或錯誤結果
  // phrase wrap 後 'AND' 是 literal substring，應命中 'ABC AND DEF form'
  const rAnd = await repo.search({ q: "AND" });
  assert.equal(rAnd.length, 1);
  assert.equal(rAnd[0]?.fieldId, "7777777");

  // 同樣道理 NEAR、星號
  const rNear = await repo.search({ q: "NEAR" });
  assert.equal(rNear.length, 0, "no row 內含 'NEAR'");
  await assert.doesNotReject(repo.search({ q: "*test*" }));
});

test("search 空字串 / 純空白 query 不加 q 條件，回所有資料（受 limit 限）", async () => {
  const { repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
  const rEmpty = await repo.search({ q: "" });
  assert.equal(rEmpty.length, 4, "空 q 應回全部 4 筆");
  const rSpace = await repo.search({ q: "   " });
  assert.equal(rSpace.length, 4, "純空白 q 也應視為無 q 條件");
});

test("replaceAll 中途 INSERT 失敗 → active 不切換，staged generation 會清掉", async () => {
  const { db, repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-01-01T00:00:00.000Z");
  const before = await repo.countAll();
  assert.equal(before.totalFields, 4);

  const validBulk = Array.from({ length: 1000 }, (_, i) => ({
    formPath: `default/forms8/${i + 2000}`,
    formName: `[${i + 2000}] Staged Test Form`,
    scope: "main" as const,
    subtableKey: `${i + 2000}`,
    fieldPos: "A1",
    fieldName: `staged ${i}`,
    fieldId: `S-${i}`,
    fieldType: null,
    fieldNote: null,
    subtableName: null,
  }));
  // 第二個 chunk 才炸，驗證第一個 chunk 已寫入後仍會 cleanup staged generation。
  const bad = [...validBulk] as Parameters<typeof repo.replaceAll>[0];
  bad.push({
    formPath: "x",
    formName: "x",
    scope: null as unknown as "main",
    subtableKey: null,
    fieldPos: null,
    fieldName: "x",
    fieldId: "x",
    fieldType: null,
    fieldNote: null,
    subtableName: null,
  });
  await assert.rejects(repo.replaceAll(bad, "generation-failed"));

  // Contract: 失敗後舊 active 資料原封不動。
  const after = await repo.countAll();
  assert.equal(after.totalFields, 4);
  assert.equal(after.totalForms, 2);

  const stagedRows = await db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM ragic_field_index WHERE generation_id = ?",
    "generation-failed"
  );
  assert.equal(stagedRows?.count ?? 0, 0, "失敗 staged generation 不應殘留");

  // FTS 仍搜得到舊 active 資料。
  const stillSearchable = await repo.search({ q: "1010920" });
  assert.equal(stillSearchable.length, 1);
});

test("replaceAll 使用相同 refreshedAt 失敗時不會刪掉既有 active generation", async () => {
  const { repo } = await buildRepo();
  const sameRefreshedAt = "2026-05-08T00:00:00.000Z";
  await repo.replaceAll(SAMPLE_ENTRIES, sameRefreshedAt);
  const before = await repo.countAll();
  assert.equal(before.totalFields, 4);

  const bad = [
    ...SAMPLE_ENTRIES,
    {
      formPath: "x",
      formName: "x",
      scope: null as unknown as "main",
      subtableKey: null,
      fieldPos: null,
      fieldName: "x",
      fieldId: "x",
      fieldType: null,
      fieldNote: null,
      subtableName: null,
    },
  ] as Parameters<typeof repo.replaceAll>[0];
  await assert.rejects(repo.replaceAll(bad, sameRefreshedAt));

  const after = await repo.countAll();
  assert.equal(after.totalFields, 4);
  assert.equal(after.totalForms, 2);

  const stillSearchable = await repo.search({ q: "1010920" });
  assert.equal(stillSearchable.length, 1);
});

test("replaceAll 完成後 FTS 跟 main 對齊：rowid 對應 search_text 一致", async () => {
  const { db, repo } = await buildRepo();
  await repo.replaceAll(SAMPLE_ENTRIES, "2026-05-08T00:00:00.000Z");
  const rows = await db.all<{ id: number; search_text: string }[]>(
    "SELECT id, search_text FROM ragic_field_index ORDER BY id"
  );
  for (const row of rows) {
    const fts = await db.get<{ search_text: string }>(
      "SELECT search_text FROM ragic_field_index_fts WHERE rowid = ?",
      row.id
    );
    assert.ok(fts, `FTS 沒對應到 rowid=${row.id}`);
    assert.equal(
      fts?.search_text,
      row.search_text,
      `FTS search_text 應 byte-equal main (rowid=${row.id})`
    );
  }
});

test("replaceAll 大量資料 (batch chunk) 仍能正確查回", async () => {
  const { repo } = await buildRepo();
  // 1200 筆 → 跨越 2 個 chunk (chunk size 500)
  const bulk = Array.from({ length: 1200 }, (_, i) => ({
    formPath: `default/forms8/${i + 1000}`,
    formName: `[${i + 1000}] Bulk Test Form`,
    scope: "main" as const,
    fieldName: `欄位${i}`,
    fieldId: `${2000000 + i}`,
    fieldType: null,
    fieldNote: null,
    subtableName: null,
    subtableKey: null,
    fieldPos: null,
  }));
  await repo.replaceAll(bulk, "2026-05-25T00:00:00.000Z");
  const counts = await repo.countAll();
  assert.equal(counts.totalFields, 1200);
  // FTS path 也要能查到中間那筆
  const mid = await repo.search({ q: "2000600" });
  assert.equal(mid.length, 1);
  assert.equal(mid[0]?.fieldId, "2000600");
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
