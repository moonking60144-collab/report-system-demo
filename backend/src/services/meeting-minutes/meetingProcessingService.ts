import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { env } from "../../config/env";
import { createLogger } from "../../observability/logger";
import {
  MEETING_PROCESSING_ARTIFACT_EVICTED_ERROR_CODE,
  meetingProcessingJobRepository,
  type MeetingProcessingArtifactRecord,
  type MeetingProcessingJobRecord,
  type MeetingProcessingJobRepository,
  type MeetingProcessingPhase,
} from "../../storage/meeting-minutes/meetingProcessingJobRepository";
import { HttpError } from "../../utils/httpError";
import { createKeyedSerialQueue } from "../../utils/keyedSerialQueue";
import {
  meetingAudioProcessor,
  type MeetingAudioProcessorLike,
} from "./meetingAudioProcessor";
import {
  meetingRecordingStorageService,
  type MeetingRecordingStorageService,
} from "./meetingRecordingStorageService";

interface MeetingProcessingServiceDeps {
  repository?: MeetingProcessingJobRepository;
  recordingStorage?: MeetingRecordingStorageService;
  audioProcessor?: MeetingAudioProcessorLike;
  idFactory?: () => string;
  now?: () => Date;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxArtifactBytes?: number;
  leaseMs?: number;
  workerEnabled?: boolean;
}

const log = createLogger("meeting-processing");

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code) {
    return String(error.code);
  }
  return "MEETING_PROCESSING_FAILED";
}

export class MeetingProcessingService {
  private readonly repository: MeetingProcessingJobRepository;
  private readonly recordingStorage: MeetingRecordingStorageService;
  private readonly audioProcessor: MeetingAudioProcessorLike;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxArtifactBytes: number;
  private readonly leaseMs: number;
  private readonly sessionMutationQueue = createKeyedSerialQueue();
  readonly workerEnabled: boolean;

  constructor(deps: MeetingProcessingServiceDeps = {}) {
    this.repository = deps.repository ?? meetingProcessingJobRepository;
    this.recordingStorage = deps.recordingStorage ?? meetingRecordingStorageService;
    this.audioProcessor = deps.audioProcessor ?? meetingAudioProcessor;
    this.idFactory = deps.idFactory ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? env.MEETING_PROCESSING_MAX_ATTEMPTS;
    this.retryDelayMs = deps.retryDelayMs ?? env.MEETING_PROCESSING_RETRY_DELAY_MS;
    this.maxArtifactBytes =
      deps.maxArtifactBytes ?? env.MEETING_PROCESSING_MAX_TOTAL_BYTES;
    this.leaseMs = deps.leaseMs ?? env.MEETING_PROCESSING_STALE_MS;
    this.workerEnabled = deps.workerEnabled ?? env.MEETING_WORKER_ENABLED;
  }

  async initialize(): Promise<void> {
    await Promise.all([this.repository.initialize(), this.recordingStorage.initialize()]);
  }

  close(): Promise<void> {
    return this.repository.close();
  }

  async enqueue(sessionId: string, ownerId: string): Promise<{
    job: MeetingProcessingJobRecord;
    created: boolean;
  }> {
    await this.initialize();
    let result!: { job: MeetingProcessingJobRecord; created: boolean };
    await this.sessionMutationQueue.enqueue(sessionId, async () => {
      const existing = await this.repository.getJobBySessionForOwner(sessionId, ownerId);
      if (existing) {
        if (
          existing.status === "pending" ||
          existing.status === "running" ||
          (existing.status === "failed" && existing.attemptCount < existing.maxAttempts)
        ) {
          await this.acquireProcessingLock({
            sessionId,
            ownerId,
            jobId: existing.jobId,
          });
        }
        result = { job: existing, created: false };
        return;
      }

      const jobId = this.idFactory();
      await this.acquireProcessingLock({ sessionId, ownerId, jobId });
      try {
        result = await this.repository.enqueue({
          jobId,
          sessionId,
          ownerId,
          maxAttempts: this.maxAttempts,
          now: this.now().toISOString(),
        });
      } catch (error) {
        await this.recordingStorage.releaseProcessingLock(sessionId, jobId).catch(() => false);
        throw error;
      }
    });
    return result;
  }

  getJob(jobId: string, ownerId: string): Promise<MeetingProcessingJobRecord | null> {
    return this.repository.getJobForOwner(jobId, ownerId);
  }

  getJobForSession(
    sessionId: string,
    ownerId: string
  ): Promise<MeetingProcessingJobRecord | null> {
    return this.repository.getJobBySessionForOwner(sessionId, ownerId);
  }

