import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  withDefinitionsReadLock,
  withDefinitionsWriteLock,
} from "../../../src/services/dev/ragicDefinitionsIoLock";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}

test("definitions lock：writer 排隊時後續 reader 不會插隊讀半套 definitions", async () => {
  const events: string[] = [];
  const releaseFirstReader = deferred();
  const releaseWriter = deferred();

  const firstReader = withDefinitionsReadLock(async () => {
    events.push("reader-1:start");
    await releaseFirstReader.promise;
    events.push("reader-1:end");
  });
  await waitFor(() => events.includes("reader-1:start"));

  const writer = withDefinitionsWriteLock(async () => {
    events.push("writer:start");
    await releaseWriter.promise;
    events.push("writer:end");
  });

  const secondReader = withDefinitionsReadLock(async () => {
    events.push("reader-2:start");
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["reader-1:start"]);

  releaseFirstReader.resolve();
  await waitFor(() => events.includes("writer:start"));
  assert.equal(events.includes("reader-2:start"), false);

  releaseWriter.resolve();
  await Promise.all([firstReader, writer, secondReader]);
  assert.deepEqual(events, [
    "reader-1:start",
    "reader-1:end",
    "writer:start",
    "writer:end",
    "reader-2:start",
  ]);
});

test("definitions lock：write lock 會建立並釋放跨行程 lock file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "definitions-lock-"));
  const lockFile = join(dir, "definitions.write.lock");
  const originalLockFile = process.env.RAGIC_DEFINITIONS_LOCK_FILE;
  process.env.RAGIC_DEFINITIONS_LOCK_FILE = lockFile;
  t.after(async () => {
    if (originalLockFile === undefined) {
      delete process.env.RAGIC_DEFINITIONS_LOCK_FILE;
    } else {
      process.env.RAGIC_DEFINITIONS_LOCK_FILE = originalLockFile;
    }
    await rm(dir, { recursive: true, force: true });
  });

  await withDefinitionsWriteLock(async () => {
    await assert.doesNotReject(access(lockFile));
  });

  await assert.rejects(access(lockFile), { code: "ENOENT" });
});
