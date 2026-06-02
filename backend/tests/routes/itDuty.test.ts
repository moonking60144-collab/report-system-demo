import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createItDutyRouter } from "../../src/routes/itDuty";
import {
  createItDutyRepository,
  type ItDutyRepository,
} from "../../src/storage/sqlite/itDutyRepository";
import { ensureItDutySchema } from "../../src/storage/sqlite/itDutySchema";
import { errorHandler } from "../../src/middleware/errorHandler";

async function buildRepoWithDb(): Promise<{ db: Database; repo: ItDutyRepository }> {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureItDutySchema(db);
  const repo = createItDutyRepository(async () => db);
  return { db, repo };
}

async function withTestServer(
  repo: ItDutyRepository,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/api", createItDutyRouter(repo));
  app.use(errorHandler);

  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("GET /api/it/duty/members 空表回空陣列", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/members`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { data: [] });
  });
});

test("POST /api/it/duty/members 建立人員", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.name, "Alice");
    assert.equal(body.data.active, true);
    assert.equal(body.data.sortOrder, 0);
  });
});

test("POST /api/it/duty/members 沒帶 name 回 400", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /api/it/duty/members 空白 name 回 400", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(res.status, 400);
  });
});

test("PATCH /api/it/duty/members/:id 更新 name", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "Old" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/members/${m.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.name, "New");
  });
});

test("PATCH /api/it/duty/members/:id 不存在回 404", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/members/9999`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ghost" }),
    });
    assert.equal(res.status, 404);
  });
});

test("PATCH /api/it/duty/members/:id 空 patch 回 400", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "X" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/members/${m.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("DELETE /api/it/duty/members/:id 成功 + 再刪回 404", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "X" });
  await withTestServer(repo, async (baseUrl) => {
    const res1 = await fetch(`${baseUrl}/api/it/duty/members/${m.id}`, {
      method: "DELETE",
    });
    assert.equal(res1.status, 200);
    const res2 = await fetch(`${baseUrl}/api/it/duty/members/${m.id}`, {
      method: "DELETE",
    });
    assert.equal(res2.status, 404);
  });
});

test("PUT /api/it/duty/members/order 重排序", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  const c = await repo.insertMember({ name: "C" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/members/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds: [c.id, a.id, b.id] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.data.map((m: { name: string }) => m.name),
      ["C", "A", "B"]
    );
  });
});

test("PUT /api/it/duty/members/order 重複 id 回 400", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/members/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds: [a.id, a.id] }),
    });
    assert.equal(res.status, 400);
  });
});

test("GET /api/it/duty/overrides 不帶 from/to 回所有 overrides", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({ isoWeek: "2026-W18", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W19", memberId: m.id });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/overrides`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 2);
  });
});

test("GET /api/it/duty/overrides 帶 from/to 過濾範圍", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({ isoWeek: "2026-W17", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W18", memberId: m.id });
  await repo.upsertOverride({ isoWeek: "2026-W19", memberId: m.id });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/it/duty/overrides?from=2026-W18&to=2026-W19`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.data.map((o: { isoWeek: string }) => o.isoWeek),
      ["2026-W18", "2026-W19"]
    );
  });
});

test("GET /api/it/duty/overrides 壞 isoWeek 格式回 400", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/it/duty/overrides?from=2026-18&to=2026-W30`
    );
    assert.equal(res.status, 400);
  });
});

test("PUT /api/it/duty/overrides/:isoWeek 建立 override", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "A" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/overrides/2026-W18`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: m.id, note: "first" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.isoWeek, "2026-W18");
    assert.equal(body.data.memberId, m.id);
    assert.equal(body.data.note, "first");
  });
});

test("PUT /api/it/duty/overrides/:isoWeek 接受 propagateForward=false", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "A" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/overrides/2026-W18`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: m.id, propagateForward: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.propagateForward, false);
  });
});

test("PUT /api/it/duty/overrides/:isoWeek propagateForward 非布林回 400", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "A" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/overrides/2026-W18`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: m.id, propagateForward: "no" }),
    });
    assert.equal(res.status, 400);
  });
});

test("PUT /api/it/duty/overrides/:isoWeek 不存在的 memberId 回 404", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/overrides/2026-W18`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: 9999 }),
    });
    assert.equal(res.status, 404);
  });
});

