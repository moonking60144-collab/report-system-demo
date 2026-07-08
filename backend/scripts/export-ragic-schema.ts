/**
 * 把 Ragic 結構匯出成「整理外部正規化 DB」的工作底稿。
 *   用法：tsx scripts/export-ragic-schema.ts <db-path> [out-dir]
 *
 * 產出：
 *   ragic-field-dictionary.csv  每欄一列：實體/主子表/角色/約束/被依賴數/跨表數
 *   ragic-entities.csv          每實體(mainKey)：多版本視圖、欄位數、被幾子表引用（含懸空父表）
 *   ragic-foreign-keys.csv      link/load FK + 子表→實體 FK + broken 標記
 *   ragic-side-effects.csv      會寫外部系統的欄位
 *   ragic-schema-draft.sql      每實體一張 CREATE TABLE（PK/FK/computed 標好、欄名去重、保留字引號）
 *
 * 模型（實測）：mainKey 是實體身份；main scope 同 mainKey = 同實體多版本視圖（塌成一張表）；
 * subtable scope 的 subtable_key 指向它引用的實體 = FK。
 */
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureRagicFieldIndexSchema } from "../src/storage/sqlite/ragicFieldIndexSchema";
import { createRagicFieldIndexRepository } from "../src/storage/sqlite/ragicFieldIndexRepository";
import {
  classifyConstraints,
  classifyRole,
  fkTargetName,
  isBrokenNote,
  type RagicFieldRole,
} from "../src/services/dev/ragicSchemaClassify";

const ROLE_LABEL: Record<RagicFieldRole, string> = {
  primary: "原始",
  derived: "衍生(公式)",
  foreign: "外來(連結/載入)",
  side_effect: "副作用",
};

// SQL 保留字（命中即強制引號，避免 KEY/INDEX/DATE… 裸寫 syntax error）
const SQL_RESERVED = new Set(
  "key index references date time timestamp order group table select from where check primary foreign unique default values column constraint user level type comment status desc asc limit offset case when then end null not and or like in is as on by to set all add drop alter create insert update delete join left right inner outer union having distinct".split(
    " "
  )
);

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n"; // BOM：Excel 開中文不亂碼
}

function ident(s: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !SQL_RESERVED.has(s.toLowerCase())) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Ragic 欄位型別 → SQL 型別（粗略草稿；時間精度看 field_note 值格式，本匯出未存，須人工複核）*/
function sqlType(ragicType: string | null): string {
  const t = ragicType ?? "";
  if (/數字|金額|數值/.test(t)) return "NUMERIC";
  if (/日期/.test(t)) return "DATE";
  return "TEXT";
}

interface DictRow {
  form_path: string;
  form_name: string;
  scope: string;
  subtable_key: string | null;
  subtable_name: string | null;
  field_pos: string | null;
  field_name: string;
  field_id: string;
  field_type: string | null;
  field_note: string | null;
  out_types: string | null;
  downstream_cnt: number;
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  const outDir = process.argv[3] ?? "./ragic-schema-export";
  if (!dbPath) throw new Error("用法：tsx scripts/export-ragic-schema.ts <db-path> [out-dir]");
  mkdirSync(outDir, { recursive: true });

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  await repo.rebuildEdges(new Date("2026-06-03T00:00:00Z").toISOString());

  // field_id → 出現在幾個 distinct 表單
  const crossRows = await db.all<Array<{ field_id: string; c: number }>>(
    "SELECT field_id, COUNT(DISTINCT form_path) c FROM ragic_field_index GROUP BY field_id"
  );
  const crossCount = new Map(crossRows.map((r) => [r.field_id, r.c]));

  // ── 欄位字典（downstream_cnt 補 form_path 條件：field_id 跨表非唯一，不補會錯誤累計）
  const dict = await db.all<DictRow[]>(`
    SELECT fi.form_path, fi.form_name, fi.scope, fi.subtable_key, fi.subtable_name,
           fi.field_pos, fi.field_name, fi.field_id, fi.field_type, fi.field_note,
           (SELECT GROUP_CONCAT(DISTINCT e.edge_type) FROM ragic_field_edge e
              WHERE e.src_form_path = fi.form_path AND e.src_field_id = fi.field_id) AS out_types,
           (SELECT COUNT(*) FROM ragic_field_edge e
              WHERE e.target_field_id = fi.field_id AND e.target_form_path = fi.form_path
                AND e.kind = 'data') AS downstream_cnt
    FROM ragic_field_index fi
    ORDER BY fi.subtable_key, fi.form_path, fi.scope DESC, fi.field_pos
  `);

  writeFileSync(
    join(outDir, "ragic-field-dictionary.csv"),
    toCsv(
      ["實體Key", "表單路徑", "表單名", "範圍", "子表名", "位置", "欄位名", "欄位ID", "Ragic型別", "角色", "唯讀", "unique", "必填", "自動產生", "被依賴數", "出現表單數"],
      dict.map((d) => {
        const c = classifyConstraints(d.field_note);
        return [
          d.subtable_key ?? "",
          d.form_path,
          d.form_name,
          d.scope === "subtable" ? "子表" : "主表",
          d.subtable_name ?? "",
          d.field_pos ?? "",
          d.field_name,
          d.field_id,
          d.field_type ?? "",
          ROLE_LABEL[classifyRole(d.out_types, d.field_note)],
          c.readOnly ? "Y" : "",
          c.unique ? "Y" : "",
          c.required ? "Y" : "",
          c.autoGen ? "Y" : "",
          d.downstream_cnt,
          crossCount.get(d.field_id) ?? 1,
        ];
      })
    )
  );

