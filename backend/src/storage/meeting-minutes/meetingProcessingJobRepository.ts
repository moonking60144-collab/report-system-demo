import fs from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../config/env";
import {
  readMeetingJobQueueHealthStats,
  type MeetingJobQueueHealthStats,
} from "./meetingJobQueueHealth";

export const MEETING_PROCESSING_STATUSES = [
  "pending",
  "running",
  "ready",
  "failed",
] as const;

export type MeetingProcessingStatus = (typeof MEETING_PROCESSING_STATUSES)[number];

export const MEETING_PROCESSING_PHASES = [
  "queued",
  "validating-audio",
  "normalizing-room-mic",
  "normalizing-remote-tab",
  "generating-playback",
  "ready",
] as const;

export type MeetingProcessingPhase = (typeof MEETING_PROCESSING_PHASES)[number];

export const MEETING_PROCESSING_ARTIFACT_EVICTED_ERROR_CODE =
  "MEETING_PROCESSING_ARTIFACT_EVICTED";

export type MeetingProcessingArtifactType =
  | "canonical-room-mic"
  | "canonical-remote-tab"
  | "playback";

export interface MeetingProcessingArtifactRecord {
  artifactId: string;
  jobId: string;
  sessionId: string;
  type: MeetingProcessingArtifactType;
  mimeType: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface MeetingProcessingJobRecord {
  jobId: string;
  sessionId: string;
  ownerId: string;
  status: MeetingProcessingStatus;
  phase: MeetingProcessingPhase;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  artifacts: MeetingProcessingArtifactRecord[];
}

interface JobRow {
  job_id: string;
  session_id: string;
  owner_id: string;
  status: MeetingProcessingStatus;
  phase: MeetingProcessingPhase;
  attempt_count: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
}

interface ArtifactRow {
  artifact_id: string;
  job_id: string;
  session_id: string;
  artifact_type: MeetingProcessingArtifactType;
  mime_type: string;
  relative_path: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

function mapArtifact(row: ArtifactRow): MeetingProcessingArtifactRecord {
  return {
    artifactId: row.artifact_id,
    jobId: row.job_id,
    sessionId: row.session_id,
    type: row.artifact_type,
    mimeType: row.mime_type,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function mapJob(row: JobRow, artifacts: MeetingProcessingArtifactRecord[] = []): MeetingProcessingJobRecord {
  return {
    jobId: row.job_id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    status: row.status,
    phase: row.phase,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    artifacts,
  };
}

export class MeetingProcessingJobRepository {
  private dbPromise: Promise<Database> | null = null;

  constructor(private readonly dbFile = env.MEETING_PROCESSING_DB_FILE) {}

  async initialize(): Promise<void> {
    await this.getDb();
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    this.dbPromise = null;
    await db.close();
  }

  async getQueueHealthStats(now = Date.now()): Promise<MeetingJobQueueHealthStats> {
    return readMeetingJobQueueHealthStats(
      await this.getDb(),
      "meeting_processing_jobs",
      now
    );
  }

  async enqueue(input: {
    jobId: string;
    sessionId: string;
    ownerId: string;
    maxAttempts: number;
    now: string;
  }): Promise<{ job: MeetingProcessingJobRecord; created: boolean }> {
    const db = await this.getDb();
    const result = await db.run(
      `INSERT OR IGNORE INTO meeting_processing_jobs (
        job_id, session_id, owner_id, status, phase, attempt_count, max_attempts,
        error_code, error_message, created_at, started_at, updated_at, completed_at
      ) VALUES (?, ?, ?, 'pending', 'queued', 0, ?, NULL, NULL, ?, NULL, ?, NULL)`,
      input.jobId,
      input.sessionId,
      input.ownerId,
      Math.max(1, Math.trunc(input.maxAttempts)),
      input.now,
      input.now
    );
    const row = await db.get<JobRow>(
      "SELECT * FROM meeting_processing_jobs WHERE session_id = ?",
      input.sessionId
    );
    if (!row) {
      throw new Error("meeting processing job enqueue failed");
    }
    if (row.owner_id !== input.ownerId) {
      throw new Error("meeting processing job owner mismatch");
    }
    return { job: await this.attachArtifacts(mapJob(row)), created: result.changes === 1 };
  }

  async getJob(jobId: string): Promise<MeetingProcessingJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      "SELECT * FROM meeting_processing_jobs WHERE job_id = ?",
      jobId
    );
    return row ? this.attachArtifacts(mapJob(row)) : null;
  }

  async getJobForOwner(jobId: string, ownerId: string): Promise<MeetingProcessingJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      "SELECT * FROM meeting_processing_jobs WHERE job_id = ? AND owner_id = ?",
      jobId,
      ownerId
    );
    return row ? this.attachArtifacts(mapJob(row)) : null;
  }

