#!/usr/bin/env tsx
// Form 16 孤兒稽核 dry-run（只讀 Ragic，不動資料）
//
// 判定條件、createdAt 解析都走 src/services/form16/form16OrphanPolicy，
// 跟 backend service 共用一份 policy，改條件只要改那一個 file。
//
// 執行（從 backend/ 目錄）：
//   npx tsx scripts/audit-form16-orphans.ts                # 近 90 天、列 20 筆樣本
//   npx tsx scripts/audit-form16-orphans.ts --days=180
//   npx tsx scripts/audit-form16-orphans.ts --sample=50
//   npx tsx scripts/audit-form16-orphans.ts --creator=XXX
//   npx tsx scripts/audit-form16-orphans.ts --debug
//
// 或用 package.json script：npm run audit:form16-orphans -- --days=30

import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import axios from "axios";
import {
  FORM16_FIELD_KEYS,
  pickRagicField,
} from "../src/services/form16/form16FieldKeys";
import {
  FORM16_WORK_ORDER_REQUIRED_TYPES,
  isForm16Orphan,
} from "../src/services/form16/form16OrphanPolicy";
import type { RagicRecord } from "../src/ragic/client";

const PROTOCOL = process.env.RAGIC_PROTOCOL || "https";
const DOMAIN = process.env.RAGIC_DOMAIN || "";
const API_KEY = process.env.RAGIC_API_KEY || "";
const FORM_16_PATH = process.env.RAGIC_FORM_16_PATH || "/default/c1/16";
const DATE_FIELD_ID = process.env.RAGIC_FORM_16_DATE_FIELD_ID || "";

function readArg(name: string, defaultValue: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : defaultValue;
}

const DAYS_BACK = Number(readArg("days", "90"));
const SAMPLE_SIZE = Number(readArg("sample", "20"));
const CREATOR_ACCOUNT = readArg("creator", "羅智加");
const DEBUG = process.argv.includes("--debug");

function validateEnv(): void {
  const missing: string[] = [];
  if (!DOMAIN) missing.push("RAGIC_DOMAIN");
  if (!API_KEY) missing.push("RAGIC_API_KEY");
  if (!DATE_FIELD_ID) missing.push("RAGIC_FORM_16_DATE_FIELD_ID");
  if (missing.length > 0) {
    console.error(`[error] 缺少必要 env：${missing.join(", ")}`);
    process.exit(1);
  }
  if (!Number.isFinite(DAYS_BACK) || DAYS_BACK <= 0) {
    console.error(`[error] --days 必須是正整數`);
    process.exit(1);
  }
  if (!Number.isFinite(SAMPLE_SIZE) || SAMPLE_SIZE < 0) {
    console.error(`[error] --sample 必須是非負整數`);
    process.exit(1);
  }
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

async function fetchForm16Page(
  offset: number,
  pageSize: number,
  dateFrom: string
): Promise<Record<string, RagicRecord>> {
  const baseUrl = `${PROTOCOL}://${DOMAIN}${FORM_16_PATH}`;
  const params = new URLSearchParams();
  params.set("api", "true");
  params.set("limit", String(pageSize));
  params.set("offset", String(offset));
  params.append("where", `${DATE_FIELD_ID},>=,${dateFrom}`);

  const response = await axios.get(baseUrl, {
    params,
    headers: { Authorization: `Basic ${API_KEY}` },
    timeout: 60000,
  });
  return response.data as Record<string, RagicRecord>;
}

interface FetchedEntry {
  entryId: string;
  record: RagicRecord;
}

async function fetchAllForm16Records(): Promise<{
  records: FetchedEntry[];
  dateFrom: string;
}> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_BACK);
  const dateFrom = formatDate(cutoff);

  const pageSize = 1000;
  let offset = 0;
  const all: FetchedEntry[] = [];

  while (true) {
    const data = await fetchForm16Page(offset, pageSize, dateFrom);
    if (!data || typeof data !== "object") break;

    const entries = Object.entries(data).filter(([k]) => /^\d+$/.test(k));
    for (const [entryId, record] of entries) {
      all.push({ entryId, record: record as RagicRecord });
    }
    if (entries.length < pageSize) break;
    offset += pageSize;
  }
  return { records: all, dateFrom };
}

interface Summary {
  entryId: string;
  date: string;
  reportType: string;
  workOrderNo: string;
  plannedDowntime: string;
  processCode: string;
  machineId: string;
  createdAt: string;
  creatorAccount: string;
  erpPartNo: string;
}