  // ── 實體（main scope GROUP BY mainKey）
  const entities = await db.all<
    Array<{ entity_key: string; view_count: number; views: string; field_count: number }>
  >(`
    SELECT subtable_key AS entity_key,
           COUNT(DISTINCT form_path) AS view_count,
           GROUP_CONCAT(DISTINCT form_path) AS views,
           COUNT(DISTINCT field_id) AS field_count
    FROM ragic_field_index
    WHERE scope = 'main' AND subtable_key IS NOT NULL
    GROUP BY subtable_key ORDER BY field_count DESC
  `);
  const mainKeys = new Set(entities.map((e) => e.entity_key));

  // 代表表單名 = 該 mainKey 中「欄位最多」的視圖（非字典序首視圖）
  const repRows = await db.all<Array<{ subtable_key: string; form_name: string; cnt: number }>>(`
    SELECT subtable_key, form_name, COUNT(*) cnt
    FROM ragic_field_index WHERE scope='main' AND subtable_key IS NOT NULL
    GROUP BY subtable_key, form_path ORDER BY subtable_key, cnt DESC, form_path
  `);
  const repName = new Map<string, string>();
  for (const r of repRows) if (!repName.has(r.subtable_key)) repName.set(r.subtable_key, r.form_name);

  // 子表（distinct form_path + subtable_key）：FK 來源 + 父實體被引用統計 + 懸空 key 偵測
  const subtableRows = await db.all<
    Array<{ form_path: string; subtable_name: string | null; subtable_key: string }>
  >(`
    SELECT DISTINCT form_path, subtable_name, subtable_key
    FROM ragic_field_index WHERE scope='subtable' AND subtable_key IS NOT NULL
  `);
  const refCount = new Map<string, number>();
  const childrenByParent = new Map<string, string[]>();
  for (const r of subtableRows) {
    refCount.set(r.subtable_key, (refCount.get(r.subtable_key) ?? 0) + 1);
    const arr = childrenByParent.get(r.subtable_key) ?? [];
    arr.push(r.form_path);
    childrenByParent.set(r.subtable_key, arr);
  }
  // 懸空父表：被子表引用、但沒有 main 實體（doc.jsp 沒抓到主視圖 or 純子表實體）
  const danglingKeys = [...refCount.keys()].filter((k) => !mainKeys.has(k)).sort();

  writeFileSync(
    join(outDir, "ragic-entities.csv"),
    toCsv(
      ["實體Key", "代表表單名", "多版本視圖數", "distinct欄位數", "被幾個子表引用", "視圖清單"],
      [
        ...entities.map((e) => [
          e.entity_key,
          repName.get(e.entity_key) ?? "",
          e.view_count,
          e.field_count,
          refCount.get(e.entity_key) ?? 0,
          e.views,
        ]),
        ...danglingKeys.map((k) => [k, "(僅子表引用，無主視圖)", 0, 0, refCount.get(k) ?? 0, ""]),
      ]
    )
  );

  // ── 外鍵：link/load + 子表→實體 FK + broken 標記
  const fkEdges = await db.all<
    Array<{
      src_form_path: string;
      src_field_name: string | null;
      edge_type: string;
      target_form_name: string | null;
      target_field_raw: string | null;
      sync: number | null;
      resolved: number;
      broken: number;
    }>
  >(`
    SELECT src_form_path, src_field_name, edge_type, target_form_name, target_field_raw, sync, resolved, broken
    FROM ragic_field_edge WHERE edge_type IN ('link','load') ORDER BY src_form_path
  `);
  const fkRows: unknown[][] = fkEdges.map((e) => [
    e.src_form_path,
    e.src_field_name ?? "",
    e.edge_type === "link" ? "連結(FK)" : e.sync ? "載入-即時鏡像(sync,正規化可刪)" : "載入-快照(非sync,刪前需保值)",
    e.target_form_name ?? "",
    e.target_field_raw ?? "",
    e.sync ? "Y" : "",
    e.resolved ? "Y" : "",
    e.broken ? "Y" : "",
  ]);
  // 子表→所屬實體 FK（正規化核心：把子表掛回父表）
  for (const r of subtableRows) {
    const resolvedParent = mainKeys.has(r.subtable_key);
    fkRows.push([
      r.form_path,
      r.subtable_name ?? "(子表)",
      "子表FK(屬於)",
      resolvedParent ? repName.get(r.subtable_key) ?? `entity_${r.subtable_key}` : `(懸空:無主視圖 key=${r.subtable_key})`,
      "(父實體主鍵)",
      "",
      resolvedParent ? "Y" : "",
      "",
    ]);
  }
  writeFileSync(
    join(outDir, "ragic-foreign-keys.csv"),
    toCsv(["來源表", "來源欄位", "關係", "目標表單", "目標欄位", "隨時同步", "已解析", "失聯broken"], fkRows)
  );

