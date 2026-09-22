import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { env } from "../../config/env";
import {
  meetingProcessingJobRepository,
  type MeetingProcessingJobRecord,
  type MeetingProcessingJobRepository,
} from "../../storage/meeting-minutes/meetingProcessingJobRepository";
import {
  meetingTranscriptionJobRepository,
  type MeetingTranscriptionArtifactRecord,
  type MeetingTranscriptionJobRecord,
  type MeetingTranscriptionJobRepository,
  type MeetingTranscriptionPhase,
} from "../../storage/meeting-minutes/meetingTranscriptionJobRepository";
import { HttpError } from "../../utils/httpError";
import { createKeyedSerialQueue } from "../../utils/keyedSerialQueue";
import {
  meetingProcessingService,
  type MeetingProcessingService,
} from "./meetingProcessingService";
import {
  meetingTranscriptProcessor,
  type MeetingTranscriptProcessorLike,
} from "./meetingTranscriptProcessor";

interface MeetingTranscriptionServiceDeps {
  repository?: MeetingTranscriptionJobRepository;
  processingRepository?: MeetingProcessingJobRepository;
  processingService?: MeetingProcessingService;
  transcriptProcessor?: MeetingTranscriptProcessorLike;
  idFactory?: () => string;
  now?: () => Date;
  maxAttempts?: number;
  retryDelayMs?: number;
  providerMigrationRetryGraceMs?: number;
  leaseMs?: number;
  workerEnabled?: boolean;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && error.code) {
    return String(error.code);
  }
  return "MEETING_TRANSCRIPTION_FAILED";
}

export class MeetingTranscriptionService {
  private readonly repository: MeetingTranscriptionJobRepository;
  private readonly processingRepository: MeetingProcessingJobRepository;
  private readonly processingService: MeetingProcessingService;
  private readonly transcriptProcessor: MeetingTranscriptProcessorLike;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly providerMigrationRetryGraceMs: number;
  private readonly leaseMs: number;
  private readonly enqueueQueue = createKeyedSerialQueue();
  readonly workerEnabled: boolean;
  readonly providerEnabled: boolean;

  constructor(deps: MeetingTranscriptionServiceDeps = {}) {
    this.repository = deps.repository ?? meetingTranscriptionJobRepository;
    this.processingRepository = deps.processingRepository ?? meetingProcessingJobRepository;
    this.processingService = deps.processingService ?? meetingProcessingService;
    this.transcriptProcessor = deps.transcriptProcessor ?? meetingTranscriptProcessor;
    this.idFactory = deps.idFactory ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? env.MEETING_TRANSCRIPTION_MAX_ATTEMPTS;
    this.retryDelayMs = deps.retryDelayMs ?? env.MEETING_TRANSCRIPTION_RETRY_DELAY_MS;
    this.providerMigrationRetryGraceMs =
      deps.providerMigrationRetryGraceMs ??
      env.MEETING_AI_PROVIDER_MIGRATION_RETRY_GRACE_MS;
    this.leaseMs = deps.leaseMs ?? env.MEETING_PROCESSING_STALE_MS;
    this.workerEnabled = deps.workerEnabled ?? env.MEETING_WORKER_ENABLED;
    this.providerEnabled = this.transcriptProcessor.enabled;
  }

  async initialize(): Promise<void> {
    await Promise.all([this.repository.initialize(), this.processingService.initialize()]);
  }

  close(): Promise<void> {
    return this.repository.close();
  }

  async enqueue(
    sessionId: string,
    ownerId: string
  ): Promise<{ job: MeetingTranscriptionJobRecord; created: boolean }> {
    this.assertAvailable();
    await this.initialize();
    const processingJob = await this.processingService.getJobForSession(sessionId, ownerId);
    if (!processingJob) {
      throw new HttpError(
        404,
        "找不到可轉錄的錄音後處理任務。",
        "MEETING_TRANSCRIPTION_PROCESSING_JOB_NOT_FOUND"
      );
    }
    return this.enqueueFromProcessingJob(processingJob);
  }

