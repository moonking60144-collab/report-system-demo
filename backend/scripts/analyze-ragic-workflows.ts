/**
 * 解析撈到的 workflow JS（.cache/ragic-workflows/*.js），抽出 field_note 那層看不到的「JS 盲區」依賴。
 * 解析與寫表的核心已抽到 ../src/services/dev/ragicWorkflowAnalyze（與 backend 直讀 .nui service 共用）；
 * 這支只負責 CLI 編排：讀本機 .js → parseFile → 印統計 / 匯出 CSV / rebuild 兩張表。
 *   node --import tsx scripts/analyze-ragic-workflows.ts
 */
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureRagicFieldIndexSchema } from "../src/storage/sqlite/ragicFieldIndexSchema";
import {
  parseFile,
  rebuildWorkflowEdges,
  rebuildWorkflowSources,
  type ParsedFile,
} from "../src/services/dev/ragicWorkflowAnalyze";

const WF_DIR = "./.cache/ragic-workflows";
const DB = process.env.RAGIC_DUMP_DB || ".cache/work-report-read-model.v1.sqlite3";
const OUT_DIR = "./.cache";

/** 檔名 default_forms8_71__button.js → { safe: 'default_forms8_71', scope: 'button' } */
function parseFileName(file: string): { safe: string; scope: string } | null {
  const m = /^(.+)__(pre|post|button)\.js$/.exec(file);
  if (!m) return null;
  return { safe: m[1]!, scope: m[2]! };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(name: string, header: string[], rows: Array<Array<string | number>>): void {
  const lines = [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  writeFileSync(join(OUT_DIR, name), lines.join("\n"), "utf-8");
}

async function main(): Promise<void> {
  if (!existsSync(WF_DIR)) throw new Error(`找不到 ${WF_DIR}，先跑 dump-ragic-workflows.ts`);

  // safe→form_path 映射（form_path 含 '/'，落檔時被換成 '_'，反查最可靠靠 DB 清單）
  const db = await open({ filename: DB, driver: sqlite3.Database });
  await ensureRagicFieldIndexSchema(db); // 確保 ragic_workflow_edge 存在（新 DB / 舊部署都安全）
  const forms = await db.all<Array<{ form_path: string }>>(
    "SELECT DISTINCT form_path FROM ragic_field_index"
  );
  const safeToPath = new Map<string, string>();
  for (const { form_path } of forms) safeToPath.set(form_path.replace(/[/\\]/g, "_"), form_path);
  const knownPaths = new Set(forms.map((f) => f.form_path));

  const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".js"));
  const parsed: ParsedFile[] = [];
  const sources: Array<{ formPath: string; scope: string; js: string }> = [];
  for (const file of files) {
    const meta = parseFileName(file);
    if (!meta) continue;
    const srcFormPath = safeToPath.get(meta.safe) ?? meta.safe.replace(/_/g, "/");
    const content = readFileSync(join(WF_DIR, file), "utf-8");
    parsed.push(parseFile(content, srcFormPath, meta.scope));
    sources.push({ formPath: srcFormPath, scope: meta.scope, js: content });
  }

  // 跨表依賴：(srcForm, targetForm) → query 次數。/forms8/107 補上 src 的 account 前綴
  const crossForm = new Map<string, number>(); // key: src||target
  const crossRows: Array<Array<string | number>> = [];
  for (const p of parsed) {
    const account = p.srcFormPath.split("/")[0];
    for (const q of p.queries) {
      // getAPIQuery 慣例是相對路徑（'/forms8/107'、'forms8/107' 或 'd4/2'）→ 補 src 的 account；已含 account 不重複
      const clean = q.replace(/^\//, "");
      const target = clean.startsWith(`${account}/`) ? clean : `${account}/${clean}`;
      const key = `${p.srcFormPath} ${target}`;
      crossForm.set(key, (crossForm.get(key) ?? 0) + 1);
    }
  }
  for (const [key, cnt] of crossForm) {
    const [src, target] = key.split(" ");
    crossRows.push([src!, target!, cnt, knownPaths.has(target!) ? 1 : 0]);
  }
  crossRows.sort((a, b) => Number(b[2]) - Number(a[2]));

  // 每張 form 被多少其他 form 的 workflow 依賴（入度）
  const inDegree = new Map<string, Set<string>>();
  for (const [key] of crossForm) {
    const [src, target] = key.split(" ");
    if (src === target) continue;
    if (!inDegree.has(target!)) inDegree.set(target!, new Set());
    inDegree.get(target!)!.add(src!);
  }
  const inDegreeRows = [...inDegree.entries()]
    .map(([form, srcs]) => [form, srcs.size, knownPaths.has(form) ? 1 : 0] as Array<string | number>)
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  // setFieldValue 熱點：每 form 寫值次數
  const writeRows: Array<Array<string | number>> = [];
  for (const p of parsed) {
    if (p.setFields.length === 0) continue;
    writeRows.push([p.srcFormPath, p.scope, p.setFields.length, [...new Set(p.setFields)].join(" ")]);
  }
  writeRows.sort((a, b) => Number(b[2]) - Number(a[2]));

  // 外部副作用
  const extRows: Array<Array<string | number>> = [];
  for (const p of parsed) {
    for (const e of p.externals) {
      extRows.push([p.srcFormPath, p.scope, e.via, e.target]);
    }
  }

  writeCsv("ragic-workflow-cross-form.csv", ["src_form", "target_form", "query_count", "target_known"], crossRows);
  writeCsv("ragic-workflow-in-degree.csv", ["form", "depended_by_count", "known"], inDegreeRows);
  writeCsv("ragic-workflow-field-writes.csv", ["src_form", "scope", "set_count", "field_ids"], writeRows);
  writeCsv("ragic-workflow-external.csv", ["src_form", "scope", "via", "target"], extRows);

  // rebuild ragic_workflow_edge / source（供 /dev 前端查詢；獨立表，不碰 rebuildEdges 管的 ragic_field_edge）
  const refreshedAt = new Date().toISOString();
  const wfEdgeCount = await rebuildWorkflowEdges(db, parsed, knownPaths, refreshedAt);
  const wfSourceCount = await rebuildWorkflowSources(db, sources, refreshedAt);
  await db.close();

  const formsWithWf = new Set(parsed.map((p) => p.srcFormPath)).size;
  const totalQueryEdges = crossRows.length;
  const unresolved = crossRows.filter((r) => r[3] === 0).length;

  console.log(`\n=== Workflow JS 解析結果 ===`);
  console.log(`解析檔案：${parsed.length}（${formsWithWf} 張表有 workflow）`);
  console.log(`跨表依賴邊（去重 src→target）：${totalQueryEdges}（其中 ${unresolved} 個 target 不在已知 form 清單）`);
  console.log(`\n--- 被依賴最多的表（入度 top 15）---`);
  for (const [form, cnt, known] of inDegreeRows.slice(0, 15)) {
    console.log(`  ${String(cnt).padStart(3)} 張表的 workflow 動到  ${form}${known ? "" : "  ⚠未知"}`);
  }
  console.log(`\n--- JS 寫值最多的 workflow（setFieldValue top 12）---`);
  for (const [src, scope, cnt] of writeRows.slice(0, 12)) {
    console.log(`  ${String(cnt).padStart(3)} 次 setFieldValue  ${src} [${scope}]`);
  }
  const dbfForms = new Set(extRows.filter((r) => r[2] === "dbf").map((r) => r[0]));
  const httpForms = new Set(extRows.filter((r) => r[2] === "http").map((r) => r[0]));
  const htmlAppForms = new Set(extRows.filter((r) => r[2] === "callHtmlApp").map((r) => r[0]));
  console.log(`\n--- 外部副作用 ---`);
  console.log(`  dbfcommander（寫外部 DBF）：${dbfForms.size} 張表`);
  console.log(`  callHtmlApp（呼叫外部 app）：${htmlAppForms.size} 張表`);
  console.log(`  http(s):// 連外：${httpForms.size} 張表`);
  console.log(`\n寫入 ragic_workflow_edge：${wfEdgeCount} 列（去重後）`);
  console.log(`寫入 ragic_workflow_source：${wfSourceCount} 筆原文`);
  console.log(`CSV → ${OUT_DIR}/ragic-workflow-{cross-form,in-degree,field-writes,external}.csv`);
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
