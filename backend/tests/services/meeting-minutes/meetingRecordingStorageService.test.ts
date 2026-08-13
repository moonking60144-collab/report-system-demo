import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeetingRecordingStorageService } from "../../../src/services/meeting-minutes/meetingRecordingStorageService";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function createHarness(options: {
  maxTotalBytes?: number;
  maxSessionBytes?: number;
  staleSessionMs?: number;
  readChunkFile?: (filePath: string) => Promise<Buffer>;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-recording-"));
  let idIndex = 0;
  let now = new Date("2026-07-15T08:00:00.000Z");
  const service = new MeetingRecordingStorageService({
    storageDir: root,
    maxTotalBytes: options.maxTotalBytes ?? 1024,
    maxSessionBytes: options.maxSessionBytes ?? 1024,
    maxChunkBytes: 128,
    staleSessionMs: options.staleSessionMs ?? 60_000,
    idFactory: () => IDS[idIndex++] ?? IDS[IDS.length - 1],
    now: () => now,
    readChunkFile: options.readChunkFile,
  });
  return {
    root,
    service,
    setNow(value: string) {
      now = new Date(value);
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("雙音源分段可重送並串接成兩份獨立錄音", async () => {
  const harness = await createHarness();
  try {
    const session = await harness.service.createSession({
      ownerId: OWNER_ID,
      title: "品管會議",
      sourceIds: ["room-mic", "remote-tab"],
    });
    const first = await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm;codecs=opus",
      body: Buffer.from("room-1"),
    });
    const duplicate = await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm;codecs=opus",
      body: Buffer.from("room-1"),
    });
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      sourceId: "room-mic",
      sequence: 1,
      mimeType: "audio/webm;codecs=opus",
      body: Buffer.from("room-2"),
    });
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      sourceId: "remote-tab",
      sequence: 0,
      mimeType: "audio/webm;codecs=opus",
      body: Buffer.from("remote-1"),
    });

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    const finalized = await harness.service.finalizeSession({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      durationMs: 12_345,
      tracks: [
        { sourceId: "room-mic", chunkCount: 2 },
        { sourceId: "remote-tab", chunkCount: 1 },
      ],
    });
    assert.equal(finalized.status, "finalized");
    assert.equal(finalized.durationMs, 12_345);
    assert.equal(finalized.tracks.every((track) => track.available), true);

    const room = await harness.service.resolveTrack(session.sessionId, "room-mic", OWNER_ID);
    const remote = await harness.service.resolveTrack(session.sessionId, "remote-tab", OWNER_ID);
    assert.equal((await readFile(room.filePath)).toString(), "room-1room-2");
    assert.equal((await readFile(remote.filePath)).toString(), "remote-1");
  } finally {
    await harness.close();
  }
});

test("相同分段序號但內容不同時拒絕覆寫", async () => {
  const harness = await createHarness();
  try {
    const session = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm",
      body: Buffer.from("first"),
    });
    await assert.rejects(
      harness.service.uploadChunk({
        ownerId: OWNER_ID,
        sessionId: session.sessionId,
        sourceId: "room-mic",
        sequence: 0,
        mimeType: "audio/webm",
        body: Buffer.from("other"),
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_RECORDING_CHUNK_CONFLICT"
    );
  } finally {
    await harness.close();
  }
});

