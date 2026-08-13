import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectRuntimeHealthSnapshot } from "../../src/observability/runtimeHealthLogger";

const emptyMeetingQueue = {
  pending: 0,
  running: 0,
  ready: 0,
  failed: 0,
  total: 0,
  oldestPendingAgeMs: 0,
};

test("runtime health 同時偵測 event loop、heap、mutation queue 與 Meeting backlog 壓力", async () => {
  const snapshot = await collectRuntimeHealthSnapshot({
    now: () => new Date("2026-08-13T00:00:00.000Z"),
    getEventLoopLagStats: () => ({ mean: 20, p95: 1_000, max: 1_200 }),
    getMemoryUsage: () => ({
      rss: 1_000,
      heapTotal: 1_000,
      heapUsed: 900,
      external: 50,
      arrayBuffers: 25,
    }),
    getMutationQueueStats: () => ({
      accepting: true,
      activeKeyCount: 10,
      pendingTaskCount: 450,
      oldestPendingTaskAgeMs: 100,
      highestPendingTaskCountPerKey: 2,
      maxPendingTaskCount: 500,
      maxPendingTaskCountPerKey: 25,
      maxOldestPendingTaskAgeMs: 600_000,
    }),
    getMeetingJobStats: async () => ({
      processing: {
        ...emptyMeetingQueue,
        pending: 1,
        total: 1,
        oldestPendingAgeMs: 100 * 24 * 60 * 60 * 1000,
      },
      transcription: emptyMeetingQueue,
      minutes: emptyMeetingQueue,
    }),
  });

  assert.equal(snapshot.at, "2026-08-13T00:00:00.000Z");
  assert.equal(snapshot.memory.heapUsedRatio, 0.9);
  assert.deepEqual(snapshot.warnings, [
    "EVENT_LOOP_LAG_HIGH",
    "HEAP_USAGE_HIGH",
    "WORK_REPORT_MUTATION_QUEUE_PRESSURE",
    "MEETING_JOB_BACKLOG_OLD",
  ]);
});

test("Meeting health 讀取失敗時仍保留 Node 與 mutation queue snapshot", async () => {
  const snapshot = await collectRuntimeHealthSnapshot({
    getEventLoopLagStats: () => ({ mean: 2, p95: 3, max: 4 }),
    getMutationQueueStats: () => ({
      accepting: true,
      activeKeyCount: 0,
      pendingTaskCount: 0,
      oldestPendingTaskAgeMs: 0,
      highestPendingTaskCountPerKey: 0,
      maxPendingTaskCount: 500,
      maxPendingTaskCountPerKey: 25,
      maxOldestPendingTaskAgeMs: 600_000,
    }),
    getMeetingJobStats: async () => {
      throw new Error("database is busy");
    },
  });

  assert.equal(snapshot.meetingJobs, null);
  assert.equal(snapshot.eventLoopLagMs.p95, 3);
  assert.equal(snapshot.workReportMutationQueue.pendingTaskCount, 0);
  assert.ok(snapshot.memory.rssBytes > 0);
  assert.deepEqual(snapshot.warnings, ["MEETING_JOB_HEALTH_UNAVAILABLE"]);
});

test("runtime health 關閉時不啟動背景採樣或建立 Meeting SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-health-disabled-"));
  const meetingDbFile = join(root, "meeting-health.sqlite3");
  const loggerModulePath = require.resolve("../../src/observability/runtimeHealthLogger");

  try {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        [
          "const logger = require(process.argv[1]);",
          "logger.startRuntimeHealthLogger();",
          "setTimeout(() => { logger.stopRuntimeHealthLogger(); process.exit(0); }, 200);",
        ].join(""),
        loggerModulePath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          RUNTIME_HEALTH_LOG_ENABLED: "false",
          MEETING_PROCESSING_DB_FILE: meetingDbFile,
        },
        timeout: 5_000,
      }
    );

    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(
      access(meetingDbFile),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ENOENT"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