  // ── 副作用
  const se = await repo.listSideEffects();
  writeFileSync(
    join(outDir, "ragic-side-effects.csv"),
    toCsv(
      ["表單路徑", "表單名", "欄位名", "類型", "經由", "目標"],
      se.map((s) => [s.srcFormPath, s.srcFormName ?? "", s.srcFieldName ?? "", s.edgeType, s.via ?? "", s.target ?? ""])
    )
  );

  // ── CREATE TABLE 草稿
  // 每 field_id 選「資訊最完整視圖」當代表（避開 broken note，否則丟 FK 目標/約束）
  const mainFields = dict.filter((d) => d.scope === "main" && d.subtable_key);
  const byEntity = new Map<string, Map<string, DictRow>>();
  for (const d of mainFields) {
    let m = byEntity.get(d.subtable_key!);
    if (!m) {
      m = new Map();
      byEntity.set(d.subtable_key!, m);
    }
    const ex = m.get(d.field_id);
    if (!ex || (isBrokenNote(ex.field_note) && !isBrokenNote(d.field_note))) m.set(d.field_id, d);
  }
  const sqlParts: string[] = [
    "-- Ragic → 外部 DB schema 草稿（自動產生，需人工複核）",
    "-- 每個實體 = 一個 mainKey；多版本視圖已合併；角色/約束見註解",
    "-- 子表 FK 見 ragic-foreign-keys.csv（子表獨立建表 1011 個 instance，需人工處理，這裡僅在父表註解列出）",
    "",
  ];
  const entityOrder = [...byEntity.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [key, fields] of entityOrder) {
    const name = repName.get(key) ?? `entity_${key}`;
    const viewCnt = entities.find((e) => e.entity_key === key)?.view_count ?? 1;
    const children = childrenByParent.get(key) ?? [];
    sqlParts.push(`-- 實體 ${key}（${name}）：${viewCnt} 個多版本視圖、${fields.size} 欄、被 ${children.length} 個子表引用`);
    sqlParts.push(`CREATE TABLE ${ident("entity_" + key)} (`);
    const usedNames = new Set<string>();
    const cols: string[] = [];
    for (const d of fields.values()) {
      const c = classifyConstraints(d.field_note);
      const role = classifyRole(d.out_types, d.field_note);
      const roleLabel = ROLE_LABEL[role];
      const marks: string[] = [];
      if (c.unique && c.autoGen) marks.push("PK候選(系統序號)");
      else if (c.unique) marks.push("UNIQUE");
      if (role === "foreign") {
        const tgt = fkTargetName(d.field_note);
        if (tgt) marks.push(`FK→${tgt}`);
        else if (isBrokenNote(d.field_note)) marks.push("FK→(Ragic連結已失效)");
        else marks.push("FK→(待人工確認)");
      }
      if (role === "derived") marks.push("computed/VIEW，勿存原始值");
      if (role === "side_effect") marks.push("外部副作用,搬不走");
      // 欄名去重：不同 field_id 同 field_name 會撞 → 後綴 field_id 消歧
      let colName = d.field_name;
      if (usedNames.has(colName)) colName = `${colName}_${d.field_id}`;
      usedNames.add(colName);
      const comment = `${d.field_id} | ${roleLabel}${c.readOnly ? " | 唯讀" : ""}${marks.length ? " | " + marks.join(",") : ""}`;
      cols.push(`  ${ident(colName)} ${sqlType(d.field_type)},  -- ${comment.replace(/\n/g, " ")}`);
    }
    sqlParts.push(cols.join("\n"));
    sqlParts.push(");");
    if (children.length) {
      sqlParts.push(`-- ↑ 被以下子表引用(FK 指向本表)：${[...new Set(children)].join(", ")}`);
    }
    sqlParts.push("");
  }
  // 懸空父表 placeholder
  for (const key of danglingKeys) {
    sqlParts.push(
      `-- 實體 ${key}：僅被 ${refCount.get(key) ?? 0} 個子表引用，doc.jsp 未抓到主視圖（純子表實體 or 抓取覆蓋缺口，需人工確認）`
    );
    sqlParts.push(`-- CREATE TABLE ${ident("entity_" + key)} ( /* 主視圖缺，無欄位可產生 */ );`, "");
  }
  writeFileSync(join(outDir, "ragic-schema-draft.sql"), sqlParts.join("\n"));

  console.log(`匯出完成 → ${outDir}`);
  console.log(`  欄位字典：${dict.length} 列`);
  console.log(`  實體：${entities.length} 個 main 實體 + ${danglingKeys.length} 個懸空(僅子表引用)`);
  console.log(`  外鍵：${fkEdges.length} link/load + ${subtableRows.length} 子表FK = ${fkRows.length} 條`);
  console.log(`  副作用欄位：${se.length} 個`);
  console.log(`  CREATE TABLE 草稿：${entityOrder.length} 張表 + ${danglingKeys.length} 懸空註解`);

  await db.close();
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