  async retry(jobId: string, ownerId: string): Promise<MeetingProcessingJobRecord> {
    const initialJob = await this.repository.getJobForOwner(jobId, ownerId);
    if (!initialJob) {
      throw new HttpError(404, "找不到後處理任務。", "MEETING_PROCESSING_JOB_NOT_FOUND");
    }
    let result!: MeetingProcessingJobRecord;
    await this.sessionMutationQueue.enqueue(initialJob.sessionId, async () => {
      const job = await this.repository.getJobForOwner(jobId, ownerId);
      if (!job) {
        throw new HttpError(404, "找不到後處理任務。", "MEETING_PROCESSING_JOB_NOT_FOUND");
      }
      if (job.status !== "failed") {
        throw new HttpError(409, "只有失敗的後處理任務可以重試。", "MEETING_PROCESSING_RETRY_INVALID");
      }
      if (job.attemptCount >= job.maxAttempts) {
        throw new HttpError(409, "後處理任務已達重試上限。", "MEETING_PROCESSING_RETRY_EXHAUSTED");
      }
      await this.acquireProcessingLock({
        sessionId: job.sessionId,
        ownerId,
        jobId,
      });
      const retried = await this.repository.retry(jobId, ownerId, this.now().toISOString());
      if (!retried) {
        const current = await this.repository.getJobForOwner(jobId, ownerId);
        if (
          !current ||
          current.status === "ready" ||
          (current.status === "failed" && current.attemptCount >= current.maxAttempts)
        ) {
          await this.releaseProcessingLockSafely(job.sessionId, jobId);
        }
        throw new HttpError(409, "後處理任務狀態已改變，請重新整理。", "MEETING_PROCESSING_RETRY_CONFLICT");
      }
      result = retried;
    });
    return result;
  }