function summarize({ entryId, record }: FetchedEntry): Summary {
  return {
    entryId,
    date: pickRagicField(record, FORM16_FIELD_KEYS.date),
    reportType: pickRagicField(record, FORM16_FIELD_KEYS.reportType),
    workOrderNo: pickRagicField(record, FORM16_FIELD_KEYS.workOrderNo),
    plannedDowntime: pickRagicField(record, FORM16_FIELD_KEYS.plannedDowntime),
    processCode: pickRagicField(record, FORM16_FIELD_KEYS.processCode),
    machineId: pickRagicField(record, FORM16_FIELD_KEYS.machineId),
    createdAt: pickRagicField(record, FORM16_FIELD_KEYS.createdAt),
    creatorAccount: pickRagicField(record, FORM16_FIELD_KEYS.creatorAccount),
    erpPartNo: pickRagicField(record, FORM16_FIELD_KEYS.erpPartNo),
  };
}

async function main(): Promise<void> {
  validateEnv();

  console.log(`[info] Form 16 孤兒 dry-run（只讀，不動資料）`);
  console.log(`  domain=${DOMAIN}`);
  console.log(`  path=${FORM_16_PATH}`);
  console.log(`  days_back=${DAYS_BACK}`);
  console.log(`  sample_size=${SAMPLE_SIZE}`);
  console.log(
    `  判定類別：${FORM16_WORK_ORDER_REQUIRED_TYPES.join(" / ")}`
  );
  console.log(`  開單者帳號：${CREATOR_ACCOUNT}（--creator=XXX 可覆蓋）`);

  const t0 = Date.now();
  const { records: all, dateFrom } = await fetchAllForm16Records();
  console.log(
    `\n[info] fetch 完成：${all.length} 筆（date >= ${dateFrom}），耗時 ${Date.now() - t0}ms`
  );

  if (DEBUG) {
    console.log(`\n[debug] 前 1 筆原始 record（讓你對照欄位 key 長相）：`);
    console.log(JSON.stringify(all[0]?.record ?? {}, null, 2));

    const byType = new Map<string, number>();
    for (const entry of all) {
      const t = summarize(entry).reportType || "(empty)";
      byType.set(t, (byType.get(t) ?? 0) + 1);
    }
    console.log(`\n[debug] 全量 依 報工類別 分佈：`);
    for (const [t, n] of Array.from(byType.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t.padEnd(18)} ${n}`);
    }
  }

  const orphans = all.filter((entry) =>
    isForm16Orphan(entry.record, { creatorAccount: CREATOR_ACCOUNT })
  );
  console.log(`\n[result] 孤兒候選：${orphans.length} 筆`);
  if (all.length > 0) {
    const ratio = ((orphans.length / all.length) * 100).toFixed(3);
    console.log(`  佔全量：${ratio}%`);
  }

  if (orphans.length === 0) {
    console.log("\n[ok] 沒找到符合條件的孤兒");
    return;
  }

  const summaries = orphans.map(summarize);

  // 依 date 分佈
  const byDate = new Map<string, number>();
  for (const s of summaries) {
    const date = s.date || "(empty)";
    byDate.set(date, (byDate.get(date) ?? 0) + 1);
  }
  const dateRows = Array.from(byDate.entries()).sort((a, b) =>
    a[0] < b[0] ? 1 : -1
  );
  console.log(`\n[stats] 孤兒依 date 分佈（top 20）：`);
  for (const [date, count] of dateRows.slice(0, 20)) {
    console.log(`  ${date}  ${count}`);
  }

  // 依 reportType 分佈
  const byType = new Map<string, number>();
  for (const s of summaries) {
    const t = s.reportType || "(empty)";
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  console.log(`\n[stats] 孤兒依 報工類別 分佈：`);
  for (const [t, n] of Array.from(byType.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(18)} ${n}`);
  }

  // 樣本
  const showN = Math.min(SAMPLE_SIZE, orphans.length);
  if (showN > 0) {
    console.log(`\n[sample] 前 ${showN} 筆（URL 可直接點進 Ragic 查看）：`);
    const baseUrl = `${PROTOCOL}://${DOMAIN}${FORM_16_PATH}`;
    for (let i = 0; i < showN; i++) {
      const s = summaries[i];
      console.log(
        `  ${s.entryId.padEnd(8)} ${s.date.padEnd(12)} ${s.reportType.padEnd(10)} ${s.machineId.padEnd(8)} ${s.processCode.padEnd(8)} part=${(s.erpPartNo || "-").padEnd(26)} ${s.createdAt.padEnd(20)} ${baseUrl}/${s.entryId}`
      );
    }
  }

  console.log(
    `\n[note] 這支 script 沒動任何資料，只是 dry-run。確認樣本後再討論後續清理與預防流程。`
  );
}

main().catch((err: unknown) => {
  const axiosErr = err as { response?: { data?: unknown }; message?: string };
  console.error("[error]", axiosErr?.response?.data ?? axiosErr?.message ?? err);
  process.exit(1);
});
