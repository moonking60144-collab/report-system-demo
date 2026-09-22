import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type QueuedRequest = {
  kind: "read" | "write";
  resolve: () => void;
};

const FILE_LOCK_RETRY_MS = 50;
const FILE_LOCK_STALE_MS = 30 * 60 * 1000;

let activeReaders = 0;
let writerActive = false;
const queue: QueuedRequest[] = [];

function definitionsWriteLockFilePath(): string {
  const configured = process.env.RAGIC_DEFINITIONS_LOCK_FILE?.trim();
  return configured || resolve(process.cwd(), ".data", "ragic-definitions.write.lock");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function removeStaleFileLock(lockFilePath: string): Promise<boolean> {
  try {
    const current = await stat(lockFilePath);
    if (Date.now() - current.mtimeMs < FILE_LOCK_STALE_MS) {
      return false;
    }
    await rm(lockFilePath, { force: true });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function acquireFileWriteLock(): Promise<() => Promise<void>> {
  const lockFilePath = definitionsWriteLockFilePath();
  await mkdir(dirname(lockFilePath), { recursive: true });

  for (;;) {
    try {
      const handle = await open(lockFilePath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          })
        );
      } finally {
        await handle.close();
      }
      return async () => {
        await rm(lockFilePath, { force: true });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      await removeStaleFileLock(lockFilePath);
      await sleep(FILE_LOCK_RETRY_MS);
    }
  }
}

function hasQueuedWriter(): boolean {
  return queue.some((item) => item.kind === "write");
}

function drainQueue(): void {
  if (writerActive || activeReaders > 0) return;
  const first = queue[0];
  if (!first) return;

  if (first.kind === "write") {
    queue.shift();
    writerActive = true;
    first.resolve();
    return;
  }

  while (queue[0]?.kind === "read") {
    const reader = queue.shift();
    if (!reader) break;
    activeReaders += 1;
    reader.resolve();
  }
}

function acquireRead(): Promise<void> {
  if (!writerActive && !hasQueuedWriter()) {
    activeReaders += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    queue.push({ kind: "read", resolve });
  });
}

function releaseRead(): void {
  activeReaders = Math.max(0, activeReaders - 1);
  drainQueue();
}

function acquireWrite(): Promise<void> {
  if (!writerActive && activeReaders === 0) {
    writerActive = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    queue.push({ kind: "write", resolve });
  });
}

function releaseWrite(): void {
  writerActive = false;
  drainQueue();
}

export async function withDefinitionsReadLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireRead();
  try {
    return await fn();
  } finally {
    releaseRead();
  }
}

export async function withDefinitionsWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireWrite();
  let releaseFileLock: (() => Promise<void>) | null = null;
  try {
    releaseFileLock = await acquireFileWriteLock();
    return await fn();
  } finally {
    try {
      if (releaseFileLock) {
        await releaseFileLock();
      }
    } finally {
      releaseWrite();
    }
  }
}