  async processClaimedJob(
    job: MeetingProcessingJobRecord,
    workerId: string,
    signal?: AbortSignal
  ): Promise<MeetingProcessingJobRecord> {
    let terminalJob: MeetingProcessingJobRecord;
    try {
      const input = await this.recordingStorage.resolveProcessingInput(job.sessionId, job.jobId);
      const artifacts = await this.audioProcessor.process(
        input,
        async (phase) => {
          await this.assertLeasePhase(job.jobId, workerId, phase);
        },
        { signal }
      );
      terminalJob = await this.repository.markReady({
        jobId: job.jobId,
        workerId,
        artifacts: artifacts.map((artifact) => ({ ...artifact, jobId: job.jobId })),
        now: this.now().toISOString(),
      });
    } catch (error) {
      if (signal?.aborted) {
        const requeued = await this.repository.requeueClaimed({
          jobId: job.jobId,
          workerId,
          now: this.now().toISOString(),
        });
        if (requeued) return requeued;
        const current = await this.repository.getJob(job.jobId);
        if (current) return current;
        throw error;
      }
      try {
        terminalJob = await this.repository.markFailed({
          jobId: job.jobId,
          workerId,
          errorCode: errorCode(error),
          errorMessage: error instanceof Error ? error.message : String(error),
          now: this.now().toISOString(),
        });
      } catch (transitionError) {
        const current = await this.repository.getJob(job.jobId).catch(() => null);
        if (current?.status !== "ready" && current?.status !== "failed") {
          throw transitionError;
        }
        terminalJob = current;
      }
    }
    if (
      terminalJob.status === "ready" ||
      (terminalJob.status === "failed" &&
        terminalJob.attemptCount >= terminalJob.maxAttempts)
    ) {
      await this.releaseProcessingLockSafely(job.sessionId, job.jobId);
    }
    if (terminalJob.status === "failed") {
      try {
        await this.audioProcessor.removeSessionAudioArtifacts(job.sessionId);
      } catch (error) {
        log.warn({
          event: "failed-artifact-cleanup-failed",
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return terminalJob;
  }

  async heartbeat(jobId: string, workerId: string): Promise<boolean> {
    const now = this.now();
    return this.repository.heartbeat({
      jobId,
      workerId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    });
  }

  async recoverExpiredJobs(options: { reconcileTerminalLocks?: boolean } = {}): Promise<{
    requeued: number;
    exhausted: number;
    autoRetried: number;
    releasedLocks: number;
    lockReleaseFailures: number;
  }> {
    const now = this.now();
    const nowIso = now.toISOString();
    const autoRetriedJobIds = await this.repository.requeueRetryableFailed(
      nowIso,
      new Date(now.getTime() - this.retryDelayMs).toISOString()
    );
    const recovered = await this.repository.recoverExpiredRunning(nowIso);
    let releasedLocks = 0;
    let lockReleaseFailures = 0;
    const terminalJobs = options.reconcileTerminalLocks === false
      ? []
      : await this.repository.listJobsWithReleasableLocks();
    for (const job of terminalJobs) {
      try {
        if (await this.recordingStorage.releaseProcessingLock(job.sessionId, job.jobId)) {
          releasedLocks += 1;
        }
      } catch (error) {
        lockReleaseFailures += 1;
        log.warn({
          event: "terminal-lock-release-failed",
          sessionId: job.sessionId,
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      requeued: recovered.requeued,
      exhausted: recovered.exhausted,
      autoRetried: autoRetriedJobIds.length,
      releasedLocks,
      lockReleaseFailures,
    };
  }

  async cleanupArtifacts(
    protectedSessionIds: ReadonlySet<string> = new Set()
  ): Promise<{
    deletedJobIds: string[];
    retainedBytes: number;
    maxTotalBytes: number;
  }> {
    await this.audioProcessor.cleanupTrash();
    const pendingEvictions =
      await this.repository.listArtifactEvictionJobsWithArtifacts();
    const readyJobs = await this.repository.listReadyJobsWithArtifacts();
    const retainedJobsById = new Map(
      [...pendingEvictions, ...readyJobs].map((job) => [job.jobId, job])
    );
    let retainedBytes = [...retainedJobsById.values()].reduce(
      (total, job) =>
        total + job.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
      0
    );
    const deletedJobIds: string[] = [];

    for (const job of pendingEvictions) {
      if (protectedSessionIds.has(job.sessionId)) continue;
      let completedBytes = 0;
      await this.sessionMutationQueue.enqueue(job.sessionId, async () => {
        const current = await this.repository.getJob(job.jobId);
        if (
          current?.status !== "failed" ||
          current.errorCode !== MEETING_PROCESSING_ARTIFACT_EVICTED_ERROR_CODE ||
          current.artifacts.length === 0
        ) {
          return;
        }
        const currentBytes = current.artifacts.reduce(
          (sum, artifact) => sum + artifact.sizeBytes,
          0
        );
        await this.audioProcessor.removeSessionAudioArtifacts(job.sessionId);
        if (await this.repository.completeArtifactEviction(job.jobId)) {
          completedBytes = currentBytes;
        }
      });
      if (completedBytes > 0) {
        retainedBytes = Math.max(0, retainedBytes - completedBytes);
        deletedJobIds.push(job.jobId);
      }
    }

    for (const job of readyJobs) {
      if (retainedBytes <= this.maxArtifactBytes) break;
      if (protectedSessionIds.has(job.sessionId)) continue;
      let completedBytes = 0;
      await this.sessionMutationQueue.enqueue(job.sessionId, async () => {
        const current = await this.repository.getJob(job.jobId);
        if (current?.status !== "ready" || current.artifacts.length === 0) return;
        const currentBytes = current.artifacts.reduce(
          (sum, artifact) => sum + artifact.sizeBytes,
          0
        );
        if (
          await this.repository.beginArtifactEvictionForReadyJob(
            job.jobId,
            this.now().toISOString()
          )
        ) {
          await this.audioProcessor.removeSessionAudioArtifacts(job.sessionId);
          if (await this.repository.completeArtifactEviction(job.jobId)) {
            completedBytes = currentBytes;
          }
        }
      });
      if (completedBytes > 0) {
        retainedBytes = Math.max(0, retainedBytes - completedBytes);
        deletedJobIds.push(job.jobId);
      }
    }
    return {
      deletedJobIds,
      retainedBytes,
      maxTotalBytes: this.maxArtifactBytes,
    };
  }

  async resolveArtifact(
    artifact: MeetingProcessingArtifactRecord
  ): Promise<{ filePath: string; mimeType: string; sizeBytes: number }> {
    const filePath = this.audioProcessor.resolveArtifactPath(artifact.relativePath);
    try {
      await access(filePath);
    } catch {
      throw new HttpError(410, "後處理產物已不存在。", "MEETING_PROCESSING_ARTIFACT_MISSING");
    }
    return { filePath, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes };
  }

  private async assertLeasePhase(
    jobId: string,
    workerId: string,
    phase: MeetingProcessingPhase
  ): Promise<void> {
    const now = this.now();
    const updated = await this.repository.updatePhase({
      jobId,
      workerId,
      phase,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    });
    if (!updated) {
      throw new Error("meeting processing job lease lost");
    }
  }

  private async acquireProcessingLock(input: {
    sessionId: string;
    ownerId: string;
    jobId: string;
  }): Promise<void> {
    try {
      await this.recordingStorage.acquireProcessingLock(input);
      return;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "MEETING_PROCESSING_ALREADY_LOCKED"
      ) {
        throw error;
      }
    }

    const lockedJobId = await this.recordingStorage.getProcessingLockJobId(input.sessionId);
    if (!lockedJobId || (await this.repository.getJob(lockedJobId))) {
      throw new HttpError(
        409,
        "這份錄音已有後處理任務。",
        "MEETING_PROCESSING_ALREADY_LOCKED"
      );
    }
    const released = await this.recordingStorage.releaseProcessingLock(
      input.sessionId,
      lockedJobId
    );
    if (!released) {
      throw new HttpError(
        409,
        "這份錄音已有後處理任務。",
        "MEETING_PROCESSING_ALREADY_LOCKED"
      );
    }
    await this.recordingStorage.acquireProcessingLock(input);
  }

  private async releaseProcessingLockSafely(sessionId: string, jobId: string): Promise<void> {
    try {
      await this.recordingStorage.releaseProcessingLock(sessionId, jobId);
    } catch (error) {
      log.warn({
        event: "processing-lock-release-failed",
        sessionId,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const meetingProcessingService = new MeetingProcessingService();
