import test from "node:test";
import assert from "node:assert/strict";
import type { RagicRecord } from "../../../src/ragic/client";
import {
  ACTIVITY_LOG_WORK_ORDER_REQUIRED_TYPES,
  detectNonWhitelistedOrphanType,
  isActivityLogOrphan,
  parseActivityLogCreatedAtMs,
} from "../../../src/services/activityLog/activityLogOrphanPolicy";

// 最小 helper：Ragic 回的 record 是以欄位名稱為 key 的物件
function makeRecord(fields: Record<string, string>): RagicRecord {
  return fields as unknown as RagicRecord;
}

function baseValidOrphan(): Record<string, string> {
  return {
    "demo_work_order_no": "",
    "計畫停機?": "No",
    "demo_report_type": "PROC-A",
    "demo_created_by": "示範帳號",
    "demo_part_no": "DEMO-PART-001",
    "demo_created_at": "2026/04/14 20:42:00",
  };
}

test("isActivityLogOrphan — 標準五 AND 全中命中", () => {
  assert.equal(
    isActivityLogOrphan(makeRecord(baseValidOrphan()), { creatorAccount: "示範帳號" }),
    true
  );
});

test("isActivityLogOrphan — workOrderNo 非空 就不算（901/902 正常報工）", () => {
  const r = { ...baseValidOrphan(), "demo_work_order_no": "WO-DEMO-0001" };
  assert.equal(isActivityLogOrphan(makeRecord(r), { creatorAccount: "示範帳號" }), false);
});

test("isActivityLogOrphan — 計畫停機=Yes 就不算（合法停機紀錄 workOrderNo 本來就空）", () => {
  const r = { ...baseValidOrphan(), "demo_planned_idle": "Yes" };
  assert.equal(isActivityLogOrphan(makeRecord(r), { creatorAccount: "示範帳號" }), false);
});

test("isActivityLogOrphan — 報工類別不在白名單就不算（PA 包裝合法空工令）", () => {
  const r = { ...baseValidOrphan(), "demo_report_type": "PROC-PACK" };
  assert.equal(isActivityLogOrphan(makeRecord(r), { creatorAccount: "示範帳號" }), false);
});

test("isActivityLogOrphan — 每個白名單類別都命中", () => {
  for (const reportType of ACTIVITY_LOG_WORK_ORDER_REQUIRED_TYPES) {
    const r = { ...baseValidOrphan(), "demo_report_type": reportType };
    assert.equal(
      isActivityLogOrphan(makeRecord(r), { creatorAccount: "示範帳號" }),
      true,
      `${reportType} 應該被認為是 orphan`
    );
  }
});

test("isActivityLogOrphan — creator 不符就不算（避免殺他人建的 entry）", () => {
  const r = baseValidOrphan();
  assert.equal(isActivityLogOrphan(makeRecord(r), { creatorAccount: "其他使用者" }), false);
});

test("isActivityLogOrphan — creatorAccount 空值一律拒絕（safeguard）", () => {
  const r = baseValidOrphan();
  assert.equal(isActivityLogOrphan(makeRecord(r), { creatorAccount: "" }), false);
});

test("isActivityLogOrphan — ERP料號含 test 就當測試資料跳過（case insensitive）", () => {
  const variants = ["TEST-PART", "TestBench", "testbed", "Prefix-TEST-Suffix"];
  for (const partNo of variants) {
    const r = { ...baseValidOrphan(), "demo_part_no": partNo };
    assert.equal(
      isActivityLogOrphan(makeRecord(r), { creatorAccount: "示範帳號" }),
      false,
      `part=${partNo} 應該被跳過`
    );
  }
});

test("isActivityLogOrphan — 欄位用 fallback key 也能 resolve", () => {
  // workOrderNo 的 key 變體
  const r = {
    "work_order_no": "",
    "planned_idle": "No",
    "demo_report_type": "PROC-B",
    "demo_created_by": "示範帳號",
  };
  assert.equal(isActivityLogOrphan(makeRecord(r), { creatorAccount: "示範帳號" }), true);
});