  async enqueueFromProcessingJob(
    processingJob: MeetingProcessingJobRecord
  ): Promise<{ job: MeetingTranscriptionJobRecord; created: boolean }> {
    this.assertAvailable();
    if (processingJob.status !== "ready") {
      throw new HttpError(
        409,
        "音訊後處理尚未完成，暫時不能產生逐字稿。",
        "MEETING_TRANSCRIPTION_AUDIO_NOT_READY"
      );
    }
    if (!processingJob.artifacts.some((artifact) => artifact.type.startsWith("canonical-"))) {
      throw new HttpError(
        409,
        "找不到可轉錄的 canonical 音軌。",
        "MEETING_TRANSCRIPTION_CANONICAL_TRACK_MISSING"
      );
    }
    await this.repository.initialize();
    let result!: { job: MeetingTranscriptionJobRecord; created: boolean };
    await this.enqueueQueue.enqueue(processingJob.sessionId, async () => {
      const existing = await this.repository.getJobBySessionForOwner(
        processingJob.sessionId,
        processingJob.ownerId
      );
      if (existing) {
        result = { job: existing, created: false };
        return;
      }
      result = await this.repository.enqueue({
        jobId: this.idFactory(),
        processingJobId: processingJob.jobId,
        sessionId: processingJob.sessionId,
        ownerId: processingJob.ownerId,
        provider: this.transcriptProcessor.providerName,
        model: this.transcriptProcessor.model,
        maxAttempts: this.maxAttempts,
        now: this.now().toISOString(),
      });
    });
    return result;
  }

  getJob(
    jobId: string,
    ownerId: string
  ): Promise<MeetingTranscriptionJobRecord | null> {
    return this.repository.getJobForOwner(jobId, ownerId);
  }

  getJobForSession(
    sessionId: string,
    ownerId: string
  ): Promise<MeetingTranscriptionJobRecord | null> {
    return this.repository.getJobBySessionForOwner(sessionId, ownerId);
  }

  listActiveSessionIds(): Promise<string[]> {
    const providerChangedAfter = new Date(
      this.now().getTime() - this.providerMigrationRetryGraceMs
    ).toISOString();
    return this.repository.listActiveSessionIds({
      provider: this.transcriptProcessor.providerName,
      model: this.transcriptProcessor.model,
      providerChangedAfter,
    });
  }

  async retry(jobId: string, ownerId: string): Promise<MeetingTranscriptionJobRecord> {
    this.assertAvailable();
    const now = this.now();
    const nowIso = now.toISOString();
    const providerChangedAfter = new Date(
      now.getTime() - this.providerMigrationRetryGraceMs
    ).toISOString();
    await this.repository.markProviderMigrationFailures({
      provider: this.transcriptProcessor.providerName,
      model: this.transcriptProcessor.model,
      now: nowIso,
    });
    await this.repository.expireProviderMigrationFailures({
      provider: this.transcriptProcessor.providerName,
      model: this.transcriptProcessor.model,
      now: nowIso,
      retryBefore: providerChangedAfter,
    });
    const job = await this.repository.getJobForOwner(jobId, ownerId);
    if (!job) {
      throw new HttpError(
        404,
        "找不到逐字稿任務。",
        "MEETING_TRANSCRIPTION_JOB_NOT_FOUND"
      );
    }
    if (job.status !== "failed") {
      throw new HttpError(
        409,
        "只有失敗的逐字稿任務可以重試。",
        "MEETING_TRANSCRIPTION_RETRY_INVALID"
      );
    }
    if (job.errorCode === "MEETING_TRANSCRIPTION_PROVIDER_MIGRATION_EXPIRED") {
      throw new HttpError(
        409,
        "逐字稿 provider 升級重送期限已過，請重新建立逐字稿任務。",
        "MEETING_TRANSCRIPTION_PROVIDER_MIGRATION_EXPIRED"
      );
    }
    const providerChanged =
      job.provider !== this.transcriptProcessor.providerName ||
      job.model !== this.transcriptProcessor.model;
    if (!providerChanged && job.attemptCount >= job.maxAttempts) {
      throw new HttpError(
        409,
        "逐字稿任務已達重試上限。",
        "MEETING_TRANSCRIPTION_RETRY_EXHAUSTED"
      );
    }
    const retried = await this.repository.retry({
      jobId,
      ownerId,
      provider: this.transcriptProcessor.providerName,
      model: this.transcriptProcessor.model,
      now: nowIso,
      providerChangedAfter,
    });
    if (!retried) {
      throw new HttpError(
        409,
        "逐字稿任務狀態已改變，請重新整理。",
        "MEETING_TRANSCRIPTION_RETRY_CONFLICT"
      );
    }
    return retried;
  }

