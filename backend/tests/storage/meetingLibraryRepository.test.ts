import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { MeetingLibraryRepository } from "../../src/storage/meeting-minutes/meetingLibraryRepository";

const LIBRARY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("meeting library repository 只保存 Code digest 並以 accessVersion 撤銷舊存取", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-library-repository-"));
  const dbFile = path.join(root, "meeting.sqlite3");
  const repository = new MeetingLibraryRepository(dbFile);
  try {
    const created = await repository.createLibrary({
      libraryId: LIBRARY_ID,
      codeDigest: "digest-for-NW8K9Q",
      displayName: "品管會議錄音庫",
      codeHint: "N**-**Q",
      now: "2026-07-16T08:00:00.000Z",
    });
    assert.equal(created?.created, true);
    assert.equal(created?.library.accessVersion, 1);
    assert.equal(created?.library.codeDigest, "digest-for-NW8K9Q");
    assert.equal(created?.library.displayName, "品管會議錄音庫");
    assert.equal(created?.library.displayNameConfirmedAt, "2026-07-16T08:00:00.000Z");
    assert.equal(created?.library.codeHint, "N**-**Q");
    assert.equal(
      (await repository.getLibraryByCodeDigest("digest-for-NW8K9Q"))?.libraryId,
      LIBRARY_ID
    );

    const rotated = await repository.rotateCode({
      libraryId: LIBRARY_ID,
      codeDigest: "digest-for-Q7MX8P",
      codeHint: "Q**-**P",
      now: "2026-07-16T09:00:00.000Z",
    });
    assert.equal(rotated?.accessVersion, 2);
    assert.equal(rotated?.codeHint, "Q**-**P");
    assert.equal(await repository.getLibraryByCodeDigest("digest-for-NW8K9Q"), null);
    assert.equal(
      (await repository.getLibraryByCodeDigest("digest-for-Q7MX8P"))?.accessVersion,
      2
    );

    await repository.insertAdminAudit({
      auditId: "audit-1",
      adminUsername: "admin",
      action: "rotate-code",
      libraryId: LIBRARY_ID,
      sessionId: null,
      clientIp: "127.0.0.1",
      createdAt: "2026-07-16T09:00:00.000Z",
    });
    assert.deepEqual(await repository.listAdminAudits(), [
      {
        auditId: "audit-1",
        adminUsername: "admin",
        action: "rotate-code",
        libraryId: LIBRARY_ID,
        sessionId: null,
        clientIp: "127.0.0.1",
        createdAt: "2026-07-16T09:00:00.000Z",
      },
    ]);
  } finally {
    await repository.close();
  }

  const databaseBytes = await readFile(dbFile);
  assert.equal(databaseBytes.includes(Buffer.from("NW8-K9Q")), false);
  assert.equal(databaseBytes.includes(Buffer.from("Q7M-X8P")), false);
  await rm(root, { recursive: true, force: true });
});

test("meeting library repository 不會讓不同 library 共用相同 digest", async () => {
  const repository = new MeetingLibraryRepository(":memory:");
  try {
    assert.ok(
      await repository.createLibrary({
        libraryId: LIBRARY_ID,
        codeDigest: "same-digest",
        displayName: "第一個錄音庫",
        codeHint: "A**-**4",
        now: "2026-07-16T08:00:00.000Z",
      })
    );
    assert.equal(
      await repository.createLibrary({
        libraryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        codeDigest: "same-digest",
        displayName: "第二個錄音庫",
        codeHint: "B**-**5",
        now: "2026-07-16T08:00:01.000Z",
      }),
      null
    );
  } finally {
    await repository.close();
  }
});

test("admin audit 寫入失敗時 Code 重設會完整 rollback", async () => {
  const repository = new MeetingLibraryRepository(":memory:");
  try {
    const created = await repository.createLibrary({
      libraryId: LIBRARY_ID,
      codeDigest: "original-digest",
      displayName: "品管會議錄音庫",
      codeHint: "N**-**Q",
      now: "2026-07-16T08:00:00.000Z",
    });
    assert.ok(created);
    await repository.insertAdminAudit({
      auditId: "duplicate-audit",
      adminUsername: "admin",
      action: "rotate-code",
      libraryId: LIBRARY_ID,
      sessionId: null,
      clientIp: "127.0.0.1",
      createdAt: "2026-07-16T08:30:00.000Z",
    });

    await assert.rejects(
      repository.rotateCodeWithAdminAudit({
        libraryId: LIBRARY_ID,
        codeDigest: "replacement-digest",
        codeHint: "Q**-**P",
        now: "2026-07-16T09:00:00.000Z",
        audit: {
          auditId: "duplicate-audit",
          adminUsername: "admin",
          action: "rotate-code",
          libraryId: LIBRARY_ID,
          sessionId: null,
          clientIp: "127.0.0.1",
          createdAt: "2026-07-16T09:00:00.000Z",
        },
      })
    );

    const current = await repository.getLibrary(LIBRARY_ID);
    assert.equal(current?.codeDigest, "original-digest");
    assert.equal(current?.codeHint, "N**-**Q");
    assert.equal(current?.accessVersion, 1);
    assert.equal((await repository.listAdminAudits()).length, 1);
  } finally {
    await repository.close();
  }
});