test("PUT /api/it/duty/overrides/:isoWeek 壞 isoWeek 路徑回 400", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "A" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/overrides/2026-18`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: m.id }),
    });
    assert.equal(res.status, 400);
  });
});

test("DELETE /api/it/duty/overrides/:isoWeek 成功 + 再刪回 404", async () => {
  const { repo } = await buildRepoWithDb();
  const m = await repo.insertMember({ name: "A" });
  await repo.upsertOverride({ isoWeek: "2026-W18", memberId: m.id });
  await withTestServer(repo, async (baseUrl) => {
    const res1 = await fetch(`${baseUrl}/api/it/duty/overrides/2026-W18`, {
      method: "DELETE",
    });
    assert.equal(res1.status, 200);
    const res2 = await fetch(`${baseUrl}/api/it/duty/overrides/2026-W18`, {
      method: "DELETE",
    });
    assert.equal(res2.status, 404);
  });
});

test("GET /api/it/duty/settings 回預設 weeksPerSlot=1", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/settings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.weeksPerSlot, 1);
  });
});

test("PUT /api/it/duty/settings 更新 weeksPerSlot", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weeksPerSlot: 3 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.weeksPerSlot, 3);
  });
});

test("PUT /api/it/duty/settings 越界回 400", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const r1 = await fetch(`${baseUrl}/api/it/duty/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weeksPerSlot: 0 }),
    });
    assert.equal(r1.status, 400);
    const r2 = await fetch(`${baseUrl}/api/it/duty/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weeksPerSlot: "abc" }),
    });
    assert.equal(r2.status, 400);
    const r3 = await fetch(`${baseUrl}/api/it/duty/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weeksPerSlot: 100 }),
    });
    assert.equal(r3.status, 400);
  });
});

// === Swap endpoints ===

test("GET /api/it/duty/swaps 空表回空陣列", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { data: [] });
  });
});

test("POST /api/it/duty/swaps/leave 建立請假代班", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coverDate: "2026-05-06",
        originalMemberId: a.id,
        coverMemberId: b.id,
        note: "請假",
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.reason, "leave");
    assert.equal(body.data.pairedSwapId, null);
    assert.equal(body.data.note, "請假");
  });
});

test("POST /api/it/duty/swaps/leave 同 originalMember=coverMember 回 400", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coverDate: "2026-05-06",
        originalMemberId: a.id,
        coverMemberId: a.id,
      }),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /api/it/duty/swaps/leave 同 cover_date 第二次回 409", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  await repo.createLeaveSwap({
    coverDate: "2026-05-06",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coverDate: "2026-05-06",
        originalMemberId: a.id,
        coverMemberId: b.id,
      }),
    });
    assert.equal(res.status, 409);
  });
});

test("POST /api/it/duty/swaps/leave 壞日期格式回 400", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coverDate: "2026-13-99",
        originalMemberId: a.id,
        coverMemberId: b.id,
      }),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /api/it/duty/swaps/leave 不存在的 memberId 回 404", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coverDate: "2026-05-06",
        originalMemberId: a.id,
        coverMemberId: 9999,
      }),
    });
    assert.equal(res.status, 404);
  });
});

test("POST /api/it/duty/swaps/repay 建立還班 + 配對 leave", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  const leave = await repo.createLeaveSwap({
    coverDate: "2026-05-06",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/repay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coverDate: "2026-05-18",
        pairLeaveSwapId: leave.id,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.repay.reason, "repay");
    assert.equal(body.data.repay.pairedSwapId, leave.id);
    assert.equal(body.data.leave.pairedSwapId, body.data.repay.id);
  });
});

test("POST /api/it/duty/swaps/repay 不存在 leave 回 404", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/repay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coverDate: "2026-05-18",
        pairLeaveSwapId: 9999,
      }),
    });
    assert.equal(res.status, 404);
  });
});

test("POST /api/it/duty/swaps/repay 已配對的 leave 再 repay 回 404", async () => {
  const { repo } = await buildRepoWithDb();
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
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/repay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coverDate: "2026-05-19",
        pairLeaveSwapId: leave.id,
      }),
    });
    assert.equal(res.status, 404);
  });
});

test("DELETE /api/it/duty/swaps/:id 連動刪配對方", async () => {
  const { repo } = await buildRepoWithDb();
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
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/${leave.id}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 200);
  });
  // 連動：repay 也應消失
  assert.equal(await repo.getSwapById(result.repay.id), null);
});

test("DELETE /api/it/duty/swaps/:id 不存在回 404", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/swaps/9999`, {
      method: "DELETE",
    });
    assert.equal(res.status, 404);
  });
});

test("GET /api/it/duty/debts 聚合未清算 leave", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
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
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/it/duty/debts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].debtorMemberId, a.id);
    assert.equal(body.data[0].creditorMemberId, b.id);
    assert.equal(body.data[0].unsettledDays, 2);
  });
});

test("GET /api/it/duty/swaps from/to 過濾", async () => {
  const { repo } = await buildRepoWithDb();
  const a = await repo.insertMember({ name: "A" });
  const b = await repo.insertMember({ name: "B" });
  await repo.createLeaveSwap({
    coverDate: "2026-04-01",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  await repo.createLeaveSwap({
    coverDate: "2026-05-15",
    originalMemberId: a.id,
    coverMemberId: b.id,
  });
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/it/duty/swaps?from=2026-05-01&to=2026-05-31`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].coverDate, "2026-05-15");
  });
});

test("GET /api/it/duty/swaps 壞日期格式回 400", async () => {
  const { repo } = await buildRepoWithDb();
  await withTestServer(repo, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/it/duty/swaps?from=2026-13-99&to=2026-05-31`
    );
    assert.equal(res.status, 400);
  });
});
