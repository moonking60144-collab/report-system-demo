import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createConnectionSerializer } from "../../src/storage/sqlite/sqliteClient";

async function buildSerializer() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  const serializer = createConnectionSerializer(async () => db);
  return { db, ...serializer };
}

// timeout guard：deadlock 的回歸會表現為「永不 resolve」，靠 race 把它變成可失敗的測試
// 而非掛死整個 node --test。
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT(${label})`)), ms)
    ),
  ]);
}

test("nested runSerializedWrite inside withWriteTransaction fail-fast throw 而非 self-deadlock", async () => {
  const { runSerializedWrite, withWriteTransaction } = await buildSerializer();

  // 業務規則：同連線 re-entrant serialized write 必須立即 throw（可診斷），不可永久 hang
  await assert.rejects(
    () =>
      withTimeout(
        withWriteTransaction(async () => {
          await runSerializedWrite(async (db) => {
            await db.run("INSERT INTO t (v) VALUES (?)", "inner");
          });
        }),
        500,
        "nested-runSerializedWrite"
      ),
    /re-entrant serialized write detected/
  );
});

test("nested withWriteTransaction inside runSerializedWrite fail-fast throw 而非 self-deadlock", async () => {
  const { runSerializedWrite, withWriteTransaction } = await buildSerializer();

  await assert.rejects(
    () =>
      withTimeout(
        runSerializedWrite(async () => {
          await withWriteTransaction(async (db) => {
            await db.run("INSERT INTO t (v) VALUES (?)", "inner");
          });
        }),
        500,
        "nested-withWriteTransaction"
      ),
    /re-entrant serialized write detected/
  );
});

test("正常併發寫入仍正確序列化（FIFO，不互相插隊）", async () => {
  const { db, runSerializedWrite } = await buildSerializer();
  const order: string[] = [];

  // 同時 fire 多筆，每筆內部 await 一個 microtask 製造交錯機會
  await Promise.all([
    runSerializedWrite(async (d) => {
      order.push("a-start");
      await Promise.resolve();
      await d.run("INSERT INTO t (id, v) VALUES (?, ?)", 1, "a");
      order.push("a-end");
    }),
    runSerializedWrite(async (d) => {
      order.push("b-start");
      await Promise.resolve();
      await d.run("INSERT INTO t (id, v) VALUES (?, ?)", 2, "b");
      order.push("b-end");
    }),
  ]);

  // 序列化代表每筆 start→end 不交錯
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  const rows = await db.all<{ id: number; v: string }[]>("SELECT id, v FROM t ORDER BY id");
  assert.deepEqual(rows, [
    { id: 1, v: "a" },
    { id: 2, v: "b" },
  ]);
});

test("write operation 執行中才進場的並發 write 不被誤判 re-entrant（session cleanup 回歸）", async () => {
  // 業務規則：A 已經在跑（卡在長 await）時，B 從獨立 caller 進來，必須排隊等 A、
  // 不可被當成 re-entrant 而 throw。這是 production 真實時序——auto-sync 的長交易
  // 執行中，session cleanup 的 deleteExpired 進來——舊 WeakSet 版本在此誤判炸掉。
  // 注意：line 62 那個 FIFO 測試是「同步連續 fire」，兩筆都在 operation 真正開始
  // （WeakSet.add）之前排好隊，抓不到這個 bug，所以要這條補。
  const { db, runSerializedWrite } = await buildSerializer();

  let signalAStarted!: () => void;
  const aStarted = new Promise<void>((r) => {
    signalAStarted = r;
  });
  let releaseA!: () => void;
  const aBlocker = new Promise<void>((r) => {
    releaseA = r;
  });

  const aPromise = runSerializedWrite(async (d) => {
    signalAStarted(); // A operation 已開始執行（舊版此刻 activeChains 已 add）
    await aBlocker; // 卡住模擬長 await（交還 event loop）
    await d.run("INSERT INTO t (id, v) VALUES (?, ?)", 1, "a");
  });

  await aStarted; // 確保 A 真的在執行中，才 fire B

  // B 是獨立 caller（非 A 的 callback 內）→ 正確行為是排隊等 A，不 throw
  const bPromise = runSerializedWrite(async (d) => {
    await d.run("INSERT INTO t (id, v) VALUES (?, ?)", 2, "b");
  });

  releaseA();
  await assert.doesNotReject(
    withTimeout(
      Promise.all([aPromise, bPromise]),
      1000,
      "concurrent-during-active"
    )
  );
  const rows = await db.all<{ id: number }[]>("SELECT id FROM t ORDER BY id");
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2]
  );
});

test("operation throw 後 chain 不卡死，後續寫入仍可執行", async () => {
  const { db, runSerializedWrite } = await buildSerializer();

  await assert.rejects(
    () =>
      runSerializedWrite(async () => {
        throw new Error("boom");
      }),
    /boom/
  );

  // 前一筆 throw 不可污染 chain：後續寫入要能正常排進並完成
  await runSerializedWrite(async (d) => {
    await d.run("INSERT INTO t (id, v) VALUES (?, ?)", 9, "after-throw");
  });
  const row = await db.get<{ v: string }>("SELECT v FROM t WHERE id = 9");
  assert.equal(row?.v, "after-throw");
});

test("guard 在 throw 後正確清除 active 標記（不會永久封鎖該連線）", async () => {
  const { db, runSerializedWrite, withWriteTransaction } = await buildSerializer();

  // 先觸發一次 re-entrant throw
  await assert.rejects(
    () =>
      withTimeout(
        withWriteTransaction(async () => {
          await runSerializedWrite(async () => {});
        }),
        500,
        "first-reentrant"
      ),
    /re-entrant serialized write detected/
  );

  // active 標記必須已在 finally 清除，否則下面這筆正常寫入會被誤判成 re-entrant
  await runSerializedWrite(async (d) => {
    await d.run("INSERT INTO t (id, v) VALUES (?, ?)", 5, "recovered");
  });
  const row = await db.get<{ v: string }>("SELECT v FROM t WHERE id = 5");
  assert.equal(row?.v, "recovered");
});