  async getJobBySessionForOwner(
    sessionId: string,
    ownerId: string
  ): Promise<MeetingProcessingJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      "SELECT * FROM meeting_processing_jobs WHERE session_id = ? AND owner_id = ?",
      sessionId,
      ownerId
    );
    return row ? this.attachArtifacts(mapJob(row)) : null;
  }

  async listJobsForOwner(ownerId: string, limit = 20): Promise<MeetingProcessingJobRecord[]> {
    const db = await this.getDb();
    const rows = await db.all<JobRow[]>(
      `SELECT * FROM meeting_processing_jobs
       WHERE owner_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      ownerId,
      Math.max(1, Math.min(200, Math.trunc(limit)))
    );
    return Promise.all(rows.map((row) => this.attachArtifacts(mapJob(row))));
  }

  async listJobsWithReleasableLocks(): Promise<MeetingProcessingJobRecord[]> {
    const db = await this.getDb();
    const rows = await db.all<JobRow[]>(
      `SELECT * FROM meeting_processing_jobs
       WHERE status = 'ready'
          OR (status = 'failed' AND attempt_count >= max_attempts)
       ORDER BY updated_at ASC, job_id ASC`
    );
    return rows.map((row) => mapJob(row));
  }

  async listReadyJobsWithArtifacts(): Promise<MeetingProcessingJobRecord[]> {
    const db = await this.getDb();
    const rows = await db.all<JobRow[]>(
      `SELECT jobs.* FROM meeting_processing_jobs AS jobs
       WHERE jobs.status = 'ready'
         AND EXISTS (
           SELECT 1 FROM meeting_processing_artifacts AS artifacts
           WHERE artifacts.job_id = jobs.job_id
         )
       ORDER BY jobs.completed_at ASC, jobs.job_id ASC`
    );
    return Promise.all(rows.map((row) => this.attachArtifacts(mapJob(row))));
  }

  async listArtifactEvictionJobsWithArtifacts(): Promise<MeetingProcessingJobRecord[]> {
    const db = await this.getDb();
    const rows = await db.all<JobRow[]>(
      `SELECT jobs.* FROM meeting_processing_jobs AS jobs
       WHERE jobs.status = 'failed'
         AND jobs.error_code = ?
         AND EXISTS (
           SELECT 1 FROM meeting_processing_artifacts AS artifacts
           WHERE artifacts.job_id = jobs.job_id
         )
       ORDER BY jobs.updated_at ASC, jobs.job_id ASC`,
      MEETING_PROCESSING_ARTIFACT_EVICTED_ERROR_CODE
    );
    return Promise.all(rows.map((row) => this.attachArtifacts(mapJob(row))));
  }

  async beginArtifactEvictionForReadyJob(jobId: string, now: string): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.run(
      `UPDATE meeting_processing_jobs
       SET status = 'failed', phase = 'queued', attempt_count = 0,
           error_code = ?,
           error_message = '後處理音訊已依容量上限淘汰，可重新處理。',
           started_at = NULL, updated_at = ?, completed_at = NULL,
           worker_id = NULL, lease_expires_at = NULL
       WHERE job_id = ? AND status = 'ready'`,
      MEETING_PROCESSING_ARTIFACT_EVICTED_ERROR_CODE,
      now,
      jobId
    );
    return result.changes === 1;
  }

  async completeArtifactEviction(jobId: string): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.run(
      `DELETE FROM meeting_processing_artifacts
       WHERE job_id = ?
         AND EXISTS (
           SELECT 1 FROM meeting_processing_jobs
           WHERE job_id = ? AND status = 'failed' AND error_code = ?
         )`,
      jobId,
      jobId,
      MEETING_PROCESSING_ARTIFACT_EVICTED_ERROR_CODE
    );
    return (result.changes ?? 0) > 0;
  }

  async listTerminalJobIdsWithoutArtifacts(): Promise<string[]> {
    const db = await this.getDb();
    const rows = await db.all<Array<{ job_id: string }>>(
      `SELECT jobs.job_id FROM meeting_processing_jobs AS jobs
       WHERE (jobs.status = 'ready'
          OR (jobs.status = 'failed' AND jobs.attempt_count >= jobs.max_attempts))
         AND NOT EXISTS (
           SELECT 1 FROM meeting_processing_artifacts AS artifacts
           WHERE artifacts.job_id = jobs.job_id
         )
       ORDER BY jobs.updated_at ASC, jobs.job_id ASC`
    );
    return rows.map((row) => row.job_id);
  }

  async claimNext(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<MeetingProcessingJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      `UPDATE meeting_processing_jobs
       SET status = 'running',
           phase = 'validating-audio',
           attempt_count = attempt_count + 1,
           error_code = NULL,
           error_message = NULL,
           started_at = ?,
           updated_at = ?,
           completed_at = NULL,
           worker_id = ?,
           lease_expires_at = ?
       WHERE job_id = (
         SELECT job_id FROM meeting_processing_jobs
         WHERE status = 'pending' AND attempt_count < max_attempts
         ORDER BY created_at ASC, job_id ASC
         LIMIT 1
       ) AND status = 'pending'
       RETURNING *`,
      input.now,
      input.now,
      input.workerId,
      input.leaseExpiresAt
    );
    return row ? mapJob(row) : null;
  }

  async updatePhase(input: {
    jobId: string;
    workerId: string;
    phase: MeetingProcessingPhase;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.run(
      `UPDATE meeting_processing_jobs
       SET phase = ?, updated_at = ?, lease_expires_at = ?
       WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
      input.phase,
      input.now,
      input.leaseExpiresAt,
      input.jobId,
      input.workerId
    );
    return result.changes === 1;
  }

  async heartbeat(input: {
    jobId: string;
    workerId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.run(
      `UPDATE meeting_processing_jobs
       SET updated_at = ?, lease_expires_at = ?
       WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
      input.now,
      input.leaseExpiresAt,
      input.jobId,
      input.workerId
    );
    return result.changes === 1;
  }

  async markReady(input: {
    jobId: string;
    workerId: string;
    artifacts: MeetingProcessingArtifactRecord[];
    now: string;
  }): Promise<MeetingProcessingJobRecord> {
    const db = await this.getDb();
    await db.exec("BEGIN IMMEDIATE");
    try {
      const state = await db.get<
        Pick<JobRow, "status" | "worker_id"> & { session_id: string }
      >(
        "SELECT status, worker_id, session_id FROM meeting_processing_jobs WHERE job_id = ?",
        input.jobId
      );
      if (!state || state.status !== "running" || state.worker_id !== input.workerId) {
        throw new Error("meeting processing job lease lost");
      }
      for (const artifact of input.artifacts) {
        if (artifact.jobId !== input.jobId || artifact.sessionId !== state.session_id) {
          throw new Error("meeting processing artifact job mismatch");
        }
        await db.run(
          `INSERT INTO meeting_processing_artifacts (
            artifact_id, job_id, session_id, artifact_type, mime_type,
            relative_path, size_bytes, sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(job_id, artifact_type) DO UPDATE SET
            artifact_id = excluded.artifact_id,
            mime_type = excluded.mime_type,
            relative_path = excluded.relative_path,
            size_bytes = excluded.size_bytes,
            sha256 = excluded.sha256,
            created_at = excluded.created_at`,
          artifact.artifactId,
          artifact.jobId,
          artifact.sessionId,
          artifact.type,
          artifact.mimeType,
          artifact.relativePath,
          artifact.sizeBytes,
          artifact.sha256,
          artifact.createdAt
        );
      }
      const result = await db.run(
        `UPDATE meeting_processing_jobs
         SET status = 'ready', phase = 'ready', error_code = NULL, error_message = NULL,
             updated_at = ?, completed_at = ?, worker_id = NULL, lease_expires_at = NULL
         WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
        input.now,
        input.now,
        input.jobId,
        input.workerId
      );
      if (result.changes !== 1) {
        throw new Error("meeting processing job ready transition failed");
      }
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
    const job = await this.getJob(input.jobId);
    if (!job) throw new Error("meeting processing job disappeared after ready transition");
    return job;
  }

  async markFailed(input: {
    jobId: string;
    workerId: string;
    errorCode: string;
    errorMessage: string;
    now: string;
  }): Promise<MeetingProcessingJobRecord> {
    const db = await this.getDb();
    const result = await db.run(
      `UPDATE meeting_processing_jobs
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?, completed_at = ?,
           worker_id = NULL, lease_expires_at = NULL
       WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
      input.errorCode,
      input.errorMessage,
      input.now,
      input.now,
      input.jobId,
      input.workerId
    );
    if (result.changes !== 1) {
      throw new Error("meeting processing job failed transition failed");
    }
    const job = await this.getJob(input.jobId);
    if (!job) throw new Error("meeting processing job disappeared after failed transition");
    return job;
  }

  async requeueClaimed(input: {
    jobId: string;
    workerId: string;
    now: string;
  }): Promise<MeetingProcessingJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      `UPDATE meeting_processing_jobs
       SET status = 'pending', phase = 'queued',
           attempt_count = MAX(0, attempt_count - 1),
           error_code = 'WORKER_SHUTDOWN',
           error_message = '後處理 worker 關閉，任務已重新排隊',
           started_at = NULL, updated_at = ?, completed_at = NULL,
           worker_id = NULL, lease_expires_at = NULL
       WHERE job_id = ? AND status = 'running' AND worker_id = ?
       RETURNING *`,
      input.now,
      input.jobId,
      input.workerId
    );
    return row ? this.attachArtifacts(mapJob(row)) : null;
  }

  async retry(jobId: string, ownerId: string, now: string): Promise<MeetingProcessingJobRecord | null> {
    const db = await this.getDb();
    await db.exec("BEGIN IMMEDIATE");
    try {
      const row = await db.get<JobRow>(
        `UPDATE meeting_processing_jobs
         SET status = 'pending', phase = 'queued', error_code = NULL, error_message = NULL,
             started_at = NULL, updated_at = ?, completed_at = NULL,
             worker_id = NULL, lease_expires_at = NULL
         WHERE job_id = ? AND owner_id = ? AND status = 'failed' AND attempt_count < max_attempts
         RETURNING *`,
        now,
        jobId,
        ownerId
      );
      if (!row) {
        await db.exec("ROLLBACK");
        return null;
      }
      await db.run("DELETE FROM meeting_processing_artifacts WHERE job_id = ?", jobId);
      await db.exec("COMMIT");
      return mapJob(row);
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }

  async requeueRetryableFailed(now: string, retryBefore: string): Promise<string[]> {
    const db = await this.getDb();
    const rows = await db.all<Array<{ job_id: string }>>(
      `UPDATE meeting_processing_jobs
       SET status = 'pending', phase = 'queued', error_code = NULL, error_message = NULL,
           started_at = NULL, updated_at = ?, completed_at = NULL,
           worker_id = NULL, lease_expires_at = NULL
       WHERE status = 'failed'
         AND attempt_count < max_attempts
         AND updated_at <= ?
         AND COALESCE(error_code, '') <> ?
       RETURNING job_id`,
      now,
      retryBefore,
      MEETING_PROCESSING_ARTIFACT_EVICTED_ERROR_CODE
    );
    return rows.map((row) => row.job_id);
  }

  async recoverExpiredRunning(now: string): Promise<{
    requeued: number;
    exhausted: number;
    requeuedJobIds: string[];
    exhaustedJobIds: string[];
  }> {
    const db = await this.getDb();
    const requeued = await db.all<Array<{ job_id: string }>>(
      `UPDATE meeting_processing_jobs
       SET status = 'pending', phase = 'queued', error_code = 'WORKER_RESTARTED',
           error_message = '後處理 worker 中斷，已重新排隊', started_at = NULL,
           updated_at = ?, completed_at = NULL, worker_id = NULL, lease_expires_at = NULL
       WHERE status = 'running' AND lease_expires_at < ? AND attempt_count < max_attempts
       RETURNING job_id`,
      now,
      now
    );
    const exhausted = await db.all<Array<{ job_id: string }>>(
      `UPDATE meeting_processing_jobs
       SET status = 'failed', error_code = 'PROCESSING_ATTEMPTS_EXHAUSTED',
           error_message = '後處理 worker 中斷且已達重試上限', updated_at = ?, completed_at = ?
           , worker_id = NULL, lease_expires_at = NULL
       WHERE status = 'running' AND lease_expires_at < ? AND attempt_count >= max_attempts
       RETURNING job_id`,
      now,
      now,
      now
    );
    return {
      requeued: requeued.length,
      exhausted: exhausted.length,
      requeuedJobIds: requeued.map((row) => row.job_id),
      exhaustedJobIds: exhausted.map((row) => row.job_id),
    };
  }

  private async attachArtifacts(job: MeetingProcessingJobRecord): Promise<MeetingProcessingJobRecord> {
    const db = await this.getDb();
    const rows = await db.all<ArtifactRow[]>(
      `SELECT * FROM meeting_processing_artifacts
       WHERE job_id = ?
       ORDER BY artifact_type ASC`,
      job.jobId
    );
    return { ...job, artifacts: rows.map(mapArtifact) };
  }

  private async getDb(): Promise<Database> {
    if (!this.dbPromise) {
      this.dbPromise = this.openDatabase().catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  private async openDatabase(): Promise<Database> {
    const filename = this.dbFile === ":memory:" ? ":memory:" : path.resolve(this.dbFile);
    if (filename !== ":memory:") {
      await fs.mkdir(path.dirname(filename), { recursive: true });
    }
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(
      [
        "PRAGMA busy_timeout=5000;",
        "PRAGMA journal_mode=WAL;",
        "PRAGMA synchronous=NORMAL;",
        "PRAGMA foreign_keys=ON;",
        `CREATE TABLE IF NOT EXISTS meeting_processing_jobs (
          job_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL UNIQUE,
          owner_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'failed')),
          phase TEXT NOT NULL CHECK (phase IN (
            'queued', 'validating-audio', 'normalizing-room-mic',
            'normalizing-remote-tab', 'generating-playback', 'ready'
          )),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          worker_id TEXT,
          lease_expires_at TEXT
        );`,
        `CREATE TABLE IF NOT EXISTS meeting_processing_artifacts (
          artifact_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          artifact_type TEXT NOT NULL CHECK (artifact_type IN (
            'canonical-room-mic', 'canonical-remote-tab', 'playback'
          )),
          mime_type TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(job_id, artifact_type),
          FOREIGN KEY (job_id) REFERENCES meeting_processing_jobs(job_id) ON DELETE CASCADE
        );`,
        "CREATE INDEX IF NOT EXISTS idx_meeting_processing_jobs_status_created ON meeting_processing_jobs(status, created_at);",
        "CREATE INDEX IF NOT EXISTS idx_meeting_processing_jobs_owner_created ON meeting_processing_jobs(owner_id, created_at DESC);",
        "CREATE INDEX IF NOT EXISTS idx_meeting_processing_jobs_lease ON meeting_processing_jobs(status, lease_expires_at);",
        "CREATE INDEX IF NOT EXISTS idx_meeting_processing_artifacts_session ON meeting_processing_artifacts(session_id, artifact_type);",
      ].join("\n")
    );
    return db;
  }
}

export const meetingProcessingJobRepository = new MeetingProcessingJobRepository();