  async processClaimedJob(
    job: MeetingTranscriptionJobRecord,
    workerId: string,
    signal?: AbortSignal
  ): Promise<MeetingTranscriptionJobRecord> {
    let terminalJob: MeetingTranscriptionJobRecord;
    try {
      if (
        job.provider !== this.transcriptProcessor.providerName ||
        job.model !== this.transcriptProcessor.model
      ) {
        throw Object.assign(
          new Error("逐字稿 provider 或 model 已變更，請從任務畫面重新處理。"),
          { code: "MEETING_TRANSCRIPTION_PROVIDER_CHANGED" }
        );
      }
      const processingJob = await this.processingRepository.getJob(job.processingJobId);
      if (
        !processingJob ||
        processingJob.status !== "ready" ||
        processingJob.sessionId !== job.sessionId ||
        processingJob.ownerId !== job.ownerId
      ) {
        throw Object.assign(new Error("逐字稿來源音訊任務不存在或尚未完成。"), {
          code: "MEETING_TRANSCRIPTION_AUDIO_NOT_READY",
        });
      }
      const tracks = [] as Array<{
        sourceId: "room-mic" | "remote-tab";
        filePath: string;
      }>;
      for (const artifact of processingJob.artifacts) {
        if (
          artifact.type !== "canonical-room-mic" &&
          artifact.type !== "canonical-remote-tab"
        ) {
          continue;
        }
        const resolved = await this.processingService.resolveArtifact(artifact);
        tracks.push({
          sourceId:
            artifact.type === "canonical-room-mic" ? "room-mic" : "remote-tab",
          filePath: resolved.filePath,
        });
      }
      const artifacts = await this.transcriptProcessor.process(
        { jobId: job.jobId, sessionId: job.sessionId, tracks },
        async (phase) => this.assertLeasePhase(job.jobId, workerId, phase),
        { signal }
      );
      terminalJob = await this.repository.markReady({
        jobId: job.jobId,
        workerId,
        artifacts,
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

  async recoverExpiredJobs(): Promise<{
    requeued: number;
    exhausted: number;
    autoRetried: number;
    providerMigrationsDetected: number;
    providerMigrationsExpired: number;
  }> {
    const now = this.now();
    const nowIso = now.toISOString();
    const providerMigrationsDetected =
      await this.repository.markProviderMigrationFailures({
        provider: this.transcriptProcessor.providerName,
        model: this.transcriptProcessor.model,
        now: nowIso,
      });
    const providerMigrationsExpired =
      await this.repository.expireProviderMigrationFailures({
        provider: this.transcriptProcessor.providerName,
        model: this.transcriptProcessor.model,
        now: nowIso,
        retryBefore: new Date(
          now.getTime() - this.providerMigrationRetryGraceMs
        ).toISOString(),
      });
    const autoRetried = this.providerEnabled
      ? await this.repository.requeueRetryableFailed(
          nowIso,
          new Date(now.getTime() - this.retryDelayMs).toISOString()
        )
      : [];
    const recovered = await this.repository.recoverExpiredRunning(nowIso);
    return {
      requeued: recovered.requeued,
      exhausted: recovered.exhausted,
      autoRetried: autoRetried.length,
      providerMigrationsDetected: providerMigrationsDetected.length,
      providerMigrationsExpired: providerMigrationsExpired.length,
    };
  }

  deleteTerminalJobsForProcessingJobs(processingJobIds: string[]): Promise<string[]> {
    return this.repository.deleteTerminalJobsByProcessingJobIds(processingJobIds);
  }

  async resolveArtifact(
    artifact: MeetingTranscriptionArtifactRecord
  ): Promise<{ filePath: string; mimeType: string; sizeBytes: number }> {
    const filePath = this.transcriptProcessor.resolveArtifactPath(artifact.relativePath);
    try {
      await access(filePath);
    } catch {
      throw new HttpError(
        410,
        "逐字稿產物已不存在。",
        "MEETING_TRANSCRIPTION_ARTIFACT_MISSING"
      );
    }
    return { filePath, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes };
  }

  private assertAvailable(): void {
    if (!this.workerEnabled) {
      throw new HttpError(
        503,
        "Meeting worker 尚未啟用。",
        "MEETING_PROCESSING_WORKER_DISABLED"
      );
    }
    if (!this.providerEnabled) {
      throw new HttpError(
        503,
        "Meeting 逐字稿 provider 尚未設定。",
        "MEETING_TRANSCRIPTION_PROVIDER_DISABLED"
      );
    }
  }

  private async assertLeasePhase(
    jobId: string,
    workerId: string,
    phase: MeetingTranscriptionPhase
  ): Promise<void> {
    const now = this.now();
    const updated = await this.repository.updatePhase({
      jobId,
      workerId,
      phase,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    });
    if (!updated) throw new Error("meeting transcription job lease lost");
  }
}

export const meetingTranscriptionService = new MeetingTranscriptionService();
