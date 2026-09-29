import { notifyMeetingStateChanged } from "../../events/meetingStateEvents";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";
import { LIVE_TRANSCRIPTION_SCHEMA } from "./meetingLiveTranscriptionRepository";

export interface MeetingOneShotSession {
  sessionId: string;
  ownerId: string;
  title: string;
  additionalSectionRequest: string;
  createdAt: string;
  expiresAt: string | null;
  cleanupStartedAt: string | null;
  cleanedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  recorderId: string;
  recorderLeaseUntil: string | null;
  recordingFinalizedAt: string | null;
  pipelineReleasedAt: string | null;
  deviceSessionReleasedAt: string | null;
  cancelRequestedAt: string | null;
  cancelledAt: string | null;
  cleanupAfter: string | null;
  sourceName: string | null;
  sourceUserAgent: string | null;
  sourceIp: string | null;
  adoptedVersionId: string | null;
  revisionJobId: string | null;
}

const columns = `session_id AS sessionId, owner_id AS ownerId, title, additional_section_request AS additionalSectionRequest, created_at AS createdAt,
  expires_at AS expiresAt, cleanup_started_at AS cleanupStartedAt, cleaned_at AS cleanedAt,
  error_code AS errorCode, error_message AS errorMessage, recorder_id AS recorderId,
  recorder_lease_until AS recorderLeaseUntil, recording_finalized_at AS recordingFinalizedAt,
  pipeline_released_at AS pipelineReleasedAt, device_session_released_at AS deviceSessionReleasedAt,
  cancel_requested_at AS cancelRequestedAt, cancelled_at AS cancelledAt, cleanup_after AS cleanupAfter,
  source_name AS sourceName, source_user_agent AS sourceUserAgent, source_ip AS sourceIp,
  adopted_version_id AS adoptedVersionId, revision_job_id AS revisionJobId`;

export type MeetingRecordingDeviceStatus = "active" | "retiring" | "revoked";

export interface MeetingRecordingDevice {
  ownerId: string;
  slotNumber: number;
  displayName: string;
  status: MeetingRecordingDeviceStatus;
  registeredAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  lastUserAgent: string | null;
  lastIp: string | null;
  currentSessionId: string | null;
  currentSessionTitle: string | null;
  currentSessionCreatedAt: string | null;
  currentSessionPipelineReleasedAt: string | null;
}

export interface MeetingDeviceRequestMetadata {
  userAgent?: string | null;
  ip?: string | null;
}

export interface MeetingSessionRegistrationResult {
  created: boolean;
  session: MeetingOneShotSession;
}

const deviceColumns = `d.owner_id AS ownerId, d.slot_number AS slotNumber, d.display_name AS displayName,
  d.status, d.registered_at AS registeredAt, d.last_seen_at AS lastSeenAt, d.revoked_at AS revokedAt,
  d.last_user_agent AS lastUserAgent, d.last_ip AS lastIp,
  s.session_id AS currentSessionId, s.title AS currentSessionTitle, s.created_at AS currentSessionCreatedAt,
  s.pipeline_released_at AS currentSessionPipelineReleasedAt`;

export class MeetingOneShotRepository {
  private dbPromise: Promise<Database> | null = null;
  private mutationChain: Promise<void> = Promise.resolve();
  constructor(private readonly dbFile = env.MEETING_PROCESSING_DB_FILE) {}

  async heartbeatWorker(workerId: string, profile: string, now: string, expiresAt: string): Promise<void> {
    await this.runImmediate(async db => {
      await db.run("DELETE FROM meeting_worker_health WHERE expires_at<=?", now);
      await db.run(`INSERT INTO meeting_worker_health(worker_id,profile,expires_at) VALUES(?,?,?)
        ON CONFLICT(worker_id) DO UPDATE SET profile=excluded.profile,expires_at=excluded.expires_at`, workerId,profile,expiresAt);
    });
  }

  async workerReady(profile: string, now: string): Promise<boolean> {
    return Boolean(await (await this.readDb()).get("SELECT 1 FROM meeting_worker_health WHERE profile=? AND expires_at>? LIMIT 1", profile,now));
  }

  async releaseWorker(workerId: string): Promise<void> {
    await this.runImmediate(db => db.run("DELETE FROM meeting_worker_health WHERE worker_id=?", workerId));
  }