test("recorder session capability 只授權建立該 session 的隨機 key", async () => {
  const harness = await createHarness();
  try {
    const capability = "a".repeat(43);
    const protectedSession = await harness.service.createSession({
      ownerId: OWNER_ID,
      recorderGrantId: OTHER_OWNER_ID,
      sessionCapability: capability,
      recorderLibraryAccessVersion: 1,
      sessionCapabilityExpiresAt: "2026-07-15T08:01:00.000Z",
      sourceIds: ["room-mic"],
    });
    assert.deepEqual(
      await harness.service.resolveSessionCapabilityOwner(
        protectedSession.sessionId,
        capability
      ),
      { ownerId: OWNER_ID, libraryAccessVersion: 1 }
    );
    await assert.rejects(
      harness.service.resolveSessionCapabilityOwner(
        protectedSession.sessionId,
        "b".repeat(43)
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_RECORDING_NOT_FOUND"
    );

    harness.setNow("2026-07-15T08:01:00.000Z");
    await assert.rejects(
      harness.service.resolveSessionCapabilityOwner(
        protectedSession.sessionId,
        capability
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_RECORDING_SESSION_CAPABILITY_EXPIRED"
    );
  } finally {
    await harness.close();
  }
});

test("達總容量上限時拒絕新 chunk，且不刪除既有已完成錄音", async () => {
  const harness = await createHarness({ maxTotalBytes: 16, maxSessionBytes: 64 });
  try {
    const oldest = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: oldest.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm",
      body: Buffer.from("12345678"),
    });
    await harness.service.finalizeSession({
      ownerId: OWNER_ID,
      sessionId: oldest.sessionId,
      durationMs: 1_000,
      tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
    });

    harness.setNow("2026-07-15T08:10:00.000Z");
    const active = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await assert.rejects(
      harness.service.uploadChunk({
        ownerId: OWNER_ID,
        sessionId: active.sessionId,
        sourceId: "room-mic",
        sequence: 0,
        mimeType: "audio/webm",
        body: Buffer.from("abcdefghi"),
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_RECORDING_STORAGE_LIMIT"
    );
    assert.equal((await harness.service.getSession(oldest.sessionId, OWNER_ID)).status, "finalized");
    assert.equal((await harness.service.getSession(active.sessionId, OWNER_ID)).status, "recording");
  } finally {
    await harness.close();
  }
});

test("總容量不足時拒絕其他 owner 的新 chunk，不跨錄音庫淘汰既有錄音", async () => {
  const harness = await createHarness({ maxTotalBytes: 16, maxSessionBytes: 64 });
  try {
    const retained = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: retained.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm",
      body: Buffer.from("12345678"),
    });
    await harness.service.finalizeSession({
      ownerId: OWNER_ID,
      sessionId: retained.sessionId,
      durationMs: 1_000,
      tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
    });

    const foreign = await harness.service.createSession({
      ownerId: OTHER_OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await assert.rejects(
      harness.service.uploadChunk({
        ownerId: OTHER_OWNER_ID,
        sessionId: foreign.sessionId,
        sourceId: "room-mic",
        sequence: 0,
        mimeType: "audio/webm",
        body: Buffer.from("abcdefghi"),
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_RECORDING_STORAGE_LIMIT"
    );
    assert.equal((await harness.service.getSession(retained.sessionId, OWNER_ID)).status, "finalized");
    assert.equal(
      (await harness.service.getSession(foreign.sessionId, OTHER_OWNER_ID)).status,
      "recording"
    );
  } finally {
    await harness.close();
  }
});

test("背景清理只回收逾時未更新的殘留錄音 session", async () => {
  const harness = await createHarness({ staleSessionMs: 60_000 });
  try {
    const stale = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    harness.setNow("2026-07-15T08:00:30.000Z");
    const current = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    harness.setNow("2026-07-15T08:01:15.000Z");

    const result = await harness.service.cleanupStorage();
    assert.deepEqual(result.deletedSessionIds, []);
    assert.deepEqual(result.deletedStaleSessionIds, [stale.sessionId]);
    await assert.rejects(
      harness.service.getSession(stale.sessionId, OWNER_ID),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_RECORDING_NOT_FOUND"
    );
    assert.equal((await harness.service.getSession(current.sessionId, OWNER_ID)).status, "recording");
  } finally {
    await harness.close();
  }
});

test("中止錄音會真的移除 session，而不是只回報成功", async () => {
  const harness = await createHarness();
  try {
    const session = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await harness.service.abortSession(session.sessionId, OWNER_ID);

    await assert.rejects(
      harness.service.getSession(session.sessionId, OWNER_ID),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_RECORDING_NOT_FOUND"
    );
  } finally {
    await harness.close();
  }
});

test("不同 session 的 chunk 上傳不會被另一個 session 的 finalize 阻塞", async () => {
  let releaseFinalize!: () => void;
  const finalizeGate = new Promise<void>((resolve) => {
    releaseFinalize = resolve;
  });
  let markFinalizeReading!: () => void;
  const finalizeReading = new Promise<void>((resolve) => {
    markFinalizeReading = resolve;
  });
  let blocked = false;
  const harness = await createHarness({
    readChunkFile: async (filePath) => {
      if (!blocked && filePath.includes(IDS[0])) {
        blocked = true;
        markFinalizeReading();
        await finalizeGate;
      }
      return readFile(filePath);
    },
  });

  try {
    const first = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: first.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm",
      body: Buffer.from("first"),
    });
    const second = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });

    const finalize = harness.service.finalizeSession({
      ownerId: OWNER_ID,
      sessionId: first.sessionId,
      durationMs: 1_000,
      tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
    });
    await finalizeReading;
    const upload = harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: second.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm",
      body: Buffer.from("second"),
    });
    const uploadCompletedBeforeFinalize = await Promise.race([
      upload.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);

    releaseFinalize();
    await Promise.all([finalize, upload]);
    assert.equal(uploadCompletedBeforeFinalize, true);
  } finally {
    releaseFinalize();
    await harness.close();
  }
});

