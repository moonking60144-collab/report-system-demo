import { AsyncLocalStorage } from "node:async_hooks";
import fs from "fs/promises";
import path from "path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";
import { initializeReadModelSchema } from "./readModelSchema";
import { ensureItDutySchema } from "./itDutySchema";
import { ensureNoticeAdminUsersSchema } from "./noticeAdminUsersSchema";
import { ensureRagicFieldIndexSchema } from "./ragicFieldIndexSchema";

class SqliteClient {
  private dbPromise: Promise<Database> | null = null;
  private readDbPromise: Promise<Database> | null = null;

  async getDb(): Promise<Database> {
    if (!env.SQLITE_ENABLED) {
      throw new HttpError(503, "SQLite 功能目前未啟用", "SQLITE_DISABLED");
    }

    if (!this.dbPromise) {
      this.dbPromise = this.openDatabase();
    }

    return this.dbPromise;
  }

  /**
   * 唯讀連線：與寫連線分屬不同 SQLite connection。WAL 模式下 reader 只看「最後
   * 一次 COMMIT 的一致 snapshot」。work_report 全量同步會先寫入新的
   * generation，完成後再用 sync_state promote；走這條連線的列表查詢會持續讀
   * active generation，不會撞到正在建構中的 pending generation。
   *
   * 必須先 await getDb()：read-only 連線無法自行建立 WAL 的 -shm/-wal，要掛在
   * 寫連線已初始化好的 WAL 上。SQLITE_DB_FILE=:memory: 時各連線記憶體不共享，
   * 第二條會是空庫 → 回退主連線（同連線下退化成原本行為，僅測試會走到）。
   */
  async getReadDb(): Promise<Database> {
    const writeDb = await this.getDb();
    if (env.SQLITE_DB_FILE === ":memory:") {
      return writeDb;
    }
    if (!this.readDbPromise) {
      this.readDbPromise = this.openReadDatabase();
    }
    return this.readDbPromise;
  }

  async close(): Promise<void> {
    const closers: Array<Promise<void>> = [];

    if (this.readDbPromise) {
      const readDbPromise = this.readDbPromise;
      this.readDbPromise = null;
      closers.push(
        readDbPromise
          .then((db) => db.close())
          .then(
            () => console.info("[sqlite][read-closed]"),
            (error) =>
              console.warn("[sqlite][read-close-failed]", {
                error: error instanceof Error ? error.message : String(error),
              })
          )
      );
    }

    if (this.dbPromise) {
      const dbPromise = this.dbPromise;
      this.dbPromise = null;
      closers.push(
        dbPromise
          .then((db) => db.close())
          .then(
            () => console.info("[sqlite][closed]"),
            (error) =>
              console.warn("[sqlite][close-failed]", {
                error: error instanceof Error ? error.message : String(error),
              })
          )
      );
    }

    await Promise.all(closers);
  }

