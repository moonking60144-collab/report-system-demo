import test from "node:test";
import assert from "node:assert/strict";
import type { RagicRecord } from "../../../src/ragic/client";
import {
  FORM16_WORK_ORDER_REQUIRED_TYPES,
  detectNonWhitelistedOrphanType,
  isForm16Orphan,
  parseForm16CreatedAtMs,
} from "../../../src/services/form16/form16OrphanPolicy";

// 最小 helper：Ragic 回的 record 是以欄位名稱為 key 的物件
function makeRecord(fields: Record<string, string>): RagicRecord {
  return fields as unknown as RagicRecord;
}

function baseValidOrphan(): Record<string, string> {
  return {
    "工令單單號": "",
    "計畫停機?": "No",
    "Type報工類別": "TI-ProcessA",
    "開單者帳號": "羅智加",
    "ERP Part No.完工ERP料號": "5701-RC001-023",
    "Created建立日期時間": "2026/04/14 20:42:00",
  };
}

test("isForm16Orphan — 標準五 AND 全中命中", () => {
  assert.equal(
    isForm16Orphan(makeRecord(baseValidOrphan()), { creatorAccount: "羅智加" }),
    true
  );
});

test("isForm16Orphan — workOrderNo 非空 就不算（104/105 正常報工）", () => {
  const r = { ...baseValidOrphan(), "工令單單號": "WO-25040537" };
  assert.equal(isForm16Orphan(makeRecord(r), { creatorAccount: "羅智加" }), false);
});

test("isForm16Orphan — 計畫停機=Yes 就不算（合法停機紀錄 workOrderNo 本來就空）", () => {
  const r = { ...baseValidOrphan(), "計畫停機?": "Yes" };
  assert.equal(isForm16Orphan(makeRecord(r), { creatorAccount: "羅智加" }), false);
});

test("isForm16Orphan — 報工類別不在白名單就不算（PA 包裝合法空工令）", () => {
  const r = { ...baseValidOrphan(), "Type報工類別": "PA-Pack" };
  assert.equal(isForm16Orphan(makeRecord(r), { creatorAccount: "羅智加" }), false);
});

test("isForm16Orphan — 每個白名單類別都命中", () => {
  for (const reportType of FORM16_WORK_ORDER_REQUIRED_TYPES) {
    const r = { ...baseValidOrphan(), "Type報工類別": reportType };
    assert.equal(
      isForm16Orphan(makeRecord(r), { creatorAccount: "羅智加" }),
      true,
      `${reportType} 應該被認為是 orphan`
    );
  }
});

test("isForm16Orphan — creator 不符就不算（避免殺他人建的 entry）", () => {
  const r = baseValidOrphan();
  assert.equal(isForm16Orphan(makeRecord(r), { creatorAccount: "其他使用者" }), false);
});

test("isForm16Orphan — creatorAccount 空值一律拒絕（safeguard）", () => {
  const r = baseValidOrphan();
  assert.equal(isForm16Orphan(makeRecord(r), { creatorAccount: "" }), false);
});

test("isForm16Orphan — ERP料號含 test 就當測試資料跳過（case insensitive）", () => {
  const variants = ["TEST-PART", "TestBench", "testbed", "Prefix-TEST-Suffix"];
  for (const partNo of variants) {
    const r = { ...baseValidOrphan(), "ERP Part No.完工ERP料號": partNo };
    assert.equal(
      isForm16Orphan(makeRecord(r), { creatorAccount: "羅智加" }),
      false,
      `part=${partNo} 應該被跳過`
    );
  }
});

test("isForm16Orphan — 欄位用 fallback key 也能 resolve", () => {
  // workOrderNo 的 key 變體
  const r = {
    "No.工令單單號": "", // 第 3 candidate，其他兩個不在
    "計畫停機?": "No",
    "Type報工類別": "HF-Forge",
    "開單者帳號": "羅智加",
  };
  assert.equal(isForm16Orphan(makeRecord(r), { creatorAccount: "羅智加" }), true);
});

