import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createItDutyRepository } from "../../src/storage/sqlite/itDutyRepository";
import { ensureItDutySchema } from "../../src/storage/sqlite/itDutySchema";

async function buildRepo() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureItDutySchema(db);
  const repo = createItDutyRepository(async () => db);
  return { db, repo };
}

test("初始 listMembers 為空陣列", async () => {
  const { repo } = await buildRepo();
  const list = await repo.listMembers();
  assert.deepEqual(list, []);
});

test("insertMember 自動指派 sortOrder（從 0 開始遞增）", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "Alice" });
  const b = await repo.insertMember({ name: "Bob" });
  const c = await repo.insertMember({ name: "Carol" });
  assert.equal(a.sortOrder, 0);
  assert.equal(b.sortOrder, 1);
  assert.equal(c.sortOrder, 2);
  assert.equal(a.active, true);
});

test("insertMember active=false 寫入後 listMembers 反映", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "Inactive", active: false });
  assert.equal(m.active, false);
  const list = await repo.listMembers();
  assert.equal(list[0]?.active, false);
});

test("listMembers 依 sort_order 排序", async () => {
  const { repo } = await buildRepo();
  await repo.insertMember({ name: "A", sortOrder: 5 });
  await repo.insertMember({ name: "B", sortOrder: 1 });
  await repo.insertMember({ name: "C", sortOrder: 3 });
  const list = await repo.listMembers();
  assert.deepEqual(
    list.map((m) => m.name),
    ["B", "C", "A"]
  );
});

test("updateMember 部分更新 name", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "Original" });
  const updated = await repo.updateMember(m.id, { name: "Renamed" });
  assert.equal(updated?.name, "Renamed");
  assert.equal(updated?.active, true);
});

test("updateMember 切 active=false 不影響 name", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "Keep" });
  const updated = await repo.updateMember(m.id, { active: false });
  assert.equal(updated?.name, "Keep");
  assert.equal(updated?.active, false);
});

test("updateMember 不存在 id 回 null", async () => {
  const { repo } = await buildRepo();
  const result = await repo.updateMember(9999, { name: "ghost" });
  assert.equal(result, null);
});

test("deleteMember 成功回 true，再次刪同 id 回 false", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "ToDelete" });
  assert.equal(await repo.deleteMember(m.id), true);
  assert.equal(await repo.deleteMember(m.id), false);
});

test("reorderMembers 重新指派 sort_order 從 0 起", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  const c = await repo.insertMember({ name: "C" });
  // 反向排：C, B, A
  const reordered = await repo.reorderMembers([c.id, b.id, a.id]);
  assert.deepEqual(
    reordered.map((m) => m.name),
    ["C", "B", "A"]
  );
  assert.equal(reordered[0]?.sortOrder, 0);
  assert.equal(reordered[1]?.sortOrder, 1);
  assert.equal(reordered[2]?.sortOrder, 2);
});

test("upsertOverride 第一次 insert", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "Alice" });
  const o = await repo.upsertOverride({
    isoWeek: "2026-W18",
    memberId: m.id,
    note: "first week",
    updatedByLabel: "device-1",
  });
  assert.equal(o.isoWeek, "2026-W18");
  assert.equal(o.memberId, m.id);
  assert.equal(o.note, "first week");
  assert.equal(o.updatedByLabel, "device-1");
});

test("upsertOverride 預設 propagateForward=true", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "A" });
  const o = await repo.upsertOverride({ isoWeek: "2026-W18", memberId: m.id });
  assert.equal(o.propagateForward, true);
});

test("upsertOverride 顯示傳 propagateForward=false 會被持久化", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "A" });
  const o = await repo.upsertOverride({
    isoWeek: "2026-W18",
    memberId: m.id,
    propagateForward: false,
  });
  assert.equal(o.propagateForward, false);
  const all = await repo.listAllOverrides();
  assert.equal(all[0]?.propagateForward, false);
});

test("upsertOverride 第二次更新會覆蓋 propagateForward", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({
    isoWeek: "2026-W18",
    memberId: m.id,
    propagateForward: false,
  });
  const updated = await repo.upsertOverride({
    isoWeek: "2026-W18",
    memberId: m.id,
    propagateForward: true,
  });
  assert.equal(updated.propagateForward, true);
});

test("upsertOverride 同 isoWeek 第二次 update memberId", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  await repo.upsertOverride({ isoWeek: "2026-W18", memberId: a.id });
  await repo.upsertOverride({ isoWeek: "2026-W18", memberId: b.id });
  const all = await repo.listAllOverrides();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.memberId, b.id);
});