  /**
   * 把 WAL 搬回主檔並截斷。WAL 預設 passive auto-checkpoint 只在「沒有 reader
   * pin 住舊 snapshot」時才搬得動，長讀 + 背景全量寫交錯下 WAL 會無限膨脹
   * （實測累到 194MB）。全量同步寫完後主動呼叫這個收尾。
   * 排進寫入序列化 chain，等該連線當下的寫入做完再 checkpoint；有 reader
   * 還 pin 著時 TRUNCATE 會 no-op（回非 0、不丟例外），下一輪再截。
   */
  async checkpoint(): Promise<void> {
    if (!this.dbPromise) return;
    try {
      await runSerializedWrite((db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE);"));
    } catch (error) {
      console.warn("[sqlite][checkpoint-failed]", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async openDatabase(): Promise<Database> {
    const dbPath = path.resolve(env.SQLITE_DB_FILE);
    await fs.mkdir(path.dirname(dbPath), { recursive: true });

    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    await db.exec(
      [
        "PRAGMA journal_mode=WAL;",
        "PRAGMA synchronous=NORMAL;",
        "PRAGMA foreign_keys=ON;",
        "PRAGMA busy_timeout=5000;",
      ].join("\n")
    );
    await initializeReadModelSchema(db);
    await ensureItDutySchema(db);
    await ensureRagicFieldIndexSchema(db);
    await ensureNoticeAdminUsersSchema(db);

    // 補救上一次 crash 留下的 stuck 'refreshing' 狀態
    await db.run(
      `
      UPDATE ragic_field_index_state
      SET status = 'idle',
          message = 'recovered on startup',
          updated_at = ?
      WHERE id = 1 AND status = 'refreshing'
      `,
      new Date().toISOString()
    );

    console.info("[sqlite][opened]", { dbPath });
    return db;
  }

  private async openReadDatabase(): Promise<Database> {
    const dbPath = path.resolve(env.SQLITE_DB_FILE);
    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
      mode: sqlite3.OPEN_READONLY,
    });
    // OPEN_READONLY 已在 DB 層強制唯讀；只補 busy_timeout 對齊寫連線，避免
    // checkpoint 短暫持鎖時讀取立即 SQLITE_BUSY。
    await db.exec("PRAGMA busy_timeout=5000;");
    console.info("[sqlite][read-opened]", { dbPath });
    return db;
  }
}

export const sqliteClient = new SqliteClient();

// === 全域寫入序列化 ===
// 6+ 個 repository 共用同一條 sqlite 連線（sqliteClient.getDb 是 singleton）。
// 若每個 repo 各自 serialize，當 field-index 的 replaceAll 還握著一段長
// BEGIN...COMMIT 時，另一個 repo（workReport / form16 snapshot，由 auto-sync
// 觸發）在同一條連線發 BEGIN，就會 nested BEGIN → SQLITE_ERROR。
// 解法：以「連線實例」為 key 維護單一 writeChain，所有寫入排到同一條 chain。
// 用 WeakMap keyed by Database 是為了讓注入測試 db（:memory: per test）各自
// 有獨立 chain、不互相污染，同時 production singleton 永遠只有一條 chain。
const writeChains = new WeakMap<Database, Promise<void>>();

// re-entrant 偵測用 AsyncLocalStorage，而非 WeakSet。
// 關鍵差異：要區分「真 re-entrant」（在某筆 write 的 operation callback 內又對
// 同連線排新 write → 內層排在外層後、外層等內層 → 永久 hang）vs「正常並發」
// （A 還在 await db.run 時 B 從獨立 caller 進來排隊，這是 serialized write 的
// 正常用途，B 該等 A）。
// WeakSet 在「operation 執行中」恆為 true（含 await 交還 event loop 的空檔），
// 同步檢查無法區分這兩者 → 會把正常並發誤判成 re-entrant 炸掉（session cleanup
// 與 auto-sync 並發就是這樣被誤殺）。
// AsyncLocalStorage 跟隨 async 執行脈絡：只有「在 operation 的 async context 內」
// 再進同連線才命中 store → 精準抓真 re-entrant；獨立 caller 的並發 getStore()
// 為 undefined，正常排隊不誤判。
const writeContext = new AsyncLocalStorage<Set<Database>>();

function chainOnConnection<T>(
  db: Database,
  operation: () => Promise<T>
): Promise<T> {
  const activeSet = writeContext.getStore();
  if (activeSet?.has(db)) {
    throw new Error(
      "[sqlite] re-entrant serialized write detected：runSerializedWrite / " +
        "withWriteTransaction 的 callback 內嚴禁再呼叫 runSerializedWrite / " +
        "withWriteTransaction（同連線會 self-deadlock）。子操作請改用吃 db 參數的純函式（*WithDb）。"
    );
  }
  const previous = writeChains.get(db) ?? Promise.resolve();
  const scheduled = previous
    .catch(() => {
      // 上一筆失敗不可卡死後續寫入
    })
    .then(() => {
      // operation 跑在帶有「目前脈絡已進入的 db set」的 async context 內，
      // 讓它內部若再進 chainOnConnection(同 db) 能被 getStore() 偵測到。
      const next = new Set(writeContext.getStore() ?? []);
      next.add(db);
      return writeContext.run(next, operation);
    });
  writeChains.set(
    db,
    scheduled.then(
      () => undefined,
      () => undefined
    )
  );
  return scheduled;
}

/**
 * 全域單寫線：所有 SQLite 寫入排到「該連線」唯一的 chain，保證同一時間只有一個
 * 寫入操作在執行。單一 statement 本身是 atomic，但仍需排隊避免落在別人交易中間。
 *
 * ⚠️ operation 內嚴禁再呼叫 runSerializedWrite / withWriteTransaction（同連線會
 * self-deadlock：外層 scheduled 等內層完成才 resolve、內層卻排在外層之後 → 互等永
 * 久 hang）。需要的子操作一律改成吃 db 參數的純函式（*WithDb），直接用傳入的 db。
 * 已加 re-entrant fail-fast 偵測，誤踩會立即 throw 而非靜默卡死。
 */
export async function runSerializedWrite<T>(
  operation: (db: Database) => Promise<T>
): Promise<T> {
  const db = await sqliteClient.getDb();
  return chainOnConnection(db, () => operation(db));
}

/**
 * 整段交易序列化：在單寫線內 BEGIN IMMEDIATE → fn → COMMIT，throw 時 ROLLBACK。
 * 關鍵在於「整個交易括號」是 chain 上的一個不可分割單位，期間沒有其他寫入能
 * 在同一連線插進一個 BEGIN，因此根除 nested BEGIN。fn 內只能做資料 db.run/exec，
 * 不可自行 BEGIN/COMMIT/ROLLBACK。
 *
 * ⚠️ fn 內亦嚴禁再呼叫 runSerializedWrite / withWriteTransaction（同連線會
 * self-deadlock）。需要的子操作一律改成吃 db 參數的純函式（*WithDb），直接用傳入
 * 的 db。已加 re-entrant fail-fast 偵測，誤踩會立即 throw 而非靜默卡死。
 */
export async function withWriteTransaction<T>(
  fn: (db: Database) => Promise<T>
): Promise<T> {
  const db = await sqliteClient.getDb();
  return chainOnConnection(db, async () => {
    await db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = await fn(db);
      await db.exec("COMMIT");
      return result;
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  });
}

/**
 * 工廠版 serializer：給用「注入 getDb」建構的 repository（factory pattern）。
 * 同樣以連線實例為 key 排隊；注入測試 db 與 production singleton 各自獨立。
 *
 * ⚠️ 與 runSerializedWrite / withWriteTransaction 同樣的不變式：operation / fn 內
 * 嚴禁再呼叫任何 serialized write（同連線會 self-deadlock）；子操作改用 *WithDb 純函式。
 */
export function createConnectionSerializer(getDb: () => Promise<Database>): {
  runSerializedWrite: <T>(operation: (db: Database) => Promise<T>) => Promise<T>;
  withWriteTransaction: <T>(fn: (db: Database) => Promise<T>) => Promise<T>;
} {
  return {
    async runSerializedWrite(operation) {
      const db = await getDb();
      return chainOnConnection(db, () => operation(db));
    },
    async withWriteTransaction(fn) {
      const db = await getDb();
      return chainOnConnection(db, async () => {
        await db.exec("BEGIN IMMEDIATE TRANSACTION");
        try {
          const result = await fn(db);
          await db.exec("COMMIT");
          return result;
        } catch (error) {
          await db.exec("ROLLBACK");
          throw error;
        }
      });
    },
  };
}
