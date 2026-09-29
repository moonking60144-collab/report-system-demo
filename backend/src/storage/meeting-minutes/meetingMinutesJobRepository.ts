import fs from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../config/env";
import {
  readMeetingJobQueueHealthStats,
  type MeetingJobQueueHealthStats,
} from "./meetingJobQueueHealth";
import {
  normalizeMeetingMinutesHumanInput,
  type MeetingMinutesHumanInput,
  type MeetingRecord,
  validateMeetingRecord,
} from "../../services/meeting-minutes/meetingMinutesSchema";
import { MEETING_MINUTES_AUTO_RETRY_ERROR_CODES } from "../../services/meeting-minutes/meetingMinutesRetryPolicy";
import { HttpError } from "../../utils/httpError";

export const MEETING_MINUTES_JOB_STATUSES = ["pending", "running", "ready", "failed"] as const;
export type MeetingMinutesJobStatus = (typeof MEETING_MINUTES_JOB_STATUSES)[number];

export const MEETING_MINUTES_JOB_PHASES = ["queued", "generating", "packaging", "ready"] as const;
export type MeetingMinutesJobPhase = (typeof MEETING_MINUTES_JOB_PHASES)[number];

export type MeetingMinutesArtifactType =
  | "minutes-html"
  | "minutes-record-json"
  | "minutes-source-transcript-json"
  | "minutes-source-transcript-text"
  | "minutes-audio";

export interface MeetingMinutesArtifactRecord {
  artifactId: string;
  versionId: string;
  jobId: string;
  sessionId: string;
  type: MeetingMinutesArtifactType;
  filename: string;
  mimeType: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface MeetingMinutesVersionRecord {
  versionId: string;
  jobId: string;
  sessionId: string;
  ownerId: string;
  versionNumber: number;
  record: MeetingRecord;
  packageRelativePath: string | null;
  generatedAt: string;
  artifacts: MeetingMinutesArtifactRecord[];
}

export interface MeetingMinutesJobRecord {
  jobId: string;
  transcriptionJobId: string;
  sessionId: string;
  ownerId: string;
  clientRequestKey: string;
  revisionBaseVersionId?: string | null;
  inputSha256: string;
  input: MeetingMinutesHumanInput;
  provider: string;
  model: string;
  status: MeetingMinutesJobStatus;
  phase: MeetingMinutesJobPhase;
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  version: MeetingMinutesVersionRecord | null;
}

interface JobRow {
  job_id: string;
  transcription_job_id: string;
  session_id: string;
  owner_id: string;
  client_request_key: string;
  revision_base_version_id: string | null;
  input_sha256: string;
  input_json: string;
  provider: string;
  model: string;
  status: MeetingMinutesJobStatus;
  phase: MeetingMinutesJobPhase;
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

interface VersionRow {
  version_id: string;
  job_id: string;
  session_id: string;
  owner_id: string;
  version_number: number;
  status: "building" | "ready";
  record_json: string;
  package_relative_path: string | null;
  generated_at: string;
}

interface ArtifactRow {
  artifact_id: string;
  version_id: string;
  job_id: string;
  session_id: string;
  artifact_type: MeetingMinutesArtifactType;
  filename: string;
  mime_type: string;
  relative_path: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

function mapArtifact(row: ArtifactRow): MeetingMinutesArtifactRecord {
  return {
    artifactId: row.artifact_id,
    versionId: row.version_id,
    jobId: row.job_id,
    sessionId: row.session_id,
    type: row.artifact_type,
    filename: row.filename,
    mimeType: row.mime_type,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`meeting minutes ${label} JSON is corrupted`);
  }
}

function mapJob(row: JobRow): Omit<MeetingMinutesJobRecord, "version"> {
  return {
    jobId: row.job_id,
    transcriptionJobId: row.transcription_job_id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    clientRequestKey: row.client_request_key,
    revisionBaseVersionId: row.revision_base_version_id,
    inputSha256: row.input_sha256,
    input: normalizeMeetingMinutesHumanInput(
      parseJson(row.input_json, "input") as Partial<MeetingMinutesHumanInput>
    ),
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
  };
}

export class MeetingMinutesJobRepository {
  private dbPromise: Promise<Database> | null = null;
  private revisionMutation: Promise<unknown> = Promise.resolve();

