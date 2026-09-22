import fs from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../config/env";
import {
  readMeetingJobQueueHealthStats,
  type MeetingJobQueueHealthStats,
} from "./meetingJobQueueHealth";

export const MEETING_TRANSCRIPTION_STATUSES = [
  "pending",
  "running",
  "ready",
  "failed",
] as const;

export type MeetingTranscriptionStatus =
  (typeof MEETING_TRANSCRIPTION_STATUSES)[number];

export const MEETING_TRANSCRIPTION_PHASES = [
  "queued",
  "preparing",
  "transcribing-room-mic",
  "transcribing-remote-tab",
  "merging-transcript",
  "ready",
] as const;

export type MeetingTranscriptionPhase =
  (typeof MEETING_TRANSCRIPTION_PHASES)[number];

export type MeetingTranscriptSourceId = "room-mic" | "remote-tab";

export interface MeetingTranscriptSegment {
  segmentId: string;
  sourceId: MeetingTranscriptSourceId;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;
  confidence: number | null;
}

export type MeetingTranscriptionArtifactType =
  | "transcript-room-mic-json"
  | "transcript-remote-tab-json"
  | "transcript-merged-json"
  | "transcript-text";

export interface MeetingTranscriptionArtifactRecord {
  artifactId: string;
  jobId: string;
  sessionId: string;
  type: MeetingTranscriptionArtifactType;
  mimeType: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface MeetingTranscriptionChunkCheckpoint {
  jobId: string;
  sessionId: string;
  sourceId: MeetingTranscriptSourceId;
  chunkIndex: number;
  startMs: number;
  endMs: number;
  audioSha256: string;
  segments: MeetingTranscriptSegment[];
  createdAt: string;
  updatedAt: string;
}

export interface MeetingTranscriptionJobRecord {
  jobId: string;
  processingJobId: string;
  sessionId: string;
  ownerId: string;
  provider: string;
  model: string;
  status: MeetingTranscriptionStatus;
  phase: MeetingTranscriptionPhase;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  artifacts: MeetingTranscriptionArtifactRecord[];
}

interface JobRow {
  job_id: string;
  processing_job_id: string;
  session_id: string;
  owner_id: string;
  provider: string;
  model: string;
  status: MeetingTranscriptionStatus;
  phase: MeetingTranscriptionPhase;
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

interface ChunkRow {
  job_id: string;
  session_id: string;
  source_id: MeetingTranscriptSourceId;
  chunk_index: number;
  start_ms: number;
  end_ms: number;
  audio_sha256: string;
  segments_json: string;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  artifact_id: string;
  job_id: string;
  session_id: string;
  artifact_type: MeetingTranscriptionArtifactType;
  mime_type: string;
  relative_path: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

function mapArtifact(row: ArtifactRow): MeetingTranscriptionArtifactRecord {
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

function mapChunk(row: ChunkRow): MeetingTranscriptionChunkCheckpoint {
  return {
    jobId: row.job_id,
    sessionId: row.session_id,
    sourceId: row.source_id,
    chunkIndex: row.chunk_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    audioSha256: row.audio_sha256,
    segments: JSON.parse(row.segments_json) as MeetingTranscriptSegment[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJob(
  row: JobRow,
  artifacts: MeetingTranscriptionArtifactRecord[] = []
): MeetingTranscriptionJobRecord {
  return {
    jobId: row.job_id,
    processingJobId: row.processing_job_id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    provider: row.provider,
    model: row.model,
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

export class MeetingTranscriptionJobRepository {
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
      "meeting_transcription_jobs",
      now
    );
  }

  async enqueue(input: {
    jobId: string;
    processingJobId: string;
    sessionId: string;
    ownerId: string;
    provider: string;
    model: string;
    maxAttempts: number;
    now: string;
  }): Promise<{ job: MeetingTranscriptionJobRecord; created: boolean }> {
    const db = await this.getDb();
    const result = await db.run(
      `INSERT OR IGNORE INTO meeting_transcription_jobs (
        job_id, processing_job_id, session_id, owner_id, provider, model,
        status, phase, attempt_count, max_attempts, error_code, error_message,
        created_at, started_at, updated_at, completed_at, worker_id, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'queued', 0, ?, NULL, NULL, ?, NULL, ?, NULL, NULL, NULL)`,
      input.jobId,
      input.processingJobId,
      input.sessionId,
      input.ownerId,
      input.provider,
      input.model,
      Math.max(1, Math.trunc(input.maxAttempts)),
      input.now,
      input.now
    );
    const row = await db.get<JobRow>(
      `SELECT * FROM meeting_transcription_jobs
       WHERE session_id = ? OR processing_job_id = ?
       ORDER BY CASE WHEN session_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      input.sessionId,
      input.processingJobId,
      input.sessionId
    );
    if (!row) throw new Error("meeting transcription job enqueue failed");
    if (row.owner_id !== input.ownerId) {
      throw new Error("meeting transcription job owner mismatch");
    }
    if (
      row.session_id !== input.sessionId ||
      row.processing_job_id !== input.processingJobId
    ) {
      throw new Error("meeting transcription job source mismatch");
    }
    return { job: await this.attachArtifacts(mapJob(row)), created: result.changes === 1 };
  }

  async getJob(jobId: string): Promise<MeetingTranscriptionJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      "SELECT * FROM meeting_transcription_jobs WHERE job_id = ?",
      jobId
    );
    return row ? this.attachArtifacts(mapJob(row)) : null;
  }

  async getJobForOwner(
    jobId: string,
    ownerId: string
  ): Promise<MeetingTranscriptionJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      "SELECT * FROM meeting_transcription_jobs WHERE job_id = ? AND owner_id = ?",
      jobId,
      ownerId
    );
    return row ? this.attachArtifacts(mapJob(row)) : null;
  }

  async getJobBySessionForOwner(
    sessionId: string,
    ownerId: string
  ): Promise<MeetingTranscriptionJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      "SELECT * FROM meeting_transcription_jobs WHERE session_id = ? AND owner_id = ?",
      sessionId,
      ownerId
    );
    return row ? this.attachArtifacts(mapJob(row)) : null;
  }

  async listActiveSessionIds(input: {
    provider: string;
    model: string;
    providerChangedAfter: string;
  }): Promise<string[]> {
    const db = await this.getDb();
    const rows = await db.all<Array<{ session_id: string }>>(
      `SELECT session_id FROM meeting_transcription_jobs
       WHERE status IN ('pending', 'running')
          OR (
            status = 'failed'
            AND (
              (provider = ? AND model = ? AND attempt_count < max_attempts)
              OR (
                (provider != ? OR model != ?)
                AND COALESCE(error_code, '') != 'MEETING_TRANSCRIPTION_PROVIDER_MIGRATION_EXPIRED'
                AND (
                  COALESCE(error_code, '') != 'MEETING_TRANSCRIPTION_PROVIDER_CHANGED'
                  OR updated_at > ?
                )
              )
            )
          )
       ORDER BY created_at ASC, job_id ASC`,
      input.provider,
      input.model,
      input.provider,
      input.model,
      input.providerChangedAfter
    );
    return rows.map((row) => row.session_id);
  }

  async deleteTerminalJobsByProcessingJobIds(
    processingJobIds: string[]
  ): Promise<string[]> {
    if (processingJobIds.length === 0) return [];
    const db = await this.getDb();
    const deletedJobIds: string[] = [];
    await db.exec("BEGIN IMMEDIATE");
    try {
      for (const processingJobId of processingJobIds) {
        const job = await db.get<Pick<JobRow, "job_id">>(
          `DELETE FROM meeting_transcription_jobs
           WHERE processing_job_id = ? AND status IN ('ready', 'failed')
           RETURNING job_id`,
          processingJobId
        );
        if (!job) continue;
        deletedJobIds.push(job.job_id);
      }
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
    return deletedJobIds;
  }

  async claimNext(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<MeetingTranscriptionJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      `UPDATE meeting_transcription_jobs
       SET status = 'running', phase = 'preparing', attempt_count = attempt_count + 1,
           error_code = NULL, error_message = NULL, started_at = ?, updated_at = ?,
           completed_at = NULL, worker_id = ?, lease_expires_at = ?
       WHERE job_id = (
         SELECT job_id FROM meeting_transcription_jobs
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
    phase: MeetingTranscriptionPhase;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.run(
      `UPDATE meeting_transcription_jobs
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
      `UPDATE meeting_transcription_jobs
       SET updated_at = ?, lease_expires_at = ?
       WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
      input.now,
      input.leaseExpiresAt,
      input.jobId,
      input.workerId
    );
    return result.changes === 1;
  }

  async saveChunkCheckpoint(input: {
    jobId: string;
    sessionId: string;
    sourceId: MeetingTranscriptSourceId;
    chunkIndex: number;
    startMs: number;
    endMs: number;
    audioSha256: string;
    segments: MeetingTranscriptSegment[];
    now: string;
  }): Promise<MeetingTranscriptionChunkCheckpoint> {
    const db = await this.getDb();
    const job = await db.get<Pick<JobRow, "session_id">>(
      "SELECT session_id FROM meeting_transcription_jobs WHERE job_id = ?",
      input.jobId
    );
    if (!job || job.session_id !== input.sessionId) {
      throw new Error("meeting transcription chunk job mismatch");
    }
    await db.run(
      `INSERT INTO meeting_transcription_chunks (
        job_id, session_id, source_id, chunk_index, start_ms, end_ms,
        audio_sha256, segments_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id, source_id, chunk_index) DO UPDATE SET
        session_id = excluded.session_id,
        start_ms = excluded.start_ms,
        end_ms = excluded.end_ms,
        audio_sha256 = excluded.audio_sha256,
        segments_json = excluded.segments_json,
        updated_at = excluded.updated_at`,
      input.jobId,
      input.sessionId,
      input.sourceId,
      Math.max(0, Math.trunc(input.chunkIndex)),
      Math.max(0, Math.trunc(input.startMs)),
      Math.max(0, Math.trunc(input.endMs)),
      input.audioSha256,
      JSON.stringify(input.segments),
      input.now,
      input.now
    );
    const checkpoint = await this.getChunkCheckpoint(
      input.jobId,
      input.sourceId,
      input.chunkIndex,
      input.audioSha256
    );
    if (!checkpoint) throw new Error("meeting transcription chunk checkpoint failed");
    return checkpoint;
  }

  async getChunkCheckpoint(
    jobId: string,
    sourceId: MeetingTranscriptSourceId,
    chunkIndex: number,
    audioSha256: string
  ): Promise<MeetingTranscriptionChunkCheckpoint | null> {
    const db = await this.getDb();
    const row = await db.get<ChunkRow>(
      `SELECT * FROM meeting_transcription_chunks
       WHERE job_id = ? AND source_id = ? AND chunk_index = ? AND audio_sha256 = ?`,
      jobId,
      sourceId,
      Math.max(0, Math.trunc(chunkIndex)),
      audioSha256
    );
    return row ? mapChunk(row) : null;
  }

  async listChunkCheckpoints(
    jobId: string
  ): Promise<MeetingTranscriptionChunkCheckpoint[]> {
    const db = await this.getDb();
    const rows = await db.all<ChunkRow[]>(
      `SELECT * FROM meeting_transcription_chunks
       WHERE job_id = ?
       ORDER BY source_id ASC, chunk_index ASC`,
      jobId
    );
    return rows.map(mapChunk);
  }

  async markReady(input: {
    jobId: string;
    workerId: string;
    artifacts: MeetingTranscriptionArtifactRecord[];
    now: string;
  }): Promise<MeetingTranscriptionJobRecord> {
    const db = await this.getDb();
    await db.exec("BEGIN IMMEDIATE");
    try {
      const state = await db.get<
        Pick<JobRow, "status" | "worker_id" | "session_id">
      >(
        "SELECT status, worker_id, session_id FROM meeting_transcription_jobs WHERE job_id = ?",
        input.jobId
      );
      if (!state || state.status !== "running" || state.worker_id !== input.workerId) {
        throw new Error("meeting transcription job lease lost");
      }
      for (const artifact of input.artifacts) {
        if (artifact.jobId !== input.jobId || artifact.sessionId !== state.session_id) {
          throw new Error("meeting transcription artifact job mismatch");
        }
        await db.run(
          `INSERT INTO meeting_transcription_artifacts (
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
        `UPDATE meeting_transcription_jobs
         SET status = 'ready', phase = 'ready', error_code = NULL, error_message = NULL,
             updated_at = ?, completed_at = ?, worker_id = NULL, lease_expires_at = NULL
         WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
        input.now,
        input.now,
        input.jobId,
        input.workerId
      );
      if (result.changes !== 1) {
        throw new Error("meeting transcription job ready transition failed");
      }
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
    const job = await this.getJob(input.jobId);
    if (!job) throw new Error("meeting transcription job disappeared after ready transition");
    return job;
  }

  async markFailed(input: {
    jobId: string;
    workerId: string;
    errorCode: string;
    errorMessage: string;
    now: string;
  }): Promise<MeetingTranscriptionJobRecord> {
    const db = await this.getDb();
    const result = await db.run(
      `UPDATE meeting_transcription_jobs
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?,
           completed_at = ?, worker_id = NULL, lease_expires_at = NULL
       WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
      input.errorCode,
      input.errorMessage,
      input.now,
      input.now,
      input.jobId,
      input.workerId
    );
    if (result.changes !== 1) {
      throw new Error("meeting transcription job failed transition failed");
    }
    const job = await this.getJob(input.jobId);
    if (!job) throw new Error("meeting transcription job disappeared after failed transition");
    return job;
  }

  async requeueClaimed(input: {
    jobId: string;
    workerId: string;
    now: string;
  }): Promise<MeetingTranscriptionJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      `UPDATE meeting_transcription_jobs
       SET status = 'pending', phase = 'queued', attempt_count = MAX(0, attempt_count - 1),
           error_code = 'WORKER_SHUTDOWN',
           error_message = '逐字稿 worker 關閉，任務已重新排隊',
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

  async retry(input: {
    jobId: string;
    ownerId: string;
    provider: string;
    model: string;
    now: string;
    providerChangedAfter: string;
  }): Promise<MeetingTranscriptionJobRecord | null> {
    const db = await this.getDb();
    await db.exec("BEGIN IMMEDIATE");
    try {
      const current = await db.get<JobRow>(
        `SELECT * FROM meeting_transcription_jobs
         WHERE job_id = ? AND owner_id = ? AND status = 'failed'`,
        input.jobId,
        input.ownerId
      );
      if (!current) {
        await db.exec("ROLLBACK");
        return null;
      }
      const providerChanged =
        current.provider !== input.provider || current.model !== input.model;
      if (
        (!providerChanged && current.attempt_count >= current.max_attempts) ||
        (providerChanged &&
          (current.updated_at <= input.providerChangedAfter ||
            current.error_code ===
              'MEETING_TRANSCRIPTION_PROVIDER_MIGRATION_EXPIRED'))
      ) {
        await db.exec("ROLLBACK");
        return null;
      }
      if (providerChanged) {
        await db.run(
          "DELETE FROM meeting_transcription_chunks WHERE job_id = ?",
          input.jobId
        );
      }
      const row = await db.get<JobRow>(
        `UPDATE meeting_transcription_jobs
         SET provider = ?, model = ?, status = 'pending', phase = 'queued',
             attempt_count = CASE WHEN provider != ? OR model != ? THEN 0 ELSE attempt_count END,
             error_code = NULL, error_message = NULL, started_at = NULL,
             updated_at = ?, completed_at = NULL, worker_id = NULL, lease_expires_at = NULL
         WHERE job_id = ? AND owner_id = ? AND status = 'failed'
         RETURNING *`,
        input.provider,
        input.model,
        input.provider,
        input.model,
        input.now,
        input.jobId,
        input.ownerId
      );
      await db.exec("COMMIT");
      return row ? this.attachArtifacts(mapJob(row)) : null;
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }

  async requeueRetryableFailed(now: string, retryBefore: string): Promise<string[]> {
    const db = await this.getDb();
    const rows = await db.all<Array<{ job_id: string }>>(
      `UPDATE meeting_transcription_jobs
       SET status = 'pending', phase = 'queued', error_code = NULL, error_message = NULL,
           started_at = NULL, updated_at = ?, completed_at = NULL,
           worker_id = NULL, lease_expires_at = NULL
       WHERE status = 'failed' AND attempt_count < max_attempts AND updated_at <= ?
         AND error_code != 'MEETING_TRANSCRIPTION_PROVIDER_CHANGED'
       RETURNING job_id`,
      now,
      retryBefore
    );
    return rows.map((row) => row.job_id);
  }

  async expireProviderMigrationFailures(input: {
    provider: string;
    model: string;
    now: string;
    retryBefore: string;
  }): Promise<string[]> {
    const db = await this.getDb();
    const rows = await db.all<Array<{ job_id: string }>>(
      `UPDATE meeting_transcription_jobs
       SET attempt_count = max_attempts,
           error_code = 'MEETING_TRANSCRIPTION_PROVIDER_MIGRATION_EXPIRED',
           error_message = '逐字稿 provider 升級重送期限已過，來源音訊可能已由容量清理回收。',
           updated_at = ?, completed_at = ?
       WHERE status = 'failed'
         AND (provider != ? OR model != ?)
         AND updated_at <= ?
         AND error_code = 'MEETING_TRANSCRIPTION_PROVIDER_CHANGED'
       RETURNING job_id`,
      input.now,
      input.now,
      input.provider,
      input.model,
      input.retryBefore
    );
    return rows.map((row) => row.job_id);
  }

  async markProviderMigrationFailures(input: {
    provider: string;
    model: string;
    now: string;
  }): Promise<string[]> {
    const db = await this.getDb();
    const rows = await db.all<Array<{ job_id: string }>>(
      `UPDATE meeting_transcription_jobs
       SET error_code = 'MEETING_TRANSCRIPTION_PROVIDER_CHANGED',
           error_message = '逐字稿 provider 或 model 已變更，請從任務畫面重新處理。',
           updated_at = ?, completed_at = ?
       WHERE status = 'failed'
         AND (provider != ? OR model != ?)
         AND COALESCE(error_code, '') NOT IN (
           'MEETING_TRANSCRIPTION_PROVIDER_CHANGED',
           'MEETING_TRANSCRIPTION_PROVIDER_MIGRATION_EXPIRED'
         )
       RETURNING job_id`,
      input.now,
      input.now,
      input.provider,
      input.model
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
      `UPDATE meeting_transcription_jobs
       SET status = 'pending', phase = 'queued', error_code = 'WORKER_RESTARTED',
           error_message = '逐字稿 worker 中斷，已重新排隊', started_at = NULL,
           updated_at = ?, completed_at = NULL, worker_id = NULL, lease_expires_at = NULL
       WHERE status = 'running' AND lease_expires_at < ? AND attempt_count < max_attempts
       RETURNING job_id`,
      now,
      now
    );
    const exhausted = await db.all<Array<{ job_id: string }>>(
      `UPDATE meeting_transcription_jobs
       SET status = 'failed', error_code = 'TRANSCRIPTION_ATTEMPTS_EXHAUSTED',
           error_message = '逐字稿 worker 中斷且已達重試上限', updated_at = ?, completed_at = ?,
           worker_id = NULL, lease_expires_at = NULL
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

  private async attachArtifacts(
    job: MeetingTranscriptionJobRecord
  ): Promise<MeetingTranscriptionJobRecord> {
    const db = await this.getDb();
    const rows = await db.all<ArtifactRow[]>(
      `SELECT * FROM meeting_transcription_artifacts
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
        `CREATE TABLE IF NOT EXISTS meeting_transcription_jobs (
          job_id TEXT PRIMARY KEY,
          processing_job_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL UNIQUE,
          owner_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'failed')),
          phase TEXT NOT NULL CHECK (phase IN (
            'queued', 'preparing', 'transcribing-room-mic',
            'transcribing-remote-tab', 'merging-transcript', 'ready'
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
        `CREATE TABLE IF NOT EXISTS meeting_transcription_chunks (
          job_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          source_id TEXT NOT NULL CHECK (source_id IN ('room-mic', 'remote-tab')),
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
          start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
          end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
          audio_sha256 TEXT NOT NULL,
          segments_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (job_id, source_id, chunk_index),
          FOREIGN KEY (job_id) REFERENCES meeting_transcription_jobs(job_id) ON DELETE CASCADE
        );`,
        `CREATE TABLE IF NOT EXISTS meeting_transcription_artifacts (
          artifact_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          artifact_type TEXT NOT NULL CHECK (artifact_type IN (
            'transcript-room-mic-json', 'transcript-remote-tab-json',
            'transcript-merged-json', 'transcript-text'
          )),
          mime_type TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (job_id, artifact_type),
          FOREIGN KEY (job_id) REFERENCES meeting_transcription_jobs(job_id) ON DELETE CASCADE
        );`,
        `CREATE INDEX IF NOT EXISTS idx_meeting_transcription_claim
         ON meeting_transcription_jobs(status, created_at, job_id);`,
        `CREATE INDEX IF NOT EXISTS idx_meeting_transcription_owner
         ON meeting_transcription_jobs(owner_id, created_at DESC);`,
        `CREATE INDEX IF NOT EXISTS idx_meeting_transcription_lease
         ON meeting_transcription_jobs(status, lease_expires_at);`,
      ].join("\n")
    );
    return db;
  }
}

export const meetingTranscriptionJobRepository =
  new MeetingTranscriptionJobRepository();