test("finalize 建檔失敗會釋放容量預留，不阻塞其他 session 上傳", async () => {
  let failFirstRead = true;
  const harness = await createHarness({
    maxTotalBytes: 16,
    maxSessionBytes: 16,
    readChunkFile: async (filePath) => {
      if (failFirstRead && filePath.includes(IDS[0])) {
        failFirstRead = false;
        throw new Error("simulated NAS read failure");
      }
      return readFile(filePath);
    },
  });

  try {
    const first = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: first.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm",
      body: Buffer.from("12345678"),
    });
    const second = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });

    await assert.rejects(
      harness.service.finalizeSession({
        ownerId: OWNER_ID,
        sessionId: first.sessionId,
        durationMs: 1_000,
        tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
      }),
      /simulated NAS read failure/
    );
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: second.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm",
      body: Buffer.from("abcdefgh"),
    });
    assert.equal((await harness.service.getSession(second.sessionId, OWNER_ID)).totalSizeBytes, 8);
  } finally {
    await harness.close();
  }
});

test("儲存目錄初始化暫時失敗後，下一次呼叫可以重新初始化", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "meeting-recording-init-"));
  const storageDir = path.join(parent, "recordings");
  await writeFile(storageDir, "temporary blocker");
  const service = new MeetingRecordingStorageService({
    storageDir,
    maxTotalBytes: 1024,
    maxSessionBytes: 1024,
    maxChunkBytes: 128,
    staleSessionMs: 60_000,
    idFactory: () => IDS[0],
  });

  try {
    await assert.rejects(service.initialize());
    await rm(storageDir, { force: true });
    await service.initialize();

    const session = await service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    assert.equal(session.sessionId, IDS[0]);
    assert.equal(session.status, "recording");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("processing lock 只允許對 finalized session 建立，且 worker 只能用相同 job 讀取", async () => {
  const harness = await createHarness();
  const jobId = "99999999-9999-4999-8999-999999999999";
  try {
    const session = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await assert.rejects(
      harness.service.acquireProcessingLock({
        sessionId: session.sessionId,
        ownerId: OWNER_ID,
        jobId,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_RECORDING_NOT_FINALIZED"
    );
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm",
      body: Buffer.from("room-audio"),
    });
    await harness.service.finalizeSession({
      ownerId: OWNER_ID,
      sessionId: session.sessionId,
      durationMs: 1_000,
      tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
    });

    const input = await harness.service.acquireProcessingLock({
      sessionId: session.sessionId,
      ownerId: OWNER_ID,
      jobId,
    });
    assert.equal(input.sessionId, session.sessionId);
    assert.equal(input.tracks[0]?.sourceId, "room-mic");
    assert.equal((await readFile(input.tracks[0]!.filePath)).toString(), "room-audio");
    await assert.rejects(
      harness.service.resolveProcessingInput(
        session.sessionId,
        "88888888-8888-4888-8888-888888888888"
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_PROCESSING_LOCK_MISMATCH"
    );
    assert.equal(await harness.service.releaseProcessingLock(session.sessionId, jobId), true);
    assert.equal(await harness.service.releaseProcessingLock(session.sessionId, jobId), false);
  } finally {
    await harness.close();
  }
});

test("有 processing lock 的 finalized session 不會被容量 retention 刪除", async () => {
  const harness = await createHarness({ maxTotalBytes: 16, maxSessionBytes: 64 });
  const jobId = "99999999-9999-4999-8999-999999999999";
  try {
    const retained = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await harness.service.uploadChunk({
      ownerId: OWNER_ID,
      sessionId: retained.sessionId,
      sourceId: "room-mic",
      sequence: 0,
      mimeType: "audio/webm",
      body: Buffer.from("12345678"),
    });
    await harness.service.finalizeSession({
      ownerId: OWNER_ID,
      sessionId: retained.sessionId,
      durationMs: 1_000,
      tracks: [{ sourceId: "room-mic", chunkCount: 1 }],
    });
    await harness.service.acquireProcessingLock({
      sessionId: retained.sessionId,
      ownerId: OWNER_ID,
      jobId,
    });

    const incoming = await harness.service.createSession({
      ownerId: OWNER_ID,
      sourceIds: ["room-mic"],
    });
    await assert.rejects(
      harness.service.uploadChunk({
        ownerId: OWNER_ID,
        sessionId: incoming.sessionId,
        sourceId: "room-mic",
        sequence: 0,
        mimeType: "audio/webm",
        body: Buffer.from("abcdefghi"),
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "MEETING_RECORDING_STORAGE_LIMIT"
    );
    assert.equal((await harness.service.getSession(retained.sessionId, OWNER_ID)).status, "finalized");
  } finally {
    await harness.close();
  }
});

test("跨錄音庫統計只掃描一次資料集並保留精確筆數與最新錄音", async () => {
  const harness = await createHarness();
  try {
    await harness.service.createSession({
      ownerId: OWNER_ID,
      title: "品質週會",
      sourceIds: ["room-mic"],
    });
    harness.setNow("2026-07-15T09:00:00.000Z");
    await harness.service.createSession({
      ownerId: OTHER_OWNER_ID,
      title: "生產晨會",
      sourceIds: ["room-mic"],
    });
    harness.setNow("2026-07-15T10:00:00.000Z");
    const latest = await harness.service.createSession({
      ownerId: OWNER_ID,
      title: "品質月會",
      sourceIds: ["room-mic"],
    });

    const summaries = await harness.service.summarizeSessionsByOwner();
    assert.equal(summaries.get(OWNER_ID)?.recordingCount, 2);
    assert.equal(summaries.get(OWNER_ID)?.latestRecording?.sessionId, latest.sessionId);
    assert.deepEqual(
      new Set(summaries.get(OWNER_ID)?.recordingTitles),
      new Set(["品質週會", "品質月會"])
    );
    assert.equal(summaries.get(OTHER_OWNER_ID)?.recordingCount, 1);
  } finally {
    await harness.close();
  }
});

test("錄音庫清單以 createdAt 與 sessionId 游標完整取回同時間戳的 51 筆錄音", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meeting-recording-pagination-"));
  let nextId = 1;
  const service = new MeetingRecordingStorageService({
    storageDir: root,
    maxTotalBytes: 1024,
    maxSessionBytes: 1024,
    maxChunkBytes: 128,
    staleSessionMs: 60_000,
    idFactory: () =>
      `${String(nextId++).padStart(8, "0")}-0000-4000-8000-000000000000`,
    now: () => new Date("2026-07-16T08:00:00.000Z"),
  });
  try {
    for (let index = 0; index < 51; index += 1) {
      await service.createSession({
        ownerId: OWNER_ID,
        title: `會議 ${index + 1}`,
        sourceIds: ["room-mic"],
      });
    }

    const first = await service.listSessionsPage(OWNER_ID, { limit: 50 });
    assert.equal(first.items.length, 50);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);

    const second = await service.listSessionsPage(OWNER_ID, {
      limit: 50,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
    assert.equal(
      new Set([...first.items, ...second.items].map((session) => session.sessionId)).size,
      51
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