test("listOverridesInRange 邊界包含 from 與 to", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({ isoWeek: "2026-W17", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W18", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W19", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W20", memberId: m.id });
  const inRange = await repo.listOverridesInRange("2026-W18", "2026-W19");
  assert.deepEqual(
    inRange.map((o) => o.isoWeek),
    ["2026-W18", "2026-W19"]
  );
});

test("getMostRecentOverride 找 ≤ 目標週的最近一筆", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({ isoWeek: "2026-W10", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W18", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W30", memberId: m.id });
  const r = await repo.getMostRecentOverride("2026-W25");
  assert.equal(r?.isoWeek, "2026-W18");
});

test("getMostRecentOverride 沒任何 ≤ 目標週的回 null", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({ isoWeek: "2026-W30", memberId: m.id });
  const r = await repo.getMostRecentOverride("2026-W10");
  assert.equal(r, null);
});

test("deleteMember 連動 CASCADE 刪除 override", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({ isoWeek: "2026-W18", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W19", memberId: m.id });
  assert.equal((await repo.listAllOverrides()).length, 2);
  await repo.deleteMember(m.id);
  assert.equal((await repo.listAllOverrides()).length, 0);
});

test("deleteOverride 成功回 true，不存在回 false", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({ isoWeek: "2026-W18", memberId: m.id });
  assert.equal(await repo.deleteOverride("2026-W18"), true);
  assert.equal(await repo.deleteOverride("2026-W18"), false);
});

test("listAllOverrides 依 isoWeek 排序", async () => {
  const { repo } = await buildRepo();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({ isoWeek: "2026-W30", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W10", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W20", memberId: m.id });
  const all = await repo.listAllOverrides();
  assert.deepEqual(
    all.map((o) => o.isoWeek),
    ["2026-W10", "2026-W20", "2026-W30"]
  );
});

test("getMember 不存在回 null、存在回完整資料", async () => {
  const { repo } = await buildRepo();
  assert.equal(await repo.getMember(9999), null);
  const m = await repo.insertMember({ name: "Eve" });
  const got = await repo.getMember(m.id);
  assert.equal(got?.name, "Eve");
  assert.equal(got?.id, m.id);
});

test("getSetting schema seed 後預設 weeksPerSlot=1、anchor 兩欄 null（沒 member）", async () => {
  const { repo } = await buildRepo();
  const setting = await repo.getSetting();
  assert.equal(setting.weeksPerSlot, 1);
  assert.equal(setting.anchorIsoWeek, null);
  assert.equal(setting.anchorMemberId, null);
});

test("getSetting 第一次有 member 時自動 seed anchor", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  await repo.insertMember({ name: "B" });
  const setting = await repo.getSetting();
  assert.match(setting.anchorIsoWeek ?? "", /^\d{4}-W\d{2}$/);
  assert.equal(setting.anchorMemberId, a.id);
});

test("getSetting seed 是 idempotent — 第二次呼叫 anchor 不變", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const first = await repo.getSetting();
  // 再加新 member，不該影響已 seed 的 anchor
  await repo.insertMember({ name: "B" });
  const second = await repo.getSetting();
  assert.equal(second.anchorIsoWeek, first.anchorIsoWeek);
  assert.equal(second.anchorMemberId, a.id);
});

test("anchor member 被刪除 → 下次 getSetting refill 成最早 active member、保留 anchor_iso_week", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  const first = await repo.getSetting();
  assert.equal(first.anchorMemberId, a.id);
  // 刪 A → b 成為最早 active
  await repo.deleteMember(a.id);
  const second = await repo.getSetting();
  assert.equal(second.anchorMemberId, b.id);
  assert.equal(second.anchorIsoWeek, first.anchorIsoWeek); // 保留
});

test("anchor member 被停用 (active=false) → refill 成下一個 active", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  await repo.getSetting(); // seed
  await repo.updateMember(a.id, { active: false });
  const after = await repo.getSetting();
  assert.equal(after.anchorMemberId, b.id);
});

test("所有 member 都停用後 anchor_member_id 變 null、anchor_iso_week 保留", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const first = await repo.getSetting();
  await repo.updateMember(a.id, { active: false });
  const after = await repo.getSetting();
  assert.equal(after.anchorMemberId, null);
  assert.equal(after.anchorIsoWeek, first.anchorIsoWeek);
});

