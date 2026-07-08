import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { ensureRagicFieldIndexSchema } from "../../src/storage/sqlite/ragicFieldIndexSchema";
import {
  createRagicFieldIndexRepository,
  type RagicFieldIndexRepository,
} from "../../src/storage/sqlite/ragicFieldIndexRepository";

const NOW = "2026-06-04T00:00:00.000Z";

async function setup(): Promise<{ db: Database; repo: RagicFieldIndexRepository }> {
  const db = await open({ filename: ":memory:", driver: sqlite3.Database });
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  return { db, repo };
}

async function seedField(
  db: Database,
  f: { formPath: string; formName: string; name: string; id: string }
): Promise<void> {
  await db.run(
    `INSERT INTO ragic_field_index
       (form_path, form_name, scope, field_pos, field_name, field_id, search_text, refreshed_at)
     VALUES (?, ?, 'main', 'A1', ?, ?, ?, ?)`,
    f.formPath,
    f.formName,
    f.name,
    f.id,
    `${f.formName} ${f.name} ${f.id}`,
    NOW
  );
}

async function seedEdge(
  db: Database,
  e: {
    src: string;
    scope: string;
    type: string;
    targetForm?: string | null;
    targetFieldId?: string | null;
    via?: string | null;
    target?: string | null;
    resolved?: number;
    occ?: number;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO ragic_workflow_edge
       (src_form_path, scope, edge_type, target_form_path, target_field_id, external_via, external_target, resolved, occur_count, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.src,
    e.scope,
    e.type,
    e.targetForm ?? null,
    e.targetFieldId ?? null,
    e.via ?? null,
    e.target ?? null,
    e.resolved ?? 0,
    e.occ ?? 1,
    NOW
  );
}

async function seedSource(
  db: Database,
  s: { formPath: string; scope: string; js: string }
): Promise<void> {
  await db.run(
    `INSERT INTO ragic_workflow_source (form_path, scope, js, char_count, refreshed_at)
     VALUES (?, ?, ?, ?, ?)`,
    s.formPath,
    s.scope,
    s.js,
    s.js.length,
    NOW
  );
}

// 圖：a/1 的 workflow → query c/3、query 自己 a/1（自我）、setFieldValue 5000、external googleapis
//     x/9 的 workflow → query a/1（讓 a/1 有入度 / 上游）
//     field_id 5000 同時存在 a/1（本表欄位）與 b/2（別表欄位）→ 測 writes 不可張冠李戴
async function seedGraph(db: Database): Promise<void> {
  await seedField(db, { formPath: "default/a/1", formName: "表單A", name: "本表欄位", id: "5000" });
  await seedField(db, { formPath: "default/b/2", formName: "表單B", name: "別表欄位", id: "5000" });
  await seedEdge(db, { src: "default/a/1", scope: "button", type: "query", targetForm: "default/c/3", resolved: 1, occ: 3 });
  await seedEdge(db, { src: "default/a/1", scope: "post", type: "query", targetForm: "default/a/1", resolved: 1, occ: 2 }); // 自我引用
  await seedEdge(db, { src: "default/a/1", scope: "button", type: "set", targetFieldId: "5000", occ: 4 });
  await seedEdge(db, { src: "default/a/1", scope: "button", type: "external", via: "http", target: "https://translation.googleapis.com", occ: 1 });
  await seedEdge(db, { src: "default/x/9", scope: "post", type: "query", targetForm: "default/a/1", resolved: 1, occ: 5 });
  await seedSource(db, { formPath: "default/a/1", scope: "button", js: "function btn(){}" });
  await seedSource(db, { formPath: "default/a/1", scope: "pre", js: "// pre" });
}

test("getWorkflowEdgeStats：型別計數 + 入度榜排除自我引用", async () => {
  const { db, repo } = await setup();
  await seedGraph(db);
  const stats = await repo.getWorkflowEdgeStats();

  assert.equal(stats.formsWithWorkflow, 2, "有 workflow 邊的 distinct src = a/1, x/9");
  assert.equal(stats.queryEdges, 3, "query 邊 3 條");
  assert.equal(stats.setEdges, 1);
  assert.equal(stats.externalEdges, 1);
  // 入度榜：a/1 被 x/9 query（入度 1），自我 a/1→a/1 不得算入
  const a1 = stats.topDepended.find((t) => t.formPath === "default/a/1");
  assert.equal(a1?.dependedByCount, 1, "a/1 入度只算 x/9，排除自我引用");
});

test("getWorkflowFormDeps：下游排自我、上游、writes 鎖定本表欄位名（不張冠李戴）、externals、sourceScopes", async () => {
  const { db, repo } = await setup();
  await seedGraph(db);
  const deps = await repo.getWorkflowFormDeps("default/a/1");

  assert.deepEqual(deps.downstreamForms.map((d) => d.targetFormPath), ["default/c/3"], "下游 query c/3，排除自我 a/1→a/1");
  assert.deepEqual(deps.upstreamForms.map((u) => u.srcFormPath), ["default/x/9"], "上游 = x/9 query 它");
  // A 修正核心：field_id 5000 跨 a/1 與 b/2，writes 必須取本表 a/1 的「本表欄位」，不可對到 b/2 的「別表欄位」
  assert.equal(deps.writes.length, 1);
  assert.equal(deps.writes[0]!.fieldId, "5000");
  assert.equal(deps.writes[0]!.fieldName, "本表欄位", "鎖定本表，不可張冠李戴成別表欄位");
  assert.equal(deps.writes[0]!.formPath, "default/a/1", "formPath 鎖定本表，避免錯 ragicUrl");
  assert.deepEqual(deps.externals.map((x) => x.target), ["https://translation.googleapis.com"]);
  assert.deepEqual(deps.sourceScopes, ["button", "pre"], "sourceScopes 含 a/1 的兩個 scope（已排序）");
});

test("getWorkflowFormDeps：查無 workflow 的表回全空（不丟錯）", async () => {
  const { db, repo } = await setup();
  await seedGraph(db);
  const deps = await repo.getWorkflowFormDeps("default/zzz/0");

  assert.deepEqual(deps.downstreamForms, []);
  assert.deepEqual(deps.upstreamForms, []);
  assert.deepEqual(deps.writes, []);
  assert.deepEqual(deps.externals, []);
  assert.deepEqual(deps.sourceScopes, []);
});

test("getWorkflowSource：命中回原文、未命中回 null", async () => {
  const { db, repo } = await setup();
  await seedGraph(db);

  const hit = await repo.getWorkflowSource("default/a/1", "button");
  assert.equal(hit?.js, "function btn(){}");
  assert.equal(hit?.charCount, "function btn(){}".length);

  const miss = await repo.getWorkflowSource("default/a/1", "post");
  assert.equal(miss, null, "post scope 沒 source → null");
});