test("isActivityLogOrphan — reportType 用 demo_report_type / report_type 兩個 key 擇一", () => {
  const withPrimary = {
    ...baseValidOrphan(),
    "demo_report_type": "PROC-B",
  };
  const withFallback: Record<string, string> = {
    "work_order_no": "",
    "planned_idle": "No",
    "report_type": "PROC-B",
    "demo_created_by": "示範帳號",
  };
  assert.equal(
    isActivityLogOrphan(makeRecord(withPrimary), { creatorAccount: "示範帳號" }),
    true
  );
  assert.equal(
    isActivityLogOrphan(makeRecord(withFallback), { creatorAccount: "示範帳號" }),
    true
  );
});

test("parseActivityLogCreatedAtMs — Ragic 格式 yyyy/MM/dd HH:mm:ss 解析成 +08:00", () => {
  const r = makeRecord({ "demo_created_at": "2026/04/14 20:42:00" });
  const ms = parseActivityLogCreatedAtMs(r);
  assert.ok(ms !== null);
  // 2026-04-14T20:42:00+08:00 = 2026-04-14T12:42:00Z
  const expected = Date.UTC(2026, 3, 14, 12, 42, 0);
  assert.equal(ms, expected);
});

test("parseActivityLogCreatedAtMs — yyyy-MM-dd 變體（dash）一樣吃", () => {
  const r = makeRecord({ "demo_created_at": "2026-04-14 20:42:00" });
  const ms = parseActivityLogCreatedAtMs(r);
  assert.ok(ms !== null);
  const expected = Date.UTC(2026, 3, 14, 12, 42, 0);
  assert.equal(ms, expected);
});

test("parseActivityLogCreatedAtMs — 空值 / 不符格式回 null", () => {
  assert.equal(parseActivityLogCreatedAtMs(makeRecord({})), null);
  assert.equal(
    parseActivityLogCreatedAtMs(makeRecord({ "demo_created_at": "" })),
    null
  );
  assert.equal(
    parseActivityLogCreatedAtMs(makeRecord({ "demo_created_at": "not a date" })),
    null
  );
});

test("detectNonWhitelistedOrphanType — 白名單類別回 null（已由 isActivityLogOrphan 處理）", () => {
  const r = { ...baseValidOrphan(), "demo_report_type": "PROC-A" };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "示範帳號" }),
    null
  );
});

test("detectNonWhitelistedOrphanType — 白名單外但其他條件都中，回該 reportType", () => {
  const r = { ...baseValidOrphan(), "demo_report_type": "UNKNOWN新類別" };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "示範帳號" }),
    "UNKNOWN新類別"
  );
});

test("detectNonWhitelistedOrphanType — 空 reportType 回 (empty) 字串（讓統計器能收集）", () => {
  const r = { ...baseValidOrphan() };
  delete r["demo_report_type"];
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "示範帳號" }),
    "(empty)"
  );
});

test("detectNonWhitelistedOrphanType — 有 workOrderNo 就回 null（不算待觀察）", () => {
  const r = { ...baseValidOrphan(), "demo_work_order_no": "WO-X", "demo_report_type": "UNKNOWN" };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "示範帳號" }),
    null
  );
});

test("detectNonWhitelistedOrphanType — creator 不符回 null", () => {
  const r = { ...baseValidOrphan(), "demo_report_type": "UNKNOWN" };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "別人" }),
    null
  );
});

test("detectNonWhitelistedOrphanType — ERP料號含 test 回 null", () => {
  const r = {
    ...baseValidOrphan(),
    "demo_report_type": "UNKNOWN",
    "demo_part_no": "TEST-123",
  };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "示範帳號" }),
    null
  );
});

test("parseActivityLogCreatedAtMs — 跨 tz 解析穩定（不受 server local tz 影響）", () => {
  // 明確驗兩個 input 的 ms 差剛好 1 小時
  const a = parseActivityLogCreatedAtMs(
    makeRecord({ "demo_created_at": "2026/04/14 20:42:00" })
  );
  const b = parseActivityLogCreatedAtMs(
    makeRecord({ "demo_created_at": "2026/04/14 21:42:00" })
  );
  assert.ok(a !== null && b !== null);
  assert.equal(b - a, 60 * 60 * 1000);
});