test("updateSetting 只動 weeksPerSlot、不影響 anchor", async () => {
  const { repo } = await buildRepo();
  await repo.insertMember({ name: "A" });
  const before = await repo.getSetting();
  const updated = await repo.updateSetting({ weeksPerSlot: 3 });
  assert.equal(updated.weeksPerSlot, 3);
  assert.equal(updated.anchorIsoWeek, before.anchorIsoWeek);
  assert.equal(updated.anchorMemberId, before.anchorMemberId);
});

test("updateSetting 自動 clamp 到 1..52", async () => {
  const { repo } = await buildRepo();
  const low = await repo.updateSetting({ weeksPerSlot: 0 });
  assert.equal(low.weeksPerSlot, 1);
  const high = await repo.updateSetting({ weeksPerSlot: 999 });
  assert.equal(high.weeksPerSlot, 52);
});

// === 日級代班 ===

test("createLeaveSwap 寫入 + listSwapsInRange 可查到", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  const swap = await repo.createLeaveSwap({
    coverDate: "2026-05-06",
    originalMemberId: a.id,
    coverMemberId: b.id,
    note: "請假",
  });
  assert.equal(swap.reason, "leave");
  assert.equal(swap.pairedSwapId, null);
  assert.equal(swap.coverDate, "2026-05-06");
  assert.equal(swap.note, "請假");

  const list = await repo.listSwapsInRange("2026-05-01", "2026-05-31");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, swap.id);
});

test("createLeaveSwap 同一天再寫一次會 throw（UNIQUE 限制）", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  await repo.createLeaveSwap({
    coverDate: "2026-05-06",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  await assert.rejects(() =>
    repo.createLeaveSwap({
      coverDate: "2026-05-06",
      originalMemberId: a.id,
      coverMemberId: b.id,
    })
  );
});

test("createLeaveSwap 拒絕 originalMember === coverMember", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  await assert.rejects(() =>
    repo.createLeaveSwap({
      coverDate: "2026-05-06",
      originalMemberId: a.id,
      coverMemberId: a.id,
    })
  );
});