test("isForm16Orphan — reportType 用 Type報工類別 / 報工類別 兩個 key 擇一", () => {
  const withPrimary = {
    ...baseValidOrphan(),
    "Type報工類別": "HF-Forge",
  };
  const withFallback: Record<string, string> = {
    "工令單單號": "",
    "計畫停機?": "No",
    "報工類別": "HF-Forge", // fallback key
    "開單者帳號": "羅智加",
  };
  assert.equal(
    isForm16Orphan(makeRecord(withPrimary), { creatorAccount: "羅智加" }),
    true
  );
  assert.equal(
    isForm16Orphan(makeRecord(withFallback), { creatorAccount: "羅智加" }),
    true
  );
});

test("parseForm16CreatedAtMs — Ragic 格式 yyyy/MM/dd HH:mm:ss 解析成 +08:00", () => {
  const r = makeRecord({ "Created建立日期時間": "2026/04/14 20:42:00" });
  const ms = parseForm16CreatedAtMs(r);
  assert.ok(ms !== null);
  // 2026-04-14T20:42:00+08:00 = 2026-04-14T12:42:00Z
  const expected = Date.UTC(2026, 3, 14, 12, 42, 0);
  assert.equal(ms, expected);
});

test("parseForm16CreatedAtMs — yyyy-MM-dd 變體（dash）一樣吃", () => {
  const r = makeRecord({ "Created建立日期時間": "2026-04-14 20:42:00" });
  const ms = parseForm16CreatedAtMs(r);
  assert.ok(ms !== null);
  const expected = Date.UTC(2026, 3, 14, 12, 42, 0);
  assert.equal(ms, expected);
});

test("parseForm16CreatedAtMs — 空值 / 不符格式回 null", () => {
  assert.equal(parseForm16CreatedAtMs(makeRecord({})), null);
  assert.equal(
    parseForm16CreatedAtMs(makeRecord({ "Created建立日期時間": "" })),
    null
  );
  assert.equal(
    parseForm16CreatedAtMs(makeRecord({ "Created建立日期時間": "not a date" })),
    null
  );
});

test("detectNonWhitelistedOrphanType — 白名單類別回 null（已由 isForm16Orphan 處理）", () => {
  const r = { ...baseValidOrphan(), "Type報工類別": "TI-ProcessA" };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "羅智加" }),
    null
  );
});

test("detectNonWhitelistedOrphanType — 白名單外但其他條件都中，回該 reportType", () => {
  const r = { ...baseValidOrphan(), "Type報工類別": "UNKNOWN新類別" };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "羅智加" }),
    "UNKNOWN新類別"
  );
});

test("detectNonWhitelistedOrphanType — 空 reportType 回 (empty) 字串（讓統計器能收集）", () => {
  const r = { ...baseValidOrphan() };
  delete r["Type報工類別"];
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "羅智加" }),
    "(empty)"
  );
});

test("detectNonWhitelistedOrphanType — 有 workOrderNo 就回 null（不算待觀察）", () => {
  const r = { ...baseValidOrphan(), "工令單單號": "WO-X", "Type報工類別": "UNKNOWN" };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "羅智加" }),
    null
  );
});

test("detectNonWhitelistedOrphanType — creator 不符回 null", () => {
  const r = { ...baseValidOrphan(), "Type報工類別": "UNKNOWN" };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "別人" }),
    null
  );
});

test("detectNonWhitelistedOrphanType — ERP料號含 test 回 null", () => {
  const r = {
    ...baseValidOrphan(),
    "Type報工類別": "UNKNOWN",
    "ERP Part No.完工ERP料號": "TEST-123",
  };
  assert.equal(
    detectNonWhitelistedOrphanType(makeRecord(r), { creatorAccount: "羅智加" }),
    null
  );
});

test("parseForm16CreatedAtMs — 跨 tz 解析穩定（不受 server local tz 影響）", () => {
  // 明確驗兩個 input 的 ms 差剛好 1 小時
  const a = parseForm16CreatedAtMs(
    makeRecord({ "Created建立日期時間": "2026/04/14 20:42:00" })
  );
  const b = parseForm16CreatedAtMs(
    makeRecord({ "Created建立日期時間": "2026/04/14 21:42:00" })
  );
  assert.ok(a !== null && b !== null);
  assert.equal(b - a, 60 * 60 * 1000);
});
