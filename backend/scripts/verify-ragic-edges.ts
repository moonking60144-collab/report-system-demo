/**
 * 一次性驗證：對真實 ragic_field_index（54339 列）端到端跑 rebuildEdges，
 * 對照 audit 預期數字 + 抽樣依賴查詢。讀的是 DB 的 .backup 副本，不碰 production。
 *   用法：tsx scripts/verify-ragic-edges.ts <db-copy-path>
 */
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { ensureRagicFieldIndexSchema } from "../src/storage/sqlite/ragicFieldIndexSchema";
import { createRagicFieldIndexRepository } from "../src/storage/sqlite/ragicFieldIndexRepository";

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error("需要傳 db copy path");
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);

  const mainCount = await db.get<{ c: number }>(
    "SELECT COUNT(*) c FROM ragic_field_index"
  );
  console.log(`主索引列數: ${mainCount?.c}`);

  const t0 = Date.now();
  const result = await repo.rebuildEdges(new Date("2026-06-03T00:00:00Z").toISOString());
  console.log(`\n=== rebuildEdges (${Date.now() - t0}ms) ===`);
  console.log(JSON.stringify(result, null, 2));

  const stats = await repo.getEdgeStats();
  console.log("\n=== 各類邊數（對照 audit）===");
  for (const t of stats.byType) console.log(`  ${t.edgeType.padEnd(20)} ${t.count}`);
  console.log(
    `  總 data=${stats.totalData} resolved=${stats.resolvedData} broken=${stats.brokenData} side_effect=${stats.totalSideEffect}`
  );

  const se = await repo.listSideEffects();
  console.log(`\n=== side-effect 欄位 (${se.length}) ===`);
  for (const s of se) {
    console.log(`  [${s.edgeType}] ${s.srcFormName ?? s.srcFormPath} / ${s.srcFieldName} via=${s.via} target=${s.target ?? "-"}`);
  }

  // 抽樣：outgoing data 邊最多的欄位，查它的 upstream
  const top = await db.get<{ src_field_id: string; c: number }>(
    "SELECT src_field_id, COUNT(*) c FROM ragic_field_edge WHERE kind='data' AND target_field_id IS NOT NULL GROUP BY src_field_id ORDER BY c DESC LIMIT 1"
  );
  if (top) {
    const meta = await db.get<{ form_name: string; field_name: string }>(
      "SELECT form_name, field_name FROM ragic_field_index WHERE field_id = ?",
      top.src_field_id
    );
    const up = await repo.queryDependencies({
      fieldId: top.src_field_id,
      direction: "upstream",
      maxDepth: 10,
    });
    console.log(
      `\n=== 抽樣 upstream: ${meta?.form_name}/${meta?.field_name} (${top.src_field_id}) → ${up.length} 個依賴 ===`
    );
    for (const n of up.slice(0, 25)) {
      console.log(`  L${n.depth} [${n.edgeType}${n.sync ? "/同步" : ""}] ${n.formName ?? "?"}/${n.fieldName ?? "?"} (${n.fieldId})`);
    }
  }

  // 抽樣：跨表 link 最深的鏈（找一個 load 來源在別表的欄位查 upstream）
  const crossLink = await db.get<{ src_field_id: string }>(
    "SELECT src_field_id FROM ragic_field_edge WHERE edge_type='load' AND resolved=1 AND target_field_id IS NOT NULL LIMIT 1"
  );
  if (crossLink) {
    const up = await repo.queryDependencies({
      fieldId: crossLink.src_field_id,
      direction: "upstream",
      maxDepth: 10,
    });
    const maxDepth = up.reduce((m, n) => Math.max(m, n.depth), 0);
    console.log(`\n=== 抽樣跨表 load 欄位 ${crossLink.src_field_id} upstream: ${up.length} 節點, 最深 L${maxDepth} ===`);
  }

  // 可選：probe 指定 field_id，驗證去重（length 應 === distinct field_id 數）
  const probe = process.argv[3];
  if (probe) {
    for (const dir of ["upstream", "downstream"] as const) {
      const r = await repo.queryDependencies({ fieldId: probe, direction: dir, maxDepth: 10 });
      const distinct = new Set(r.map((n) => n.fieldId)).size;
      console.log(
        `\n${dir} of ${probe}: ${r.length} 節點 / distinct ${distinct} ${r.length === distinct ? "✓ 無重複" : "✗ 仍重複"}`
      );
    }
  }

  await db.close();
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