test("舊版 meeting_libraries 會 additive migration 且保留既有資料", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-library-migration-"));
  const dbFile = path.join(root, "meeting.sqlite3");
  const legacy = await open({ filename: dbFile, driver: sqlite3.Database });
  await legacy.exec(`
    CREATE TABLE meeting_libraries (
      library_id TEXT PRIMARY KEY,
      code_digest TEXT NOT NULL UNIQUE,
      access_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      code_rotated_at TEXT NOT NULL,
      revoked_at TEXT
    );
    INSERT INTO meeting_libraries (
      library_id, code_digest, access_version, created_at, code_rotated_at, revoked_at
    ) VALUES (
      '${LIBRARY_ID}', 'legacy-digest', 1,
      '2026-07-16T08:00:00.000Z', '2026-07-16T08:00:00.000Z', NULL
    );
  `);
  await legacy.close();

  const repository = new MeetingLibraryRepository(dbFile);
  try {
    await repository.initialize();
    const migrated = await repository.getLibrary(LIBRARY_ID);
    assert.equal(migrated?.codeDigest, "legacy-digest");
    assert.equal(migrated?.displayName, null);
    assert.equal(migrated?.displayNameConfirmedAt, null);
    assert.equal(migrated?.codeHint, null);
    const renamed = await repository.updateDisplayName({
      libraryId: LIBRARY_ID,
      displayName: "舊錄音庫補命名",
      now: "2026-07-16T09:00:00.000Z",
    });
    assert.equal(renamed?.displayName, "舊錄音庫補命名");
    assert.equal(renamed?.displayNameConfirmedAt, "2026-07-16T09:00:00.000Z");
  } finally {
    await repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("舊版已命名錄音庫 migration 會保留確認狀態，不要求使用者重複命名", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-library-named-migration-"));
  const dbPath = path.join(root, "legacy.sqlite3");
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE meeting_libraries (
      library_id TEXT PRIMARY KEY,
      code_digest TEXT NOT NULL UNIQUE,
      display_name TEXT,
      code_hint TEXT,
      access_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      code_rotated_at TEXT NOT NULL,
      revoked_at TEXT
    );
    INSERT INTO meeting_libraries (
      library_id, code_digest, display_name, code_hint,
      access_version, created_at, code_rotated_at, revoked_at
    ) VALUES (
      '${LIBRARY_ID}', 'legacy-named-digest', '既有品管錄音庫', 'N**-**Q',
      1, '2026-07-16T08:00:00.000Z', '2026-07-16T08:00:00.000Z', NULL
    );
  `);
  await db.close();

  const repository = new MeetingLibraryRepository(dbPath);
  try {
    const migrated = await repository.getLibrary(LIBRARY_ID);
    assert.equal(migrated?.displayName, "既有品管錄音庫");
    assert.equal(
      migrated?.displayNameConfirmedAt,
      "2026-07-16T08:00:00.000Z"
    );
  } finally {
    await repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("admin audit 同毫秒事件依 SQLite 寫入順序穩定回傳最新一筆在前", async () => {
  const repository = new MeetingLibraryRepository(":memory:");
  const createdAt = "2026-07-16T08:00:00.000Z";
  try {
    await repository.insertAdminAudit({
      auditId: "z-random-first",
      adminUsername: "admin",
      action: "list-libraries",
      libraryId: null,
      sessionId: null,
      clientIp: "127.0.0.1",
      createdAt,
    });
    await repository.insertAdminAudit({
      auditId: "a-random-second",
      adminUsername: "admin",
      action: "open-library",
      libraryId: LIBRARY_ID,
      sessionId: null,
      clientIp: "127.0.0.1",
      createdAt,
    });

    assert.deepEqual(
      (await repository.listAdminAudits()).map((audit) => audit.auditId),
      ["a-random-second", "z-random-first"]
    );
  } finally {
    await repository.close();
  }
});
