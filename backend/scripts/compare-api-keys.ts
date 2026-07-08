#!/usr/bin/env tsx
// Ragic API key 權限對比 dry-run
//
// 從 .env 讀指定的多把 key env var name，對同一組 endpoint 各打一次 listing 讀取，
// 輸出 status / 回傳筆數 對比。
// Key 不會寫進 stdout / log，只顯示 mask 過的前後綴。
//
// 執行（從 backend/ 目錄）：
//   # 預設：對比 RAGIC_API_KEY vs TEST_API_KEY
//   npx tsx scripts/compare-api-keys.ts
//
//   # 自訂任意多把 key (位置參數，第一把作為 baseline、其他每把 diff baseline)
//   npx tsx scripts/compare-api-keys.ts RAGIC_API_KEY TEST_API_KEY KEY_C KEY_D
//
// 新增一把 key 要驗：.env 加 `MY_KEY=...`，然後把 `MY_KEY` 加到 CLI 參數即可，
// 不用改 code。

import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import axios, { AxiosError } from "axios";

const PROTOCOL = process.env.RAGIC_PROTOCOL ?? "https";
const DOMAIN = process.env.RAGIC_DOMAIN ?? "";
const BASE_URL = `${PROTOCOL}://${DOMAIN}`;

const DEFAULT_KEY_NAMES = ["RAGIC_API_KEY", "TEST_API_KEY"];
const KEY_NAMES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_KEY_NAMES;

interface KeyEntry {
  name: string;
  value: string;
}

const KEYS: KeyEntry[] = KEY_NAMES.map((name) => ({
  name,
  value: process.env[name] ?? "",
}));

interface Target {
  label: string;
  path: string;
}

const TARGETS: Target[] = [
  {
    label: "form 16 (工令)",
    path: process.env.RAGIC_FORM_16_PATH ?? "/default/c1/16",
  },
  {
    label: "form 104",
    path: process.env.RAGIC_FORM_104_PATH ?? "/default/forms8/104",
  },
  {
    label: "form 105 (機台)",
    path: process.env.RAGIC_FORM_105_PATH ?? "/default/forms8/105",
  },
  {
    label: "source machine (機台清單)",
    path: process.env.RAGIC_SOURCE_MACHINE ?? "/default/forms51/1",
  },
  {
    label: "source operator (人員)",
    path: process.env.RAGIC_SOURCE_OPERATOR ?? "/default/forms11/13",
  },
  {
    label: "source process (製程)",
    path: process.env.RAGIC_SOURCE_PROCESS ?? "/default/forms51/3",
  },
];

function mask(key: string): string {
  if (!key) return "<empty>";
  if (key.length <= 8) return `<${key.length} chars>`;
  return `${key.slice(0, 4)}...${key.slice(-4)} (${key.length} chars)`;
}

interface ReadResult {
  status: number | "ERR";
  rowCount: number;
  firstRowId: string | null;
  errorMessage?: string;
  ragicStatus?: string;
  ragicMsg?: string;
}

async function testListing(key: string, target: Target): Promise<ReadResult> {
  try {
    const res = await axios.get(`${BASE_URL}${target.path}`, {
      headers: { Authorization: `Basic ${key}` },
      params: { api: "", listing: "", limit: 1 },
      timeout: 15000,
      validateStatus: () => true,
    });

    let rowCount = 0;
    let firstRowId: string | null = null;
    let ragicStatus: string | undefined;
    let ragicMsg: string | undefined;

    if (res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
      const keys = Object.keys(res.data);
      // Ragic listing 回傳 { "<rowId>": {...}, ... }；失敗時可能回 { status, msg }
      const possibleStatus = (res.data as Record<string, unknown>).status;
      const possibleMsg = (res.data as Record<string, unknown>).msg;
      if (typeof possibleStatus === "string") {
        ragicStatus = possibleStatus;
      }
      if (typeof possibleMsg === "string") {
        ragicMsg = possibleMsg;
      }
      rowCount = keys.filter((k) => k !== "status" && k !== "msg" && k !== "code").length;
      firstRowId = rowCount > 0 ? keys.find((k) => k !== "status" && k !== "msg" && k !== "code") ?? null : null;
    }

    return {
      status: res.status,
      rowCount,
      firstRowId,
      ragicStatus,
      ragicMsg,
    };
  } catch (e) {
    const err = e as AxiosError;
    return {
      status: "ERR",
      rowCount: 0,
      firstRowId: null,
      errorMessage: err.message,
    };
  }
}

function formatResult(label: string, r: ReadResult): string {
  const parts = [
    `status=${r.status}`,
    `rows=${r.rowCount}`,
  ];
  if (r.firstRowId) parts.push(`firstRowId=${r.firstRowId}`);
  if (r.ragicStatus) parts.push(`ragicStatus=${r.ragicStatus}`);
  if (r.ragicMsg) parts.push(`ragicMsg="${r.ragicMsg}"`);
  if (r.errorMessage) parts.push(`err="${r.errorMessage}"`);
  return `  ${label}: ${parts.join("  ")}`;
}

function diff(a: ReadResult, b: ReadResult): string {
  if (a.status !== b.status) return `DIFFER (status ${a.status} vs ${b.status})`;
  if (a.rowCount !== b.rowCount) return `DIFFER (rows ${a.rowCount} vs ${b.rowCount})`;
  if ((a.ragicStatus ?? "") !== (b.ragicStatus ?? "")) {
    return `DIFFER (ragicStatus "${a.ragicStatus ?? ""}" vs "${b.ragicStatus ?? ""}")`;
  }
  return "SAME";
}

async function main(): Promise<void> {
  console.log("=== Ragic API Key Permission Compare ===");
  console.log(`Base URL : ${BASE_URL || "<empty>"}`);
  for (const k of KEYS) {
    console.log(`${k.name.padEnd(20)}: ${mask(k.value)}`);
  }
  console.log(`Baseline : ${KEYS[0]?.name ?? "<none>"} (first arg)`);
  console.log("");

  if (!DOMAIN) {
    console.error("[ERROR] RAGIC_DOMAIN is empty");
    process.exit(1);
  }
  if (KEYS.length === 0) {
    console.error("[ERROR] no key names given");
    process.exit(1);
  }
  const missing = KEYS.filter((k) => !k.value).map((k) => k.name);
  if (missing.length > 0) {
    console.error(`[ERROR] env vars empty: ${missing.join(", ")}`);
    process.exit(1);
  }

  const labelWidth = Math.max(...KEYS.map((k) => k.name.length));

  for (const target of TARGETS) {
    console.log(`--- ${target.label}`);
    console.log(`    GET ${target.path}?api&listing&limit=1`);
    const results = await Promise.all(KEYS.map((k) => testListing(k.value, target)));
    const baseline = results[0];
    results.forEach((r, i) => {
      const label = KEYS[i].name.padEnd(labelWidth);
      const diffNote = i === 0 ? "(baseline)" : `vs baseline: ${diff(baseline, r)}`;
      console.log(formatResult(label, r) + `  ${diffNote}`);
    });
    console.log("");
  }
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