  async register(input: { sessionId: string; ownerId: string; title: string; createdAt: string; additionalSectionRequest?: string; recorderId?: string }): Promise<void> {
    await this.runImmediate(async db => {
      await db.run(`INSERT INTO meeting_one_shot_sessions
        (session_id, owner_id, title, created_at, next_check_at, additional_section_request, recorder_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, input.sessionId, input.ownerId, input.title, input.createdAt,
        input.createdAt, input.additionalSectionRequest ?? "", input.recorderId ?? "legacy");
    }, true);
  }

  async registerForOwner(input: {
    sessionId: string;
    ownerId: string;
    title: string;
    createdAt: string;
    additionalSectionRequest?: string;
    recorderId: string;
    recorderLeaseUntil?: string;
    maxPipelines: number;
    metadata?: MeetingDeviceRequestMetadata;
  }): Promise<MeetingSessionRegistrationResult> {
    return this.runImmediate(async db => {
      const current = await db.get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions
        WHERE owner_id=? AND device_session_released_at IS NULL AND cleaned_at IS NULL
        ORDER BY created_at DESC, session_id DESC LIMIT 1`, input.ownerId);
      if (current) {
        if (current.cancelRequestedAt) {
          throw new HttpError(409, "這場會議正在取消，請等待背景工作停止。", "MEETING_CANCEL_IN_PROGRESS");
        }
        return { created: false, session: current };
      }
      const pipelineCount = await this.countOccupyingSessionsLocked(db, input.createdAt);
      if (pipelineCount >= input.maxPipelines) {
        throw new HttpError(409, `目前已有 ${input.maxPipelines} 場會議進行中，請待其中一場完成後再開始錄音。`, "MEETING_PIPELINE_CAPACITY_FULL");
      }
      const source = await this.recordSourceLocked(db, input.ownerId, input.createdAt, input.metadata);
      await db.run(`INSERT INTO meeting_one_shot_sessions
        (session_id, owner_id, title, created_at, next_check_at, additional_section_request, recorder_id,
          recorder_lease_until, source_name, source_user_agent, source_ip)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.sessionId, input.ownerId, input.title, input.createdAt,
        input.createdAt, input.additionalSectionRequest ?? "", input.recorderId,
        input.recorderLeaseUntil ?? new Date(Date.parse(input.createdAt) + env.MEETING_RECORDER_LEASE_MS).toISOString(),
        source.displayName, source.lastUserAgent, source.lastIp);
      return {
        created: true,
        session: (await db.get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions WHERE session_id=?`, input.sessionId))!,
      };
    }, true);
  }

  async get(sessionId: string): Promise<MeetingOneShotSession | null> {
    return (await (await this.readDb()).get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions WHERE session_id = ?`, sessionId)) ?? null;
  }

  async currentForOwner(ownerId: string): Promise<MeetingOneShotSession | null> {
    return (await (await this.readDb()).get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions
      WHERE owner_id=? AND device_session_released_at IS NULL AND cleaned_at IS NULL
      ORDER BY created_at DESC, session_id DESC LIMIT 1`, ownerId)) ?? null;
  }

  async currentForOwnerContext(ownerId: string, now: string, recorderId: string | null,
    metadata?: MeetingDeviceRequestMetadata): Promise<{ source: MeetingRecordingDevice | null; session: MeetingOneShotSession } | null> {
    return this.runImmediate(async db => {
      const session = await db.get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions
        WHERE owner_id=? AND device_session_released_at IS NULL AND cleaned_at IS NULL
        ORDER BY created_at DESC, session_id DESC LIMIT 1`, ownerId) ?? null;
      if (!session) return null;
      const source = await this.recordSourceLocked(db, ownerId, now, metadata);
      if (recorderId) {
        await db.run("UPDATE meeting_one_shot_sessions SET recorder_id=? WHERE session_id=? AND owner_id=? AND recorder_id='legacy'",
          recorderId, session.sessionId, ownerId);
      }
      return {
        source,
        session: (await db.get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions WHERE session_id=?`, session.sessionId))!,
      };
    });
  }

  async listActivePipelines(): Promise<MeetingOneShotSession[]> {
    return (await this.readDb()).all<MeetingOneShotSession[]>(`SELECT ${columns}
      FROM meeting_one_shot_sessions
      WHERE pipeline_released_at IS NULL AND cleaned_at IS NULL
      ORDER BY created_at, session_id`);
  }

  async listManagedSessions(limit = 100): Promise<MeetingOneShotSession[]> {
    return (await this.readDb()).all<MeetingOneShotSession[]>(`SELECT ${columns}
      FROM meeting_one_shot_sessions
      WHERE cleaned_at IS NULL
      ORDER BY CASE WHEN pipeline_released_at IS NULL THEN 0 ELSE 1 END, created_at DESC, session_id DESC
      LIMIT ?`, limit);
  }

  async listPendingCancellations(): Promise<string[]> {
    const rows = await (await this.readDb()).all<Array<{ sessionId: string }>>(`SELECT session_id AS sessionId
      FROM meeting_one_shot_sessions
      WHERE cancel_requested_at IS NOT NULL AND cancelled_at IS NULL AND pipeline_released_at IS NULL
      ORDER BY cancel_requested_at, session_id`);
    return rows.map(row => row.sessionId);
  }

  async admissionStats(maxMeetings: number, now = new Date().toISOString()): Promise<{
    activeMeetings: number;
    maxMeetings: number;
  }> {
    const db = await this.readDb();
    return {
      activeMeetings: await this.countOccupyingSessionsLocked(db, now),
      maxMeetings,
    };
  }

  async listOccupyingSessionIds(now = new Date().toISOString()): Promise<Set<string>> {
    const db = await this.readDb();
    return new Set((await this.occupyingSessionIdsLocked(db, now)).map(row => row.sessionId));
  }

  async executionSessionIds(now: string): Promise<{ live: Set<string>; finalizing: Set<string> }> {
    const db = await this.readDb();
    const live = await db.all<Array<{ sessionId: string }>>(`SELECT session_id AS sessionId FROM meeting_live_chunks
      WHERE (status='pending' AND attempts<3) OR status='running'
      UNION SELECT session_id AS sessionId FROM meeting_live_decoder_leases WHERE lease_until > ?`, Date.parse(now));
    const finalizing = await db.all<Array<{ sessionId: string }>>("SELECT DISTINCT session_id AS sessionId FROM meeting_recording_operation_leases WHERE expires_at > ?", now);
    return { live: new Set(live.map(entry => entry.sessionId)), finalizing: new Set(finalizing.map(entry => entry.sessionId)) };
  }

  async renewRecorderLease(input: {
    sessionId: string;
    ownerId: string;
    recorderId: string;
    now: string;
    leaseUntil: string;
    maxPipelines: number;
  }): Promise<boolean> {
    const reactivated = await this.runImmediate(async db => {
      const session = await db.get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions
        WHERE session_id=? AND owner_id=?`, input.sessionId, input.ownerId);
      if (!session) throw new HttpError(404, "找不到錄音 session。", "MEETING_RECORDING_NOT_FOUND");
      if (session.cancelRequestedAt) {
        throw new HttpError(409, "這場會議正在取消，不能繼續錄音。", "MEETING_CANCEL_IN_PROGRESS");
      }
      if (session.deviceSessionReleasedAt || session.pipelineReleasedAt || session.recordingFinalizedAt) {
        throw new HttpError(409, "這場會議已停止錄音。", "MEETING_RECORDING_NOT_ACTIVE");
      }
      if (!input.recorderId || session.recorderId !== input.recorderId) {
        throw new HttpError(409, "這場會議正在另一個分頁錄音，這個分頁只能查看進度。", "MEETING_RECORDER_LEASE_NOT_OWNER");
      }
      const leaseActive = Boolean(session.recorderLeaseUntil && session.recorderLeaseUntil > input.now);
      if (!leaseActive) {
        const activeCount = await this.countOccupyingSessionsLocked(db, input.now, input.sessionId);
        if (activeCount >= input.maxPipelines) {
          throw new HttpError(409, `目前已有 ${input.maxPipelines} 場會議進行中，請待其中一場完成後再恢復錄音。`, "MEETING_PIPELINE_CAPACITY_FULL");
        }
      }
      await db.run(`UPDATE meeting_one_shot_sessions SET recorder_lease_until=?
        WHERE session_id=? AND owner_id=?`, input.leaseUntil, input.sessionId, input.ownerId);
      return !leaseActive;
    });
    if (reactivated) notifyMeetingStateChanged();
    return reactivated;
  }

  async expireRecorderLeases(now: string): Promise<void> {
    const changed = await this.runImmediate(async db => (await db.run(`UPDATE meeting_one_shot_sessions
      SET recorder_lease_until=NULL WHERE recorder_lease_until <= ? AND pipeline_released_at IS NULL`, now)).changes);
    if (changed) notifyMeetingStateChanged();
  }

  async markRecordingFinalized(sessionId: string, ownerId: string, now: string,
    maxMeetings = env.MEETING_ONE_SHOT_MAX_ACTIVE_PIPELINES): Promise<void> {
    await this.runImmediate(async db => {
      const session = await db.get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions
        WHERE session_id=? AND owner_id=? AND cleaned_at IS NULL`, sessionId, ownerId);
      if (!session) throw new HttpError(404, "找不到錄音 session。", "MEETING_RECORDING_NOT_FOUND");
      if (!session.recordingFinalizedAt && !session.pipelineReleasedAt &&
        !(await this.occupyingSessionIdsLocked(db, now)).some(entry => entry.sessionId === sessionId)) {
        const activeCount = await this.countOccupyingSessionsLocked(db, now, sessionId);
        if (activeCount >= maxMeetings) {
          throw new HttpError(409, `目前已有 ${maxMeetings} 場會議進行中，請待其中一場完成後再完成錄音收尾。`, "MEETING_PIPELINE_CAPACITY_FULL");
        }
      }
      const result = await db.run(`UPDATE meeting_one_shot_sessions SET
        recording_finalized_at=COALESCE(recording_finalized_at, ?), recorder_lease_until=NULL
        WHERE session_id=? AND owner_id=? AND cleaned_at IS NULL`, now, sessionId, ownerId);
      if (result.changes !== 1) {
        throw new HttpError(404, "找不到錄音 session。", "MEETING_RECORDING_NOT_FOUND");
      }
    }, true);
  }

  async acquireFinalizationLease(sessionId: string, ownerId: string, recorderId: string,
    now: string, expiresAt: string, maxMeetings: number): Promise<string> {
    const leaseId = randomUUID();
    await this.runImmediate(async db => {
      const session = await db.get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions
        WHERE session_id=? AND owner_id=?`, sessionId, ownerId);
      if (!session) throw new HttpError(404, "找不到錄音 session。", "MEETING_RECORDING_NOT_FOUND");
      if (session.cancelRequestedAt) throw new HttpError(409, "這場會議正在取消，不能完成錄音收尾。", "MEETING_CANCEL_IN_PROGRESS");
      if (session.deviceSessionReleasedAt || session.pipelineReleasedAt) {
        throw new HttpError(409, "這場會議已停止錄音。", "MEETING_RECORDING_NOT_ACTIVE");
      }
      if (session.recorderId !== recorderId) {
        throw new HttpError(409, "這場會議正在另一個分頁錄音，這個分頁只能查看進度。", "MEETING_RECORDER_LEASE_NOT_OWNER");
      }
      const occupying = await this.occupyingSessionIdsLocked(db, now);
      if (!occupying.some(entry => entry.sessionId === sessionId) && occupying.length >= maxMeetings) {
        throw new HttpError(409, `目前已有 ${maxMeetings} 場會議進行中，請待其中一場完成後再完成錄音收尾。`, "MEETING_PIPELINE_CAPACITY_FULL");
      }
      await db.run("INSERT INTO meeting_recording_operation_leases (lease_id, session_id, expires_at) VALUES (?, ?, ?)",
        leaseId, sessionId, expiresAt);
    }, true);
    return leaseId;
  }

  async renewFinalizationLease(leaseId: string, expiresAt: string, now = new Date().toISOString()): Promise<void> {
    await this.runImmediate(async db => {
      const result = await db.run("UPDATE meeting_recording_operation_leases SET expires_at=? WHERE lease_id=? AND expires_at > ?", expiresAt, leaseId, now);
      if (result.changes !== 1) throw new HttpError(409, "錄音收尾租約已到期。", "MEETING_FINALIZATION_LEASE_EXPIRED");
    });
  }

  async releaseFinalizationLease(leaseId: string): Promise<void> {
    await this.runImmediate(async db => {
      await db.run("DELETE FROM meeting_recording_operation_leases WHERE lease_id=?", leaseId);
    }, true);
  }

  async releaseCurrent(sessionId: string, ownerId: string, now: string, releasePipeline = false): Promise<void> {
    await this.runImmediate(async db => {
      if (await db.get(`SELECT 1 FROM meeting_one_shot_sessions WHERE session_id=? AND owner_id=?
        AND revision_job_id IS NOT NULL AND expires_at>?`, sessionId, ownerId, now)) {
        throw new HttpError(409, "請先採用或放棄修訂，再開始下一場。", "MEETING_REVISION_PENDING");
      }
      if (releasePipeline && (await this.occupyingSessionIdsLocked(db, now)).some(session => session.sessionId === sessionId)) {
        throw new HttpError(409, "會議仍在錄音或處理中，尚不能開始下一場。", "MEETING_ONE_SHOT_STILL_ACTIVE");
      }
      const result = await db.run(`UPDATE meeting_one_shot_sessions SET
        device_session_released_at=COALESCE(device_session_released_at, ?),
        pipeline_released_at=CASE WHEN ? THEN COALESCE(pipeline_released_at, ?) ELSE pipeline_released_at END
        WHERE session_id=? AND owner_id=?`, now, releasePipeline ? 1 : 0, now, sessionId, ownerId);
      if (result.changes !== 1) throw new HttpError(404, "找不到目前的會議。", "MEETING_ONE_SHOT_NOT_FOUND");
    }, true);
  }

  async requestCancellation(sessionId: string, now: string): Promise<MeetingOneShotSession> {
    await this.runImmediate(async db => {
      const result = await db.run(`UPDATE meeting_one_shot_sessions
        SET cancel_requested_at=COALESCE(cancel_requested_at, ?), next_check_at=?
        WHERE session_id=? AND cleaned_at IS NULL AND pipeline_released_at IS NULL`, now, now, sessionId);
      if (result.changes !== 1) {
        const existing = await db.get("SELECT 1 FROM meeting_one_shot_sessions WHERE session_id=?", sessionId);
        if (!existing) throw new HttpError(404, "找不到會議。", "MEETING_ONE_SHOT_NOT_FOUND");
        throw new HttpError(409, "這場會議已經結束，不需要取消。", "MEETING_CANCEL_INVALID");
      }
    }, true);
    return (await this.get(sessionId))!;
  }

  async isCancellationRequested(sessionId: string): Promise<boolean> {
    return Boolean(await (await this.readDb()).get(
      "SELECT 1 FROM meeting_one_shot_sessions WHERE session_id=? AND cancel_requested_at IS NOT NULL",
      sessionId));
  }

  async completeCancellationIfIdle(sessionId: string, now: string): Promise<boolean> {
    return this.runImmediate(async db => {
      const session = await db.get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions WHERE session_id=?`, sessionId);
      if (!session?.cancelRequestedAt || session.cancelledAt || session.pipelineReleasedAt) return false;
      if (await this.hasPendingOrRunningJobLocked(db, sessionId)) return false;
      if (await db.get("SELECT 1 FROM meeting_recording_operation_leases WHERE session_id=? AND expires_at > ? LIMIT 1", sessionId, now)) return false;
      const result = await db.run(`UPDATE meeting_one_shot_sessions SET
        pipeline_released_at=COALESCE(pipeline_released_at, ?),
        device_session_released_at=COALESCE(device_session_released_at, ?),
        cancelled_at=COALESCE(cancelled_at, ?), cleanup_after=COALESCE(cleanup_after, ?),
        error_code='MEETING_CANCELLED', error_message=NULL
        WHERE session_id=? AND pipeline_released_at IS NULL`, now, now, now, now, sessionId);
      return result.changes === 1;
    }, true);
  }

  async releaseTerminalFailure(sessionId: string, now: string): Promise<boolean> {
    return this.runImmediate(async db => {
      const result = await db.run(`UPDATE meeting_one_shot_sessions SET
        pipeline_released_at=COALESCE(pipeline_released_at, ?)
        WHERE session_id=? AND pipeline_released_at IS NULL AND cleaned_at IS NULL`, now, sessionId);
      return result.changes === 1;
    }, true);
  }

  async claimRetryAdmission(sessionId: string, ownerId: string, now: string, maxMeetings: number): Promise<void> {
    await this.runImmediate(async db => {
      const session = await db.get<MeetingOneShotSession>(`SELECT ${columns} FROM meeting_one_shot_sessions WHERE session_id=? AND owner_id=?`, sessionId, ownerId);
      if (!session) throw new HttpError(404, "找不到會議。", "MEETING_ONE_SHOT_NOT_FOUND");
      if (!session.pipelineReleasedAt || session.cleanedAt || session.expiresAt || session.cancelledAt) {
        throw new HttpError(409, "這場會議目前不能重試。", "MEETING_RETRY_INVALID");
      }
      const count = await this.countOccupyingSessionsLocked(db, now, sessionId);
      if (count >= maxMeetings) {
        throw new HttpError(409, `目前已有 ${maxMeetings} 場會議進行中，請待其中一場完成後再重試。`, "MEETING_PIPELINE_CAPACITY_FULL");
      }
      await db.run(`UPDATE meeting_one_shot_sessions SET pipeline_released_at=NULL,
        recording_finalized_at=COALESCE(recording_finalized_at, ?),
        cancel_requested_at=NULL, cancelled_at=NULL,
        error_code=NULL, error_message=NULL, next_check_at=? WHERE session_id=?`, now, now, sessionId);
    }, true);
  }

  async releaseRetryAdmissionIfIdle(sessionId: string, now: string): Promise<boolean> {
    return this.runImmediate(async db => {
      if (await this.hasPendingOrRunningJobLocked(db, sessionId)) return false;
      const result = await db.run(`UPDATE meeting_one_shot_sessions
        SET pipeline_released_at=COALESCE(pipeline_released_at, ?)
        WHERE session_id=? AND pipeline_released_at IS NULL`, now, sessionId);
      return result.changes === 1;
    }, true);
  }

  async due(now: string): Promise<MeetingOneShotSession[]> {
    return (await this.readDb()).all(`SELECT ${columns} FROM meeting_one_shot_sessions
      WHERE cleaned_at IS NULL AND expires_at IS NULL AND cleanup_started_at IS NULL
      AND pipeline_released_at IS NULL AND cancel_requested_at IS NULL
      AND next_check_at <= ? ORDER BY next_check_at, session_id LIMIT 50`, now);
  }

  async protectedSessionIds(): Promise<string[]> {
    const rows = await (await this.readDb()).all<Array<{ session_id: string }>>(
      "SELECT session_id FROM meeting_one_shot_sessions WHERE cleaned_at IS NULL");
    return rows.map(row => row.session_id);
  }

  async hasArchiveCapacityFailure(): Promise<boolean> {
    return Boolean(await (await this.readDb()).get("SELECT 1 FROM meeting_one_shot_sessions WHERE error_code = 'MEETING_SUMMARY_ARCHIVE_FULL' LIMIT 1"));
  }

  async checked(sessionId: string, nextCheckAt: string, errorCode: string | null = null, errorMessage: string | null = null): Promise<void> {
    const changed = await this.runImmediate(async db => {
      const previous = await db.get<{ error_code: string | null }>("SELECT error_code FROM meeting_one_shot_sessions WHERE session_id=?", sessionId);
      await db.run(`UPDATE meeting_one_shot_sessions SET next_check_at=?, error_code=?, error_message=? WHERE session_id=?`,
        nextCheckAt, errorCode, errorMessage, sessionId);
      return previous !== undefined && previous.error_code !== errorCode;
    });
    if (changed) notifyMeetingStateChanged();
  }

  async publishDelivery(sessionId: string, releasedAt: string, expiresAt: string, versionId: string | null = null): Promise<boolean> {
    return this.runImmediate(async db => {
      const result = await db.run(`UPDATE meeting_one_shot_sessions SET expires_at=COALESCE(expires_at, ?),
        pipeline_released_at=COALESCE(pipeline_released_at, ?), adopted_version_id=COALESCE(adopted_version_id, ?), error_code=NULL, error_message=NULL
        WHERE session_id=? AND cleanup_started_at IS NULL AND cancel_requested_at IS NULL`, expiresAt, releasedAt, versionId, sessionId);
      return result.changes === 1;
    }, true);
  }

  async discardRevision(sessionId: string, ownerId: string, jobId: string, now: string): Promise<void> {
    await this.runImmediate(async db => {
      const result = await db.run(`UPDATE meeting_one_shot_sessions SET revision_job_id=NULL
        WHERE session_id=? AND owner_id=? AND revision_job_id=? AND expires_at>?
          AND cleanup_started_at IS NULL AND cancel_requested_at IS NULL
          AND EXISTS (SELECT 1 FROM meeting_minutes_jobs WHERE job_id=? AND
            (status='ready' OR (status='failed' AND attempt_count>=max_attempts)))`,
        sessionId, ownerId, jobId, now, jobId);
      if (result.changes !== 1) throw new HttpError(409, "修訂仍在處理、已到期或已由其他分頁更新，請重新讀取。", "MEETING_REVISION_CONFLICT");
    }, true);
  }

  async pinDeliveredVersion(sessionId: string, versionId: string): Promise<void> {
    await this.runImmediate(async db => {
      await db.run(`UPDATE meeting_one_shot_sessions SET adopted_version_id=?
        WHERE session_id=? AND expires_at IS NOT NULL AND adopted_version_id IS NULL
          AND EXISTS (SELECT 1 FROM meeting_minutes_versions version JOIN meeting_summary_archive archive
            ON archive.session_id=version.session_id AND archive.version_number=version.version_number
            WHERE version.version_id=? AND version.session_id=? AND version.status='ready')`,
        versionId, sessionId, versionId, sessionId);
    });
  }

  async acquireAccess(sessionId: string, now: string, leaseUntil: string): Promise<string> {
    const leaseId = randomUUID();
    await this.runImmediate(async db => {
      const result = await db.run(`INSERT INTO meeting_one_shot_access_leases (lease_id, session_id, expires_at)
        SELECT ?, session_id, ? FROM meeting_one_shot_sessions WHERE session_id=? AND cleanup_started_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`, leaseId, leaseUntil, sessionId, now);
      if (result.changes !== 1) throw new HttpError(410, "這筆會議的下載期限已到，暫存檔不再提供。", "MEETING_ONE_SHOT_EXPIRED");
    });
    return leaseId;
  }

  async renewAccess(leaseId: string, expiresAt: string): Promise<void> {
    await this.runImmediate(async db => { await db.run("UPDATE meeting_one_shot_access_leases SET expires_at=? WHERE lease_id=?", expiresAt, leaseId); });
  }

  async releaseAccess(leaseId: string): Promise<void> {
    await this.runImmediate(async db => { await db.run("DELETE FROM meeting_one_shot_access_leases WHERE lease_id=?", leaseId); });
  }

  async expired(now: string): Promise<MeetingOneShotSession[]> {
    return (await this.readDb()).all(`SELECT ${columns} FROM meeting_one_shot_sessions
      WHERE cleaned_at IS NULL AND COALESCE(cleanup_after, expires_at) <= ?
      ORDER BY COALESCE(cleanup_after, expires_at) LIMIT 50`, now);
  }

  async claimCleanup(sessionId: string, now: string): Promise<boolean> {
    return this.runImmediate(async db => {
      const result = await db.run(`UPDATE meeting_one_shot_sessions SET cleanup_started_at=COALESCE(cleanup_started_at, ?)
        WHERE session_id=? AND COALESCE(cleanup_after, expires_at) <= ? AND cleaned_at IS NULL
        AND (cancelled_at IS NOT NULL OR EXISTS (SELECT 1 FROM meeting_summary_archive WHERE session_id=?))
        AND NOT EXISTS (SELECT 1 FROM meeting_one_shot_access_leases WHERE session_id=? AND expires_at > ?)
        AND NOT EXISTS (SELECT 1 FROM meeting_processing_jobs WHERE session_id=? AND status IN ('pending','running'))
        AND NOT EXISTS (SELECT 1 FROM meeting_transcription_jobs WHERE session_id=? AND status IN ('pending','running'))
        AND NOT EXISTS (SELECT 1 FROM meeting_minutes_jobs WHERE session_id=? AND status IN ('pending','running'))`,
        now, sessionId, now, sessionId, sessionId, now, sessionId, sessionId, sessionId);
      return result.changes === 1;
    });
  }

  async finishCleanup(sessionId: string, now: string): Promise<void> {
    await this.runImmediate(async db => {
      await db.run("DELETE FROM meeting_live_chunks WHERE session_id=?",sessionId);
      await db.run("DELETE FROM meeting_live_sources WHERE session_id=?",sessionId);
      // 檔案已清理後再清全文與任務 metadata；crash 時保留 cleaning row 供下次補完。
      for (const table of ["meeting_minutes_jobs", "meeting_transcription_jobs", "meeting_processing_jobs"]) {
        await db.run(`DELETE FROM ${table} WHERE session_id=? AND status NOT IN ('pending','running')`, sessionId);
      }
      await db.run("DELETE FROM meeting_one_shot_access_leases WHERE session_id=?", sessionId);
      await db.run("UPDATE meeting_one_shot_sessions SET cleaned_at=?, additional_section_request='', error_code=NULL, error_message=NULL WHERE session_id=? AND cleanup_started_at IS NOT NULL", now, sessionId);
    }, true);
  }

  async forgetMissing(sessionId: string): Promise<void> {
    await this.runImmediate(async db => {
      await db.run("DELETE FROM meeting_live_chunks WHERE session_id=?",sessionId);
      await db.run("DELETE FROM meeting_live_sources WHERE session_id=?",sessionId);
      await db.run("DELETE FROM meeting_one_shot_sessions WHERE session_id=? AND expires_at IS NULL", sessionId);
    }, true);
  }

  async close(): Promise<void> {
    await this.mutationChain.catch(() => undefined);
    if (this.dbPromise) await (await this.dbPromise).close();
    this.dbPromise = null;
  }

  private getDb(): Promise<Database> {
    this.dbPromise ??= this.openDb().catch(error => { this.dbPromise = null; throw error; });
    return this.dbPromise;
  }

  private async readDb(): Promise<Database> {
    await this.mutationChain.catch(() => undefined);
    return this.getDb();
  }

  private runImmediate<T>(worker: (db: Database) => Promise<T>, notify = false): Promise<T> {
    const run = this.mutationChain.catch(() => undefined).then(async () => {
      const db = await this.getDb();
      await db.exec("BEGIN IMMEDIATE");
      try {
        const result = await worker(db);
        await db.exec("COMMIT");
        if (notify) notifyMeetingStateChanged();
        return result;
      } catch (error) {
        await db.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async deviceLocked(db: Database, ownerId: string): Promise<MeetingRecordingDevice | null> {
    return (await db.get<MeetingRecordingDevice>(`SELECT ${deviceColumns}
      FROM meeting_recording_devices d
      LEFT JOIN meeting_one_shot_sessions s ON s.session_id=(
        SELECT current.session_id FROM meeting_one_shot_sessions current
        WHERE current.owner_id=d.owner_id AND current.device_session_released_at IS NULL AND current.cleaned_at IS NULL
        ORDER BY current.created_at DESC, current.session_id DESC LIMIT 1)
      WHERE d.owner_id=?`, ownerId)) ?? null;
  }

  private async recordSourceLocked(db: Database, ownerId: string, now: string,
    metadata?: MeetingDeviceRequestMetadata): Promise<MeetingRecordingDevice> {
    const existing = await db.get<{ slot_number: number; display_name: string }>(
      "SELECT slot_number, display_name FROM meeting_recording_devices WHERE owner_id=?", ownerId);
    const userAgent = String(metadata?.userAgent ?? "").trim().slice(0, 500) || null;
    const ip = String(metadata?.ip ?? "").trim().slice(0, 100) || null;
    const slot = existing?.slot_number ?? Number((await db.get<{ slot: number }>(
      "SELECT COALESCE(MAX(slot_number), 0) + 1 AS slot FROM meeting_recording_devices"))?.slot ?? 1);
    const displayName = existing?.display_name ?? `會議來源 ${slot}`;
    await db.run(`INSERT INTO meeting_recording_devices
      (owner_id, slot_number, display_name, status, registered_at, last_seen_at, last_user_agent, last_ip)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET status='active', last_seen_at=excluded.last_seen_at,
        revoked_at=NULL, last_user_agent=excluded.last_user_agent, last_ip=excluded.last_ip`,
      ownerId, slot, displayName, now, now, userAgent, ip);
    return (await this.deviceLocked(db, ownerId))!;
  }

  private async hasPendingOrRunningJobLocked(db: Database, sessionId: string): Promise<boolean> {
    for (const table of ["meeting_processing_jobs", "meeting_transcription_jobs", "meeting_minutes_jobs"]) {
      if (!await db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)) continue;
      if (await db.get(`SELECT 1 FROM ${table} WHERE session_id=? AND status IN ('pending','running') LIMIT 1`, sessionId)) return true;
    }
    return false;
  }

  private async occupyingSessionIdsLocked(
    db: Database,
    now: string,
    excludedSessionId?: string
  ): Promise<Array<{ sessionId: string }>> {
    const jobTables: string[] = [];
    for (const table of ["meeting_processing_jobs", "meeting_transcription_jobs", "meeting_minutes_jobs"]) {
      if (await db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)) {
        jobTables.push(table);
      }
    }
    const activeJobs = jobTables.map(table =>
      `EXISTS (SELECT 1 FROM ${table} job WHERE job.session_id=session.session_id AND job.status IN ('pending','running'))`
    );
    const activityPredicates = [
      "session.recorder_lease_until > ?",
      "session.recording_finalized_at IS NOT NULL",
      "session.cancel_requested_at IS NOT NULL",
      "EXISTS (SELECT 1 FROM meeting_recording_operation_leases operation WHERE operation.session_id=session.session_id AND operation.expires_at > ?)",
      "EXISTS (SELECT 1 FROM meeting_live_chunks live WHERE live.session_id=session.session_id AND ((live.status='pending' AND live.attempts<3) OR live.status='running'))",
      "EXISTS (SELECT 1 FROM meeting_live_decoder_leases decoder WHERE decoder.session_id=session.session_id AND decoder.lease_until > ?)",
      ...activeJobs,
    ];
    return db.all<Array<{ sessionId: string }>>(`SELECT session.session_id AS sessionId
      FROM meeting_one_shot_sessions session
      WHERE session.pipeline_released_at IS NULL
        AND session.cleaned_at IS NULL
        ${excludedSessionId ? "AND session.session_id != ?" : ""}
        AND (${activityPredicates.join(" OR ")})`,
      ...(excludedSessionId ? [excludedSessionId] : []),
      now,
      now,
      Date.parse(now)
    );
  }

  private async countOccupyingSessionsLocked(
    db: Database,
    now: string,
    excludedSessionId?: string
  ): Promise<number> {
    return (await this.occupyingSessionIdsLocked(db, now, excludedSessionId)).length;
  }

  private async openDb(): Promise<Database> {
    const filename = this.dbFile === ":memory:" ? this.dbFile : path.resolve(this.dbFile);
    if (filename !== ":memory:") await fs.mkdir(path.dirname(filename), { recursive: true });
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(LIVE_TRANSCRIPTION_SCHEMA);
    await db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meeting_worker_health (
        worker_id TEXT PRIMARY KEY, profile TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meeting_one_shot_sessions (
        session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT, cleanup_started_at TEXT, cleaned_at TEXT, error_code TEXT, error_message TEXT,
        next_check_at TEXT NOT NULL, additional_section_request TEXT NOT NULL DEFAULT '',
        recorder_id TEXT NOT NULL DEFAULT 'legacy', recorder_lease_until TEXT, recording_finalized_at TEXT,
        pipeline_released_at TEXT,
        device_session_released_at TEXT, cancel_requested_at TEXT, cancelled_at TEXT, cleanup_after TEXT,
        source_name TEXT, source_user_agent TEXT, source_ip TEXT
      );
      CREATE TABLE IF NOT EXISTS meeting_recording_devices (
        owner_id TEXT PRIMARY KEY, slot_number INTEGER NOT NULL, display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','retiring','revoked')),
        registered_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT,
        last_user_agent TEXT, last_ip TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_meeting_one_shot_due ON meeting_one_shot_sessions(cleaned_at, next_check_at);
      CREATE TABLE IF NOT EXISTS meeting_one_shot_access_leases (
        lease_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES meeting_one_shot_sessions(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_meeting_one_shot_access ON meeting_one_shot_access_leases(session_id, expires_at);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS meeting_recording_operation_leases (
      lease_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES meeting_one_shot_sessions(session_id) ON DELETE CASCADE
    ); CREATE INDEX IF NOT EXISTS idx_meeting_recording_operation ON meeting_recording_operation_leases(session_id, expires_at);`);
    // API 與 worker 可能同時啟動，以寫入鎖保護舊資料表的欄位升級。
    await db.exec("BEGIN IMMEDIATE");
    try {
      const fields = await db.all<Array<{ name: string }>>("PRAGMA table_info(meeting_one_shot_sessions)");
      if (!fields.some(field => field.name === "additional_section_request")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN additional_section_request TEXT NOT NULL DEFAULT ''");
      }
      if (!fields.some(field => field.name === "recorder_id")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN recorder_id TEXT NOT NULL DEFAULT 'legacy'");
      }
      const addedRecorderLease = !fields.some(field => field.name === "recorder_lease_until");
      if (addedRecorderLease) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN recorder_lease_until TEXT");
      }
      if (!fields.some(field => field.name === "recording_finalized_at")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN recording_finalized_at TEXT");
      }
      if (!fields.some(field => field.name === "pipeline_released_at")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN pipeline_released_at TEXT");
      }
      if (!fields.some(field => field.name === "device_session_released_at")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN device_session_released_at TEXT");
      }
      if (!fields.some(field => field.name === "cancel_requested_at")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN cancel_requested_at TEXT");
      }
      if (!fields.some(field => field.name === "cancelled_at")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN cancelled_at TEXT");
      }
      if (!fields.some(field => field.name === "cleanup_after")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN cleanup_after TEXT");
      }
      await db.exec(`UPDATE meeting_one_shot_sessions
        SET cleanup_after=COALESCE(cleanup_after, cancelled_at),
            pipeline_released_at=COALESCE(pipeline_released_at, cancelled_at),
            device_session_released_at=COALESCE(device_session_released_at, cancelled_at)
        WHERE cancelled_at IS NOT NULL`);
      if (!fields.some(field => field.name === "source_name")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN source_name TEXT");
      }
      if (!fields.some(field => field.name === "source_user_agent")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN source_user_agent TEXT");
      }
      if (!fields.some(field => field.name === "source_ip")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN source_ip TEXT");
      }
      if (!fields.some(field => field.name === "adopted_version_id")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN adopted_version_id TEXT");
      }
      if (!fields.some(field => field.name === "revision_job_id")) {
        await db.exec("ALTER TABLE meeting_one_shot_sessions ADD COLUMN revision_job_id TEXT");
      }
      await db.exec("DROP INDEX IF EXISTS idx_meeting_device_active_slot");
      await db.exec("UPDATE meeting_recording_devices SET status='active', revoked_at=NULL WHERE status!='active'");
      await db.exec(`UPDATE meeting_one_shot_sessions SET
        source_name=COALESCE(source_name, (SELECT display_name FROM meeting_recording_devices d WHERE d.owner_id=meeting_one_shot_sessions.owner_id)),
        source_user_agent=COALESCE(source_user_agent, (SELECT last_user_agent FROM meeting_recording_devices d WHERE d.owner_id=meeting_one_shot_sessions.owner_id)),
        source_ip=COALESCE(source_ip, (SELECT last_ip FROM meeting_recording_devices d WHERE d.owner_id=meeting_one_shot_sessions.owner_id))
        WHERE source_name IS NULL`);
      if (addedRecorderLease) {
        const migrationLeaseUntil = new Date(Date.now() + env.MEETING_RECORDER_LEASE_MS).toISOString();
        await db.run(`UPDATE meeting_one_shot_sessions SET recorder_lease_until=?
          WHERE pipeline_released_at IS NULL AND cleaned_at IS NULL
            AND recorder_lease_until IS NULL AND recording_finalized_at IS NULL`, migrationLeaseUntil);
      }
      const legacyReleases = await db.all<Array<{ sessionId: string; createdAt: string; expiresAt: string | null; cleanedAt: string | null }>>(`
        SELECT session_id AS sessionId, created_at AS createdAt, expires_at AS expiresAt, cleaned_at AS cleanedAt
        FROM meeting_one_shot_sessions
        WHERE pipeline_released_at IS NULL AND (expires_at IS NOT NULL OR cleaned_at IS NOT NULL)`);
      for (const row of legacyReleases) {
        const expiresMs = Date.parse(row.expiresAt ?? "");
        const createdMs = Date.parse(row.createdAt);
        const inferredMs = Number.isFinite(expiresMs)
          ? Math.max(Number.isFinite(createdMs) ? createdMs : 0, expiresMs - env.MEETING_ONE_SHOT_DELIVERY_MS)
          : NaN;
        const releasedAt = Number.isFinite(inferredMs)
          ? new Date(inferredMs).toISOString()
          : row.cleanedAt ?? row.createdAt;
        await db.run("UPDATE meeting_one_shot_sessions SET pipeline_released_at=? WHERE session_id=? AND pipeline_released_at IS NULL",
          releasedAt, row.sessionId);
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

export const meetingOneShotRepository = new MeetingOneShotRepository();