test("createRepaySwap 跟 leave 雙向配對 → 債務消失", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  // A 請假 1 天，B 代班
  const leave = await repo.createLeaveSwap({
    coverDate: "2026-05-06",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  // 還沒清算前，A 欠 B 1 天
  let debts = await repo.listDebts();
  assert.equal(debts.length, 1);
  assert.equal(debts[0]?.debtorMemberId, a.id);
  assert.equal(debts[0]?.creditorMemberId, b.id);
  assert.equal(debts[0]?.unsettledDays, 1);

  // A 還班：B 原本 5/18 值，A 代班 5/18
  const result = await repo.createRepaySwap({
    coverDate: "2026-05-18",
    pairLeaveSwapId: leave.id,
  });
  assert.equal(result.repay.reason, "repay");
  assert.equal(result.repay.originalMemberId, b.id);
  assert.equal(result.repay.coverMemberId, a.id);
  assert.equal(result.repay.pairedSwapId, leave.id);
  assert.equal(result.leave.pairedSwapId, result.repay.id);

  // 清算後，債務歸零
  debts = await repo.listDebts();
  assert.equal(debts.length, 0);
});

test("createRepaySwap 對不存在的 leave id throw", async () => {
  const { repo } = await buildRepo();
  await assert.rejects(() =>
    repo.createRepaySwap({
      coverDate: "2026-05-18",
      pairLeaveSwapId: 9999,
    })
  );
});

test("createRepaySwap 對已配對的 leave 再 repay 會 throw", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  const leave = await repo.createLeaveSwap({
    coverDate: "2026-05-06",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  await repo.createRepaySwap({
    coverDate: "2026-05-18",
    pairLeaveSwapId: leave.id,
  });
  // 再 repay 同一筆 leave 應該失敗
  await assert.rejects(() =>
    repo.createRepaySwap({
      coverDate: "2026-05-19",
      pairLeaveSwapId: leave.id,
    })
  );
});

test("deleteSwap 刪除已配對的 leave 會連動刪 repay", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  const leave = await repo.createLeaveSwap({
    coverDate: "2026-05-06",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  const result = await repo.createRepaySwap({
    coverDate: "2026-05-18",
    pairLeaveSwapId: leave.id,
  });
  assert.equal((await repo.listAllSwaps()).length, 2);
  await repo.deleteSwap(leave.id);
  // 兩筆都應消失
  assert.equal((await repo.listAllSwaps()).length, 0);
  assert.equal(await repo.getSwapById(result.repay.id), null);
});

test("deleteSwap 對未配對 leave 只刪自己", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  const leave = await repo.createLeaveSwap({
    coverDate: "2026-05-06",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  assert.equal(await repo.deleteSwap(leave.id), true);
  assert.equal((await repo.listAllSwaps()).length, 0);
});

test("listDebts 多筆累計", async () => {
  const { repo } = await buildRepo();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  const c = await repo.insertMember({ name: "C" });
  await repo.createLeaveSwap({
    coverDate: "2026-05-06",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  await repo.createLeaveSwap({
    coverDate: "2026-05-07",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  await repo.createLeaveSwap({
    coverDate: "2026-05-13",
    originalMemberId: c.id,
    coverMemberId: b.id,
  });
  const debts = await repo.listDebts();
  // A 欠 B 2、C 欠 B 1
  assert.equal(debts.length, 2);
  const aToB = debts.find(
    (d) => d.debtorMemberId === a.id && d.creditorMemberId === b.id
  );
  const cToB = debts.find(
    (d) => d.debtorMemberId === c.id && d.creditorMemberId === b.id
  );
  assert.equal(aToB?.unsettledDays, 2);
  assert.equal(cToB?.unsettledDays, 1);
});

// === Day Note ===

test("upsertDayNote 第一次 insert", async () => {
  const { repo } = await buildRepo();
  const created = await repo.upsertDayNote({
    noteDate: "2026-06-01",
    note: "客戶來訪",
  });
  assert.equal(created.noteDate, "2026-06-01");
  assert.equal(created.note, "客戶來訪");
});

test("upsertDayNote 同日第二次覆蓋", async () => {
  const { repo } = await buildRepo();
  const first = await repo.upsertDayNote({
    noteDate: "2026-06-01",
    note: "客戶來訪",
  });
  const second = await repo.upsertDayNote({
    noteDate: "2026-06-01",
    note: "教育訓練",
  });
  assert.equal(second.id, first.id);
  assert.equal(second.note, "教育訓練");
});

test("upsertDayNote 空字串會被 schema CHECK 擋下", async () => {
  const { repo } = await buildRepo();
  // 不再由 repo 驗（route 已驗）；schema CHECK 保底
  await assert.rejects(
    repo.upsertDayNote({ noteDate: "2026-06-01", note: " " }),
    /CHECK constraint failed/
  );
});

test("upsertDayNote 記下 updatedByLabel", async () => {
  const { repo } = await buildRepo();
  const created = await repo.upsertDayNote({
    noteDate: "2026-06-01",
    note: "客戶來訪",
    updatedByLabel: "DEMO-IT-01",
  });
  assert.equal(created.updatedByLabel, "DEMO-IT-01");
});

test("getDayNote / listDayNotesInRange 取得既有資料", async () => {
  const { repo } = await buildRepo();
  await repo.upsertDayNote({ noteDate: "2026-06-01", note: "A" });
  await repo.upsertDayNote({ noteDate: "2026-06-15", note: "B" });
  await repo.upsertDayNote({ noteDate: "2026-07-01", note: "C" });
  const got = await repo.getDayNote("2026-06-15");
  assert.equal(got?.note, "B");
  const inRange = await repo.listDayNotesInRange("2026-06-01", "2026-06-30");
  assert.deepEqual(inRange.map((n) => n.note), ["A", "B"]);
});

test("listAllDayNotes 回所有資料 (依日期升冪)", async () => {
  const { repo } = await buildRepo();
  await repo.upsertDayNote({ noteDate: "2026-07-01", note: "C" });
  await repo.upsertDayNote({ noteDate: "2026-06-01", note: "A" });
  await repo.upsertDayNote({ noteDate: "2026-06-15", note: "B" });
  const all = await repo.listAllDayNotes();
  assert.deepEqual(all.map((n) => n.note), ["A", "B", "C"]);
});

test("deleteDayNote 成功回 true、不存在回 false", async () => {
  const { repo } = await buildRepo();
  await repo.upsertDayNote({ noteDate: "2026-06-01", note: "X" });
  assert.equal(await repo.deleteDayNote("2026-06-01"), true);
  assert.equal(await repo.deleteDayNote("2026-06-01"), false);
  assert.equal(await repo.getDayNote("2026-06-01"), null);
});