  constructor(private readonly dbFile = env.MEETING_PROCESSING_DB_FILE) {}

  async initialize(): Promise<void> {
    await this.getDb();
  }

  async close(): Promise<void> {
    const current = this.dbPromise;
    this.dbPromise = null;
    if (current) await (await current).close();
  }

  async getQueueHealthStats(now = Date.now()): Promise<MeetingJobQueueHealthStats> {
    return readMeetingJobQueueHealthStats(
      await this.getDb(),
      "meeting_minutes_jobs",
      now
    );
  }

  async enqueue(input: {
    jobId: string;
    transcriptionJobId: string;
    sessionId: string;
    ownerId: string;
    clientRequestKey: string;
    inputSha256: string;
    humanInput: MeetingMinutesHumanInput;
    provider: string;
    model: string;
    maxAttempts: number;
    now: string;
    deliveryRevision?: { baseVersionId: string; maxPending: number };
  }): Promise<{ job: MeetingMinutesJobRecord; created: boolean }> {
    if (input.deliveryRevision) {
      const action = this.revisionMutation.then(async () => {
        // 避免其他 API 的入列或清理加入修訂交易，隨其失敗一起回滾。
        const transaction = new MeetingMinutesJobRepository(this.dbFile);
        try {
          const db = await transaction.getDb();
          await db.exec("BEGIN IMMEDIATE");
          try {
            const existing = await db.get<JobRow>(`SELECT * FROM meeting_minutes_jobs
              WHERE session_id=? AND owner_id=? AND client_request_key=?`, input.sessionId, input.ownerId, input.clientRequestKey);
            if (existing) {
              if (existing.input_sha256 !== input.inputSha256) throw new HttpError(409, "修訂請求編號已用於不同內容。", "MEETING_MINUTES_CLIENT_REQUEST_KEY_CONFLICT");
              await db.exec("COMMIT");
              return { job: await transaction.attachVersion(mapJob(existing)), created: false };
            }
            const session = await db.get<{ adopted_version_id: string | null; revision_job_id: string | null; expires_at: string | null; cleanup_started_at: string | null; cancel_requested_at: string | null; device_session_released_at: string | null }>(
              "SELECT * FROM meeting_one_shot_sessions WHERE session_id=? AND owner_id=?", input.sessionId, input.ownerId);
            if (!session) throw new HttpError(404, "找不到會議。", "MEETING_ONE_SHOT_NOT_FOUND");
            if (session.cleanup_started_at || !session.expires_at || session.expires_at <= input.now) throw new HttpError(410, "修訂期限已到，請使用已保存的摘要。", "MEETING_ONE_SHOT_EXPIRED");
            if (session.cancel_requested_at || session.device_session_released_at || session.adopted_version_id !== input.deliveryRevision!.baseVersionId) throw new HttpError(409, "採用版本已變更或已離開會議，請重新讀取。", "MEETING_REVISION_CONFLICT");
            if (session.revision_job_id) throw new HttpError(409, "已有修訂正在處理或等待確認，請先完成該筆修訂。", "MEETING_REVISION_PENDING");
            const count = await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM meeting_minutes_jobs
              WHERE client_request_key LIKE 'revision:%' AND (status IN ('pending','running') OR (status='failed' AND attempt_count<max_attempts))`);
            if ((count?.count ?? 0) >= input.deliveryRevision!.maxPending) throw new HttpError(409, "目前修訂工作已滿，請稍後再試。", "MEETING_REVISION_CAPACITY_FULL");
            const result = await transaction.enqueue({ ...input, deliveryRevision: undefined });
            await db.run("UPDATE meeting_minutes_jobs SET revision_base_version_id=? WHERE job_id=?", input.deliveryRevision!.baseVersionId, result.job.jobId);
            result.job.revisionBaseVersionId = input.deliveryRevision!.baseVersionId;
            await db.run("UPDATE meeting_one_shot_sessions SET revision_job_id=? WHERE session_id=?", result.job.jobId, input.sessionId);
            await db.exec("COMMIT");
            return result;
          } catch (error) {
            await db.exec("ROLLBACK").catch(() => undefined);
            throw error;
          }
        } finally {
          await transaction.close();
        }
      });
      this.revisionMutation = action.catch(() => undefined);
      return action;
    }
    const db = await this.getDb();
    const result = await db.run(
      `INSERT OR IGNORE INTO meeting_minutes_jobs (
        job_id, transcription_job_id, session_id, owner_id, client_request_key,
        input_sha256, input_json, provider, model, status, phase, attempt_count,
        max_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'queued', 0, ?, ?, ?)`,
      input.jobId,
      input.transcriptionJobId,
      input.sessionId,
      input.ownerId,
      input.clientRequestKey,
      input.inputSha256,
      JSON.stringify(input.humanInput),
      input.provider,
      input.model,
      input.maxAttempts,
      input.now,
      input.now
    );
    const row = await db.get<JobRow>(
      `SELECT * FROM meeting_minutes_jobs
       WHERE session_id = ? AND owner_id = ? AND client_request_key = ?`,
      input.sessionId,
      input.ownerId,
      input.clientRequestKey
    );
    if (!row) throw new Error("meeting minutes job disappeared after enqueue");
    if (
      row.transcription_job_id !== input.transcriptionJobId ||
      row.input_sha256 !== input.inputSha256
    ) {
      throw new Error("meeting minutes client request key payload mismatch");
    }
    return { job: await this.attachVersion(mapJob(row)), created: result.changes === 1 };
  }

  async getJob(jobId: string): Promise<MeetingMinutesJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>("SELECT * FROM meeting_minutes_jobs WHERE job_id = ?", jobId);
    return row ? this.attachVersion(mapJob(row)) : null;
  }

  async getJobForOwner(jobId: string, ownerId: string): Promise<MeetingMinutesJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      "SELECT * FROM meeting_minutes_jobs WHERE job_id = ? AND owner_id = ?",
      jobId,
      ownerId
    );
    return row ? this.attachVersion(mapJob(row)) : null;
  }

  async getJobByRequestKeyForOwner(
    sessionId: string,
    ownerId: string,
    clientRequestKey: string
  ): Promise<MeetingMinutesJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      `SELECT * FROM meeting_minutes_jobs
       WHERE session_id = ? AND owner_id = ? AND client_request_key = ?`,
      sessionId,
      ownerId,
      clientRequestKey
    );
    return row ? this.attachVersion(mapJob(row)) : null;
  }

  async listJobStatesBySessionIds(sessionIds: string[]): Promise<MeetingMinutesJobRecord[]> {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = await (await this.getDb()).all<JobRow[]>(
      `SELECT * FROM meeting_minutes_jobs WHERE session_id IN (${placeholders})
       ORDER BY created_at DESC, job_id DESC`,
      ...sessionIds
    );
    const seen = new Set<string>();
    const jobs: MeetingMinutesJobRecord[] = [];
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      jobs.push({ ...mapJob(row), version: null });
    }
    return jobs;
  }

  async listVersionsForOwner(
    sessionId: string,
    ownerId: string,
    limit = 20
  ): Promise<MeetingMinutesVersionRecord[]> {
    const db = await this.getDb();
    const rows = await db.all<VersionRow[]>(
      `SELECT * FROM meeting_minutes_versions
       WHERE session_id = ? AND owner_id = ? AND status = 'ready'
       ORDER BY version_number DESC LIMIT ?`,
      sessionId,
      ownerId,
      Math.max(1, Math.min(100, Math.trunc(limit)))
    );
    return Promise.all(rows.map((row) => this.attachArtifacts(row)));
  }

  async getVersionForOwner(
    versionId: string,
    ownerId: string
  ): Promise<MeetingMinutesVersionRecord | null> {
    const db = await this.getDb();
    const row = await db.get<VersionRow>(
      `SELECT * FROM meeting_minutes_versions
       WHERE version_id = ? AND owner_id = ? AND status = 'ready'`,
      versionId,
      ownerId
    );
    return row ? this.attachArtifacts(row) : null;
  }

  async listActiveSessionIds(input: {
    provider: string;
    model: string;
    providerChangedAfter: string;
  }): Promise<string[]> {
    const db = await this.getDb();
    const rows = await db.all<Array<{ session_id: string }>>(
      `SELECT DISTINCT session_id FROM meeting_minutes_jobs
       WHERE status IN ('pending', 'running')
          OR (
            status = 'failed'
            AND (
              (provider = ? AND model = ? AND attempt_count < max_attempts)
              OR (
                (provider != ? OR model != ?)
                AND COALESCE(error_code, '') != 'MEETING_MINUTES_PROVIDER_MIGRATION_EXPIRED'
                AND (
                  COALESCE(error_code, '') != 'MEETING_MINUTES_PROVIDER_CHANGED'
                  OR updated_at > ?
                )
              )
            )
          )`,
      input.provider,
      input.model,
      input.provider,
      input.model,
      input.providerChangedAfter
    );
    return rows.map((row) => row.session_id);
  }

  async claimNext(input: {
    workerId: string;
    now: string;
    leaseExpiresAt: string;
  }): Promise<MeetingMinutesJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      `UPDATE meeting_minutes_jobs
       SET status = 'running', phase = 'generating', attempt_count = attempt_count + 1,
           error_code = NULL, error_message = NULL, started_at = ?, updated_at = ?,
           completed_at = NULL, worker_id = ?, lease_expires_at = ?
       WHERE job_id = (
         SELECT candidate.job_id FROM meeting_minutes_jobs AS candidate
         WHERE candidate.status = 'pending' AND candidate.attempt_count < candidate.max_attempts
           AND NOT EXISTS (
             SELECT 1 FROM meeting_minutes_jobs AS running
             WHERE running.session_id = candidate.session_id AND running.status = 'running'
           )
         ORDER BY candidate.created_at ASC, candidate.job_id ASC LIMIT 1
       ) AND status = 'pending'
       RETURNING *`,
      input.now,
      input.now,
      input.workerId,
      input.leaseExpiresAt
    );
    return row ? this.attachVersion(mapJob(row)) : null;
  }

  async updatePhase(input: {
    jobId: string;
    workerId: string;
    phase: MeetingMinutesJobPhase;
    now: string;
    leaseExpiresAt: string;
  }): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.run(
      `UPDATE meeting_minutes_jobs SET phase = ?, updated_at = ?, lease_expires_at = ?
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
      `UPDATE meeting_minutes_jobs SET updated_at = ?, lease_expires_at = ?
       WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
      input.now,
      input.leaseExpiresAt,
      input.jobId,
      input.workerId
    );
    return result.changes === 1;
  }

  async reserveVersion(input: {
    versionId: string;
    jobId: string;
    workerId: string;
    record: MeetingRecord;
    now: string;
  }): Promise<MeetingMinutesVersionRecord> {
    const db = await this.getDb();
    await db.exec("BEGIN IMMEDIATE");
    try {
      const job = await db.get<JobRow>(
        `SELECT * FROM meeting_minutes_jobs
         WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
        input.jobId,
        input.workerId
      );
      if (!job) throw new Error("meeting minutes job lease lost before version reservation");
      let version = await db.get<VersionRow>(
        "SELECT * FROM meeting_minutes_versions WHERE job_id = ?",
        input.jobId
      );
      if (!version) {
        const next = await db.get<{ next_version: number }>(
          `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
           FROM meeting_minutes_versions WHERE session_id = ?`,
          job.session_id
        );
        await db.run(
          `INSERT INTO meeting_minutes_versions (
             version_id, job_id, session_id, owner_id, version_number, status,
             record_json, generated_at
           ) VALUES (?, ?, ?, ?, ?, 'building', ?, ?)`,
          input.versionId,
          input.jobId,
          job.session_id,
          job.owner_id,
          next?.next_version ?? 1,
          JSON.stringify(input.record),
          input.now
        );
        version = await db.get<VersionRow>(
          "SELECT * FROM meeting_minutes_versions WHERE job_id = ?",
          input.jobId
        );
      } else {
        await db.run(
          `UPDATE meeting_minutes_versions SET record_json = ?, generated_at = ?
           WHERE job_id = ? AND status = 'building'`,
          JSON.stringify(input.record),
          input.now,
          input.jobId
        );
        version = await db.get<VersionRow>(
          "SELECT * FROM meeting_minutes_versions WHERE job_id = ?",
          input.jobId
        );
      }
      if (!version || version.status !== "building") {
        throw new Error("meeting minutes version reservation failed");
      }
      await db.exec("COMMIT");
      return this.attachArtifacts(version);
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }

  async markReady(input: {
    jobId: string;
    workerId: string;
    versionId: string;
    packageRelativePath: string;
    artifacts: MeetingMinutesArtifactRecord[];
    now: string;
  }): Promise<MeetingMinutesJobRecord> {
    const db = await this.getDb();
    await db.exec("BEGIN IMMEDIATE");
    try {
      const version = await db.get<VersionRow>(
        `SELECT * FROM meeting_minutes_versions
         WHERE version_id = ? AND job_id = ? AND status = 'building'`,
        input.versionId,
        input.jobId
      );
      if (!version) throw new Error("meeting minutes building version not found");
      for (const artifact of input.artifacts) {
        if (
          artifact.versionId !== input.versionId ||
          artifact.jobId !== input.jobId ||
          artifact.sessionId !== version.session_id
        ) {
          throw new Error("meeting minutes artifact ownership mismatch");
        }
        await db.run(
          `INSERT INTO meeting_minutes_artifacts (
             artifact_id, version_id, job_id, session_id, artifact_type, filename,
             mime_type, relative_path, size_bytes, sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(version_id, artifact_type) DO UPDATE SET
             artifact_id = excluded.artifact_id, filename = excluded.filename,
             mime_type = excluded.mime_type, relative_path = excluded.relative_path,
             size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
             created_at = excluded.created_at`,
          artifact.artifactId,
          artifact.versionId,
          artifact.jobId,
          artifact.sessionId,
          artifact.type,
          artifact.filename,
          artifact.mimeType,
          artifact.relativePath,
          artifact.sizeBytes,
          artifact.sha256,
          artifact.createdAt
        );
      }
      const versionResult = await db.run(
        `UPDATE meeting_minutes_versions
         SET status = 'ready', package_relative_path = ?, generated_at = ?
         WHERE version_id = ? AND status = 'building'`,
        input.packageRelativePath,
        input.now,
        input.versionId
      );
      const jobResult = await db.run(
        `UPDATE meeting_minutes_jobs
         SET status = 'ready', phase = 'ready', error_code = NULL, error_message = NULL,
             updated_at = ?, completed_at = ?, worker_id = NULL, lease_expires_at = NULL
         WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
        input.now,
        input.now,
        input.jobId,
        input.workerId
      );
      if (versionResult.changes !== 1 || jobResult.changes !== 1) {
        throw new Error("meeting minutes ready transition failed");
      }
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
    const job = await this.getJob(input.jobId);
    if (!job) throw new Error("meeting minutes job disappeared after ready transition");
    return job;
  }

  async markFailed(input: {
    jobId: string;
    workerId: string;
    errorCode: string;
    errorMessage: string;
    retryable?: boolean;
    now: string;
  }): Promise<MeetingMinutesJobRecord> {
    const db = await this.getDb();
    const result = await db.run(
      `UPDATE meeting_minutes_jobs
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?,
           completed_at = ?, worker_id = NULL, lease_expires_at = NULL,
           attempt_count = CASE WHEN ? THEN attempt_count ELSE max_attempts END
       WHERE job_id = ? AND status = 'running' AND worker_id = ?`,
      input.errorCode,
      input.errorMessage,
      input.now,
      input.now,
      input.retryable !== false ? 1 : 0,
      input.jobId,
      input.workerId
    );
    if (result.changes !== 1) throw new Error("meeting minutes failed transition failed");
    const job = await this.getJob(input.jobId);
    if (!job) throw new Error("meeting minutes job disappeared after failed transition");
    return job;
  }

  async retry(input: {
    jobId: string;
    ownerId: string;
    provider: string;
    model: string;
    now: string;
    providerChangedAfter: string;
    force?: boolean;
  }): Promise<MeetingMinutesJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      `UPDATE meeting_minutes_jobs
       SET provider = ?, model = ?, status = 'pending', phase = 'queued',
           attempt_count = CASE WHEN ? OR provider != ? OR model != ? THEN 0 ELSE attempt_count END,
           error_code = NULL, error_message = NULL,
           started_at = NULL, updated_at = ?, completed_at = NULL,
           worker_id = NULL, lease_expires_at = NULL
       WHERE job_id = ? AND owner_id = ? AND status = 'failed'
         AND (? OR attempt_count < max_attempts OR (
           (provider != ? OR model != ?) AND updated_at > ?
           AND error_code != 'MEETING_MINUTES_PROVIDER_MIGRATION_EXPIRED'
         ))
       RETURNING *`,
      input.provider,
      input.model,
      input.force ? 1 : 0,
      input.provider,
      input.model,
      input.now,
      input.jobId,
      input.ownerId,
      input.force ? 1 : 0,
      input.provider,
      input.model,
      input.providerChangedAfter
    );
    return row ? this.attachVersion(mapJob(row)) : null;
  }

  async cancelPendingForSession(sessionId: string, now: string): Promise<boolean> {
    const result = await (await this.getDb()).run(`UPDATE meeting_minutes_jobs
      SET status='failed', attempt_count=max_attempts, error_code='MEETING_CANCELLED',
        error_message=NULL, updated_at=?, completed_at=?, worker_id=NULL, lease_expires_at=NULL
      WHERE session_id=? AND status='pending'`, now, now, sessionId);
    return (result.changes ?? 0) > 0;
  }

  async requeueClaimed(input: {
    jobId: string;
    workerId: string;
    now: string;
  }): Promise<MeetingMinutesJobRecord | null> {
    const db = await this.getDb();
    const row = await db.get<JobRow>(
      `UPDATE meeting_minutes_jobs
       SET status = 'pending', phase = 'queued', attempt_count = MAX(0, attempt_count - 1),
           error_code = 'WORKER_SHUTDOWN', error_message = '會議紀錄 worker 關閉，任務已重新排隊',
           started_at = NULL, updated_at = ?, completed_at = NULL,
           worker_id = NULL, lease_expires_at = NULL
       WHERE job_id = ? AND status = 'running' AND worker_id = ? RETURNING *`,
      input.now,
      input.jobId,
      input.workerId
    );
    return row ? this.attachVersion(mapJob(row)) : null;
  }

  async requeueRetryableFailed(now: string, retryBefore: string): Promise<string[]> {
    const db = await this.getDb();
    const retryablePlaceholders = MEETING_MINUTES_AUTO_RETRY_ERROR_CODES
      .map(() => "?")
      .join(", ");
    const rows = await db.all<Array<{ job_id: string }>>(
      `UPDATE meeting_minutes_jobs
       SET status = 'pending', phase = 'queued', error_code = NULL, error_message = NULL,
           started_at = NULL, updated_at = ?, completed_at = NULL,
           worker_id = NULL, lease_expires_at = NULL
       WHERE status = 'failed' AND attempt_count < max_attempts AND updated_at <= ?
         AND error_code IN (${retryablePlaceholders})
       RETURNING job_id`,
      now,
      retryBefore,
      ...MEETING_MINUTES_AUTO_RETRY_ERROR_CODES
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
      `UPDATE meeting_minutes_jobs
       SET attempt_count = max_attempts,
           error_code = 'MEETING_MINUTES_PROVIDER_MIGRATION_EXPIRED',
           error_message = '會議紀錄 provider 升級重送期限已過，來源產物可能已由容量清理回收。',
           updated_at = ?, completed_at = ?
       WHERE status = 'failed'
         AND (provider != ? OR model != ?)
         AND updated_at <= ?
         AND error_code = 'MEETING_MINUTES_PROVIDER_CHANGED'
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
      `UPDATE meeting_minutes_jobs
       SET error_code = 'MEETING_MINUTES_PROVIDER_CHANGED',
           error_message = '會議紀錄 provider 或 model 已變更，請從任務畫面重新產生。',
           updated_at = ?, completed_at = ?
       WHERE status = 'failed'
         AND (provider != ? OR model != ?)
         AND COALESCE(error_code, '') NOT IN (
           'MEETING_MINUTES_PROVIDER_CHANGED',
           'MEETING_MINUTES_PROVIDER_MIGRATION_EXPIRED'
         )
       RETURNING job_id`,
      input.now,
      input.now,
      input.provider,
      input.model
    );
    return rows.map((row) => row.job_id);
  }

  async recoverExpiredRunning(now: string): Promise<{ requeued: number; exhausted: number }> {
    const db = await this.getDb();
    const requeued = await db.run(
      `UPDATE meeting_minutes_jobs
       SET status = 'pending', phase = 'queued', error_code = 'WORKER_RESTARTED',
           error_message = '會議紀錄 worker 中斷，已重新排隊', started_at = NULL,
           updated_at = ?, completed_at = NULL, worker_id = NULL, lease_expires_at = NULL
       WHERE status = 'running' AND lease_expires_at < ? AND attempt_count < max_attempts`,
      now,
      now
    );
    const exhausted = await db.run(
      `UPDATE meeting_minutes_jobs
       SET status = 'failed', error_code = 'MEETING_MINUTES_ATTEMPTS_EXHAUSTED',
           error_message = '會議紀錄 worker 中斷且已達重試上限', updated_at = ?, completed_at = ?,
           worker_id = NULL, lease_expires_at = NULL
       WHERE status = 'running' AND lease_expires_at < ? AND attempt_count >= max_attempts`,
      now,
      now,
      now
    );
    return { requeued: requeued.changes ?? 0, exhausted: exhausted.changes ?? 0 };
  }

  async deleteTerminalJobsByTranscriptionJobIds(
    transcriptionJobIds: string[]
  ): Promise<string[]> {
    if (transcriptionJobIds.length === 0) return [];
    const db = await this.getDb();
    const deleted: string[] = [];
    await db.exec("BEGIN IMMEDIATE");
    try {
      for (const transcriptionJobId of transcriptionJobIds) {
        const rows = await db.all<Array<{ job_id: string }>>(
          `DELETE FROM meeting_minutes_jobs
           WHERE transcription_job_id = ? AND status IN ('ready', 'failed')
           RETURNING job_id`,
          transcriptionJobId
        );
        deleted.push(...rows.map((row) => row.job_id));
      }
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
    return deleted;
  }

  private async attachVersion(
    job: Omit<MeetingMinutesJobRecord, "version">
  ): Promise<MeetingMinutesJobRecord> {
    const db = await this.getDb();
    const row = await db.get<VersionRow>(
      "SELECT * FROM meeting_minutes_versions WHERE job_id = ?",
      job.jobId
    );
    return { ...job, version: row ? await this.attachArtifacts(row) : null };
  }

  private async attachArtifacts(row: VersionRow): Promise<MeetingMinutesVersionRecord> {
    const db = await this.getDb();
    const artifacts = await db.all<ArtifactRow[]>(
      `SELECT * FROM meeting_minutes_artifacts
       WHERE version_id = ? ORDER BY artifact_type ASC`,
      row.version_id
    );
    return {
      versionId: row.version_id,
      jobId: row.job_id,
      sessionId: row.session_id,
      ownerId: row.owner_id,
      versionNumber: row.version_number,
      record: validateMeetingRecord(parseJson(row.record_json, "record")),
      packageRelativePath: row.package_relative_path,
      generatedAt: row.generated_at,
      artifacts: artifacts.map(mapArtifact),
    };
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
    if (filename !== ":memory:") await fs.mkdir(path.dirname(filename), { recursive: true });
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(
      [
        "PRAGMA busy_timeout=5000;",
        "PRAGMA journal_mode=WAL;",
        "PRAGMA synchronous=NORMAL;",
        "PRAGMA foreign_keys=ON;",
        `CREATE TABLE IF NOT EXISTS meeting_minutes_jobs (
          job_id TEXT PRIMARY KEY,
          transcription_job_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          client_request_key TEXT NOT NULL,
          input_sha256 TEXT NOT NULL,
          input_json TEXT NOT NULL,
          revision_base_version_id TEXT,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'failed')),
          phase TEXT NOT NULL CHECK (phase IN ('queued', 'generating', 'packaging', 'ready')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          worker_id TEXT,
          lease_expires_at TEXT,
          UNIQUE (session_id, owner_id, client_request_key)
        );`,
        `CREATE TABLE IF NOT EXISTS meeting_minutes_versions (
          version_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          version_number INTEGER NOT NULL CHECK (version_number > 0),
          status TEXT NOT NULL CHECK (status IN ('building', 'ready')),
          record_json TEXT NOT NULL,
          package_relative_path TEXT,
          generated_at TEXT NOT NULL,
          UNIQUE (session_id, version_number),
          FOREIGN KEY (job_id) REFERENCES meeting_minutes_jobs(job_id) ON DELETE CASCADE
        );`,
        `CREATE TABLE IF NOT EXISTS meeting_minutes_artifacts (
          artifact_id TEXT PRIMARY KEY,
          version_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          artifact_type TEXT NOT NULL CHECK (artifact_type IN (
            'minutes-html', 'minutes-record-json', 'minutes-source-transcript-json',
            'minutes-source-transcript-text', 'minutes-audio'
          )),
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (version_id, artifact_type),
          FOREIGN KEY (version_id) REFERENCES meeting_minutes_versions(version_id) ON DELETE CASCADE
        );`,
        `CREATE INDEX IF NOT EXISTS idx_meeting_minutes_claim
         ON meeting_minutes_jobs(status, created_at, job_id);`,
        `CREATE INDEX IF NOT EXISTS idx_meeting_minutes_owner
         ON meeting_minutes_jobs(owner_id, session_id, created_at DESC);`,
        `CREATE INDEX IF NOT EXISTS idx_meeting_minutes_lease
         ON meeting_minutes_jobs(status, lease_expires_at);`,
      ].join("\n")
    );
    await db.exec("BEGIN IMMEDIATE");
    try {
      const columns = await db.all<Array<{ name: string }>>("PRAGMA table_info(meeting_minutes_jobs)");
      if (!columns.some(column => column.name === "revision_base_version_id")) {
        await db.exec("ALTER TABLE meeting_minutes_jobs ADD COLUMN revision_base_version_id TEXT");
      }
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK").catch(() => undefined);
      await db.close().catch(() => undefined);
      throw error;
    }
    return db;
  }
}

export const meetingMinutesJobRepository = new MeetingMinutesJobRepository();
