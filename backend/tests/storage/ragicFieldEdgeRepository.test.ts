import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { ensureRagicFieldIndexSchema } from "../../src/storage/sqlite/ragicFieldIndexSchema";
import {
  createRagicFieldIndexRepository,
  type RagicFieldIndexRepository,
} from "../../src/storage/sqlite/ragicFieldIndexRepository";

const NOW = "2026-06-03T00:00:00.000Z";

async function setup(): Promise<{ db: Database; repo: RagicFieldIndexRepository }> {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  return { db, repo };
}

async function seed(
  db: Database,
  f: {
    formPath: string;
    formName: string;
    pos: string;
    name: string;
    id: string;
    note?: string | null;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO ragic_field_index
       (form_path, form_name, scope, field_pos, field_name, field_id, field_note, search_text, refreshed_at)
     VALUES (?, ?, 'main', ?, ?, ?, ?, ?, ?)`,
    f.formPath,
    f.formName,
    f.pos,
    f.name,
    f.id,
    f.note ?? null,
    `${f.formName} ${f.name} ${f.id}`,
    NOW
  );
}

// 通用 seed（可指定 scope / subtable_key / subtable_name），測實體聚類用
async function seedRow(
  db: Database,
  f: {
    formPath: string;
    formName: string;
    scope?: "main" | "subtable";
    subKey?: string | null;
    subName?: string | null;
    pos: string;
    name: string;
    id: string;
    note?: string | null;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO ragic_field_index
       (form_path, form_name, scope, subtable_key, subtable_name, field_pos, field_name, field_id, field_note, search_text, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    f.formPath,
    f.formName,
    f.scope ?? "main",
    f.subKey ?? null,
    f.subName ?? null,
    f.pos,
    f.name,
    f.id,
    f.note ?? null,
    `${f.formName} ${f.name} ${f.id}`,
    NOW
  );
}

// 主圖：
//   表單A: A1(1001)公式 B1+C1 / B1(1002)連結到表單B.名稱 / C1(1003)從表單B.值載入(同步)
//   表單B: 名稱(2001) / 值(2002)公式 A1(=名稱)
//   盤點表: 庫存(9000) / MIS更新QUERY(9001)公式組 dbfcommander 命令 + A1
async function seedMainGraph(db: Database): Promise<void> {
  await seed(db, { formPath: "default/a/1", formName: "表單A", pos: "A1", name: "合計", id: "1001", note: "公式: B1+C1" });
  await seed(db, { formPath: "default/a/1", formName: "表單A", pos: "B1", name: "客戶", id: "1002", note: "唯讀; 連結到表單B表單上的名稱" });
  await seed(db, { formPath: "default/a/1", formName: "表單A", pos: "C1", name: "報價", id: "1003", note: "從表單B表單上的值載入欄位值 (設定為隨時同步)" });
  await seed(db, { formPath: "default/b/2", formName: "表單B", pos: "A1", name: "名稱", id: "2001", note: null });
  await seed(db, { formPath: "default/b/2", formName: "表單B", pos: "B1", name: "值", id: "2002", note: "公式: A1" });
  await seed(db, { formPath: "default/s/9", formName: "盤點對帳表", pos: "A1", name: "庫存", id: "9000", note: null });
  await seed(db, { formPath: "default/s/9", formName: "盤點對帳表", pos: "A64", name: "MIS更新QUERY", id: "9001", note: "公式: 'dbfcommander.exe -q UPDATE LACOUNT.dbf'+A1" });
}

function fieldIds(nodes: { fieldId: string }[]): Set<string> {
  return new Set(nodes.map((n) => n.fieldId));
}

test("rebuildEdges：link/load/formula_ref/side_effect 各類邊都抽出且節點解析", async () => {
  const { db, repo } = await setup();
  await seedMainGraph(db);
  const result = await repo.rebuildEdges(NOW);

  // 6 條 data：A1→B1、A1→C1、B1→名稱(link)、C1→值(load)、值→名稱、MISQ→庫存
  assert.equal(result.dataEdges, 6, "data 邊數");
  assert.equal(result.sideEffectEdges, 1, "side_effect 邊數（dbfcommander）");
  assert.equal(result.resolvedEdges, 6, "全部 data 邊都解析到目標");

  const stats = await repo.getEdgeStats();
  assert.equal(stats.totalSideEffect, 1);
  const types = Object.fromEntries(stats.byType.map((t) => [t.edgeType, t.count]));
  assert.equal(types["formula_ref"], 4, "4 條公式引用");
  assert.equal(types["link"], 1);
  assert.equal(types["load"], 1);
  assert.equal(types["external_db_write"], 1);
});

test("queryDependencies upstream：合計欄位往上游展開到跨表來源", async () => {
  const { db, repo } = await setup();
  await seedMainGraph(db);
  await repo.rebuildEdges(NOW);

  // 合計(1001) 依賴 B1(1002)、C1(1003)；再往上 B1→名稱(2001)、C1→值(2002)；值→名稱(2001)
  const up = await repo.queryDependencies({ fieldId: "1001", direction: "upstream" });
  const ids = fieldIds(up);
  for (const expected of ["1002", "1003", "2001", "2002"]) {
    assert.ok(ids.has(expected), `upstream 應含 ${expected}`);
  }
  // load 邊帶 sync 屬性
  const loadEdge = up.find((n) => n.edgeType === "load");
  assert.equal(loadEdge?.sync, true, "load 的隨時同步屬性要帶出");
  // 跨表節點要 join 到表單名
  const crossForm = up.find((n) => n.fieldId === "2001");
  assert.equal(crossForm?.formName, "表單B");
});

test("queryDependencies downstream：名稱欄位被誰依賴（改它波及誰）", async () => {
  const { db, repo } = await setup();
  await seedMainGraph(db);
  await repo.rebuildEdges(NOW);

  // 名稱(2001) 被 B1(1002,link) 與 值(2002,formula) 直接依賴；再往下 1002←1001、2002←1003
  const down = await repo.queryDependencies({ fieldId: "2001", direction: "downstream" });
  const ids = fieldIds(down);
  for (const expected of ["1002", "2002", "1001", "1003"]) {
    assert.ok(ids.has(expected), `downstream 應含 ${expected}`);
  }
});

test("queryDependencies：循環依賴不會無限遞迴（A→B→A）", async () => {
  const { db, repo } = await setup();
  await seed(db, { formPath: "default/cyc/5", formName: "迴圈表", pos: "A1", name: "X", id: "5001", note: "公式: B1" });
  await seed(db, { formPath: "default/cyc/5", formName: "迴圈表", pos: "B1", name: "Y", id: "5002", note: "公式: A1" });
  await repo.rebuildEdges(NOW);

  // 不應 hang / throw；path 去環後 X 的上游只到 Y 為止
  const up = await repo.queryDependencies({ fieldId: "5001", direction: "upstream", maxDepth: 25 });
  const ids = fieldIds(up);
  assert.ok(ids.has("5002"), "上游含 Y");
  assert.ok(!ids.has("5001"), "去環後不應把自己（X）算進上游");
});

test("listSideEffects：列出會寫外部系統的欄位（含來源表單名）", async () => {
  const { db, repo } = await setup();
  await seedMainGraph(db);
  await repo.rebuildEdges(NOW);

  const se = await repo.listSideEffects();
  assert.equal(se.length, 1);
  assert.equal(se[0]!.edgeType, "external_db_write");
  assert.equal(se[0]!.via, "dbfcommander");
  assert.equal(se[0]!.srcFieldName, "MIS更新QUERY");
  assert.equal(se[0]!.srcFormName, "盤點對帳表");
});

test("rebuildEdges 可重複執行（全量替換、不累加）", async () => {
  const { db, repo } = await setup();
  await seedMainGraph(db);
  const first = await repo.rebuildEdges(NOW);
  const second = await repo.rebuildEdges(NOW);
  assert.equal(first.totalEdges, second.totalEdges, "重建後邊數不變、不重複累加");
});

// 實體 9000：兩個多版本視圖（x/1, y/2 同 mainKey）+ 一個子表引用 + 一個懸空 key
async function seedEntityGraph(db: Database): Promise<void> {
  const ORD = "唯讀; 不可重複; 自動產生: ORD{1`date`yyyyMM}-{0`number`0000}";
  await seedRow(db, { formPath: "default/x/1", formName: "訂單A視圖", subKey: "9000", pos: "A1", name: "訂單號", id: "100", note: ORD });
  await seedRow(db, { formPath: "default/x/1", formName: "訂單A視圖", subKey: "9000", pos: "B1", name: "金額", id: "101", note: "公式: A1*2" });
  await seedRow(db, { formPath: "default/y/2", formName: "訂單B視圖", subKey: "9000", pos: "A1", name: "訂單號", id: "100", note: ORD });
  await seedRow(db, { formPath: "default/y/2", formName: "訂單B視圖", subKey: "9000", pos: "C1", name: "備註", id: "102", note: null });
  await seedRow(db, { formPath: "default/z/3", formName: "出貨單", scope: "subtable", subKey: "9000", subName: "訂單明細", pos: "A1", name: "訂單號", id: "100" });
  // 懸空：只當子表目標、沒有 main 實體
  await seedRow(db, { formPath: "default/w/4", formName: "孤兒引用", scope: "subtable", subKey: "8888", subName: "明細", pos: "A1", name: "X", id: "200" });
}

test("listEntities：多版本視圖聚成實體 + 懸空父表標記", async () => {
  const { db, repo } = await setup();
  await seedEntityGraph(db);
  await repo.rebuildEdges(NOW);
  const ents = await repo.listEntities();

  const e9000 = ents.find((e) => e.entityKey === "9000");
  assert.ok(e9000, "實體 9000 存在");
  assert.equal(e9000!.viewCount, 2, "兩個多版本視圖");
  assert.equal(e9000!.fieldCount, 3, "distinct 欄位 100/101/102");
  assert.equal(e9000!.refCount, 1, "被 1 個子表引用");
  assert.equal(e9000!.dangling, false);

  const e8888 = ents.find((e) => e.entityKey === "8888");
  assert.ok(e8888, "懸空 key 8888 也在清單");
  assert.equal(e8888!.dangling, true, "僅子表引用→懸空");
});

test("getEntityFields：欄位分類(角色/約束/FK) + 掛它的子表", async () => {
  const { db, repo } = await setup();
  await seedEntityGraph(db);
  await repo.rebuildEdges(NOW);
  const d = await repo.getEntityFields("9000");

  assert.equal(d.fields.length, 3, "合併視圖後 3 個 distinct 欄位");
  assert.equal(d.views.length, 2, "兩個視圖");
  const orderNo = d.fields.find((f) => f.fieldId === "100");
  assert.equal(orderNo!.unique, true, "不可重複→unique");
  assert.equal(orderNo!.autoGen, true, "自動產生");
  assert.equal(orderNo!.role, "primary");
  const amount = d.fields.find((f) => f.fieldId === "101");
  assert.equal(amount!.role, "derived", "公式→衍生");
  assert.equal(d.childTables.length, 1, "1 個子表掛它");
  assert.equal(d.childTables[0]!.subtableName, "訂單明細");
});
