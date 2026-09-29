import type { MeetingAudioSourceId } from "./useMeetingAudioCheck";

export const MEETING_RECOVERY_DB = "meeting-recording-recovery-v1";
export const MEETING_RECOVERY_MAX_BYTES = 256 * 1024 * 1024;
const MAX_SESSIONS = 8;

export interface RecoverySession {
  deliveryMode?: "one-shot";
  sessionId: string;
  title: string;
  startedAtMs: number;
  durationMs: number;
  stopped: boolean;
  expectedChunks?: Array<{ sourceId: MeetingAudioSourceId; chunkCount: number }>;
  requiresSessionCapability: boolean;
  totalBytes: number;
  tracks: Array<{ sourceId: MeetingAudioSourceId; mimeType: string }>;
}

export interface RecoveryChunk {
  sessionId: string;
  sourceId: MeetingAudioSourceId;
  sequence: number;
  blob: Blob;
}

function openRecoveryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MEETING_RECOVERY_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("sessions", { keyPath: "sessionId" });
      const chunks = request.result.createObjectStore("chunks", { keyPath: ["sessionId", "sourceId", "sequence"] });
      chunks.createIndex("sessionId", "sessionId");
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("本機錄音資料庫被其他分頁占用。"));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openRecoveryDb();
  try {
    const tx = db.transaction(["sessions", "chunks"], mode, { durability: "strict" });
    const completion = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("本機錄音保存未完成。"));
      tx.onerror = () => reject(tx.error);
    });
    try {
      const result = await action(tx);
      await completion;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* transaction 可能已由 IndexedDB 結束。 */ }
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}

export function listRecoverySessions(): Promise<RecoverySession[]> {
  return transaction("readonly", tx => requestValue(tx.objectStore("sessions").getAll()));
}

export function createRecoverySession(session: RecoverySession): Promise<void> {
  return transaction("readwrite", async tx => {
    const sessions = tx.objectStore("sessions");
    if (await requestValue(sessions.count()) >= MAX_SESSIONS) throw new Error("本機待恢復錄音已達 8 筆上限，請先處理舊錄音。");
    await requestValue(sessions.add(session));
  });
}

export function saveRecoveryChunk(chunk: RecoveryChunk, durationMs: number): Promise<void> {
  return transaction("readwrite", async tx => {
    const sessions = tx.objectStore("sessions");
    const chunks = tx.objectStore("chunks");
    const session = await requestValue<RecoverySession | undefined>(sessions.get(chunk.sessionId));
    if (!session) throw new Error("找不到本機錄音恢復資訊。");
    if (await requestValue(chunks.getKey([chunk.sessionId, chunk.sourceId, chunk.sequence]))) return;
    const all = await requestValue<RecoverySession[]>(sessions.getAll());
    if (all.reduce((total, item) => total + item.totalBytes, 0) + chunk.blob.size > MEETING_RECOVERY_MAX_BYTES) {
      throw new DOMException("本機待恢復錄音已達 256 MiB 上限。", "QuotaExceededError");
    }
    await requestValue(chunks.add(chunk));
    await requestValue(sessions.put({ ...session, totalBytes: session.totalBytes + chunk.blob.size,
      durationMs: Math.max(session.durationMs, durationMs) }));
  });
}

export function stopRecoverySession(sessionId: string, durationMs: number, expectedChunks: NonNullable<RecoverySession["expectedChunks"]>): Promise<void> {
  return transaction("readwrite", async tx => {
    const store = tx.objectStore("sessions");
    const session = await requestValue<RecoverySession | undefined>(store.get(sessionId));
    if (!session) throw new Error("找不到本機錄音恢復資訊。");
    const chunks = await requestValue<RecoveryChunk[]>(tx.objectStore("chunks").index("sessionId").getAll(sessionId));
    for (const track of session.tracks) {
      const expected = expectedChunks.find(item => item.sourceId === track.sourceId);
      const stored = chunks.filter(chunk => chunk.sourceId === track.sourceId).sort((a, b) => a.sequence - b.sequence);
      if (!expected || expected.chunkCount === 0 || stored.length !== expected.chunkCount || stored.some((chunk, index) => chunk.sequence !== index)) {
        throw new Error("本機錄音有缺失片段，不能標記為完整停止。");
      }
    }
    await requestValue(store.put({ ...session, durationMs, stopped: true, expectedChunks }));
  });
}

export function readRecoveryChunks(sessionId: string): Promise<RecoveryChunk[]> {
  return transaction("readonly", tx => requestValue(tx.objectStore("chunks").index("sessionId").getAll(sessionId)));
}

export function removeRecoverySession(sessionId: string): Promise<void> {
  return transaction("readwrite", async tx => {
    const chunks = tx.objectStore("chunks");
    const keys = await requestValue(chunks.index("sessionId").getAllKeys(sessionId));
    await Promise.all(keys.map(key => requestValue(chunks.delete(key))));
    await requestValue(tx.objectStore("sessions").delete(sessionId));
  });
}

// 鎖持續到錄音／恢復流程結束，頁面被關閉時由瀏覽器釋放，不靠租約時鐘猜測。
export function acquireRecoveryLock(sessionId: string): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    void navigator.locks.request(`meeting-recording:${sessionId}`, { ifAvailable: true }, async lock => {
      if (!lock) { resolve(null); return; }
      await new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}
