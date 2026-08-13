import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { env } from "../../config/env";
import {
  meetingMinutesJobRepository,
  type MeetingMinutesArtifactRecord,
  type MeetingMinutesJobRecord,
  type MeetingMinutesJobRepository,
  type MeetingMinutesVersionRecord,
} from "../../storage/meeting-minutes/meetingMinutesJobRepository";
import { HttpError } from "../../utils/httpError";
import { createKeyedSerialQueue } from "../../utils/keyedSerialQueue";
import {
  meetingProcessingService,
  type MeetingProcessingService,
} from "./meetingProcessingService";
import {
  meetingTranscriptionService,
  type MeetingTranscriptionService,
} from "./meetingTranscriptionService";
import {
  meetingMinutesPackageService,
  type MeetingMinutesPackageService,
} from "./meetingMinutesPackageService";
import {
  meetingMinutesProvider,
} from "./meetingMinutesProviderFactory";
import type { MeetingMinutesProviderLike } from "./meetingMinutesProvider";
import {
  applyMeetingMinutesHumanOverrides,
  normalizeMeetingMinutesHumanInput,
  type MeetingMinutesHumanInput,
} from "./meetingMinutesSchema";
import { isMeetingMinutesFailureRetryable } from "./meetingMinutesRetryPolicy";

interface MeetingMinutesServiceDeps {
  repository?: MeetingMinutesJobRepository;
  transcriptionService?: MeetingTranscriptionService;
  processingService?: MeetingProcessingService;
  packageService?: MeetingMinutesPackageService;
  provider?: MeetingMinutesProviderLike;
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
  return "MEETING_MINUTES_FAILED";
}

function inputSha256(input: {
  transcriptionJobId: string;
  transcriptSha256: string;
  human: MeetingMinutesHumanInput;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class MeetingMinutesService {
  private readonly repository: MeetingMinutesJobRepository;
  private readonly transcriptionService: MeetingTranscriptionService;
  private readonly processingService: MeetingProcessingService;
  private readonly packageService: MeetingMinutesPackageService;
  private readonly provider: MeetingMinutesProviderLike;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly providerMigrationRetryGraceMs: number;
  private readonly leaseMs: number;
  private readonly enqueueQueue = createKeyedSerialQueue();
  readonly workerEnabled: boolean;
  readonly providerEnabled: boolean;

  constructor(deps: MeetingMinutesServiceDeps = {}) {
    this.repository = deps.repository ?? meetingMinutesJobRepository;
    this.transcriptionService = deps.transcriptionService ?? meetingTranscriptionService;
    this.processingService = deps.processingService ?? meetingProcessingService;
    this.packageService = deps.packageService ?? meetingMinutesPackageService;
    this.provider = deps.provider ?? meetingMinutesProvider;
    this.idFactory = deps.idFactory ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? env.MEETING_MINUTES_MAX_ATTEMPTS;
    this.retryDelayMs = deps.retryDelayMs ?? env.MEETING_MINUTES_RETRY_DELAY_MS;
    this.providerMigrationRetryGraceMs =
      deps.providerMigrationRetryGraceMs ??
      env.MEETING_AI_PROVIDER_MIGRATION_RETRY_GRACE_MS;
    this.leaseMs = deps.leaseMs ?? env.MEETING_PROCESSING_STALE_MS;
    this.workerEnabled = deps.workerEnabled ?? env.MEETING_WORKER_ENABLED;
    this.providerEnabled = this.provider.enabled;
  }

  async initialize(): Promise<void> {
    await this.repository.initialize();
  }

  close(): Promise<void> {
    return this.repository.close();
  }

  async enqueue(input: {
    sessionId: string;
    ownerId: string;
    clientRequestKey: string;
    humanInput: Partial<MeetingMinutesHumanInput>;
  }): Promise<{ job: MeetingMinutesJobRecord; created: boolean }> {
    this.assertAvailable();
    const clientRequestKey = input.clientRequestKey.trim();
    if (!clientRequestKey || clientRequestKey.length > 200) {
      throw new HttpError(
        400,
        "clientRequestKey 不可為空且長度不可超過 200 字元。",
        "MEETING_MINUTES_CLIENT_REQUEST_KEY_INVALID"
      );
    }
    const human = normalizeMeetingMinutesHumanInput(input.humanInput);
    await this.initialize();
    const transcriptionJob = await this.transcriptionService.getJobForSession(
      input.sessionId,
      input.ownerId
    );
    const transcriptArtifact = transcriptionJob?.artifacts.find(
      (artifact) => artifact.type === "transcript-merged-json"
    );
    if (!transcriptionJob || transcriptionJob.status !== "ready" || !transcriptArtifact) {
      throw new HttpError(
        409,
        "合併逐字稿尚未完成，暫時不能產生會議紀錄。",
        "MEETING_MINUTES_TRANSCRIPT_NOT_READY"
      );
    }
    const sha256 = inputSha256({
      transcriptionJobId: transcriptionJob.jobId,
      transcriptSha256: transcriptArtifact.sha256,
      human,
    });
    let result!: { job: MeetingMinutesJobRecord; created: boolean };
    await this.enqueueQueue.enqueue(input.sessionId, async () => {
      const existing = await this.repository.getJobByRequestKeyForOwner(
        input.sessionId,
        input.ownerId,
        clientRequestKey
      );
      if (existing) {
        if (
          existing.transcriptionJobId !== transcriptionJob.jobId ||
          existing.inputSha256 !== sha256
        ) {
          throw new HttpError(
            409,
            "相同 clientRequestKey 已用於不同的會議紀錄內容。",
            "MEETING_MINUTES_CLIENT_REQUEST_KEY_CONFLICT"
          );
        }
        result = { job: existing, created: false };
        return;
      }
      result = await this.repository.enqueue({
        jobId: this.idFactory(),
        transcriptionJobId: transcriptionJob.jobId,
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        clientRequestKey,
        inputSha256: sha256,
        humanInput: human,
        provider: this.provider.name,
        model: this.provider.model,
        maxAttempts: this.maxAttempts,
        now: this.now().toISOString(),
      });
    });
    return result;
  }

  getJob(jobId: string, ownerId: string): Promise<MeetingMinutesJobRecord | null> {
    return this.repository.getJobForOwner(jobId, ownerId);
  }

  listVersions(
    sessionId: string,
    ownerId: string,
    limit?: number
  ): Promise<MeetingMinutesVersionRecord[]> {
    return this.repository.listVersionsForOwner(sessionId, ownerId, limit);
  }

  getVersion(versionId: string, ownerId: string): Promise<MeetingMinutesVersionRecord | null> {
    return this.repository.getVersionForOwner(versionId, ownerId);
  }

  listActiveSessionIds(): Promise<string[]> {
    const providerChangedAfter = new Date(
      this.now().getTime() - this.providerMigrationRetryGraceMs
    ).toISOString();
    return this.repository.listActiveSessionIds({
      provider: this.provider.name,
      model: this.provider.model,
      providerChangedAfter,
    });
  }

  async retry(jobId: string, ownerId: string): Promise<MeetingMinutesJobRecord> {
    this.assertAvailable();
    const now = this.now();
    const nowIso = now.toISOString();
    const providerChangedAfter = new Date(
      now.getTime() - this.providerMigrationRetryGraceMs
    ).toISOString();
    await this.repository.markProviderMigrationFailures({
      provider: this.provider.name,
      model: this.provider.model,
      now: nowIso,
    });
    await this.repository.expireProviderMigrationFailures({
      provider: this.provider.name,
      model: this.provider.model,
      now: nowIso,
      retryBefore: providerChangedAfter,
    });
    const job = await this.repository.getJobForOwner(jobId, ownerId);
    if (!job) {
      throw new HttpError(404, "找不到會議紀錄任務。", "MEETING_MINUTES_JOB_NOT_FOUND");
    }
    if (job.status !== "failed") {
      throw new HttpError(
        409,
        "只有失敗的會議紀錄任務可以重試。",
        "MEETING_MINUTES_RETRY_INVALID"
      );
    }
    if (job.errorCode === "MEETING_MINUTES_PROVIDER_MIGRATION_EXPIRED") {
      throw new HttpError(
        409,
        "會議紀錄 provider 升級重送期限已過，請重新產生會議紀錄任務。",
        "MEETING_MINUTES_PROVIDER_MIGRATION_EXPIRED"
      );
    }
    const providerChanged =
      job.provider !== this.provider.name || job.model !== this.provider.model;
    if (!providerChanged && job.attemptCount >= job.maxAttempts) {
      throw new HttpError(
        409,
        "會議紀錄任務已達重試上限。",
        "MEETING_MINUTES_RETRY_EXHAUSTED"
      );
    }
    const retried = await this.repository.retry({
      jobId,
      ownerId,
      provider: this.provider.name,
      model: this.provider.model,
      now: nowIso,
      providerChangedAfter,
    });
    if (!retried) {
      throw new HttpError(
        409,
        "會議紀錄任務狀態已改變，請重新整理。",
        "MEETING_MINUTES_RETRY_CONFLICT"
      );
    }
    return retried;
  }

  async processClaimedJob(
    job: MeetingMinutesJobRecord,
    workerId: string,
    signal?: AbortSignal
  ): Promise<MeetingMinutesJobRecord> {
    let terminalJob: MeetingMinutesJobRecord;
    try {
      if (job.provider !== this.provider.name || job.model !== this.provider.model) {
        throw Object.assign(
          new Error("會議紀錄 provider 或 model 已變更，請從任務畫面重新產生。"),
          { code: "MEETING_MINUTES_PROVIDER_CHANGED" }
        );
      }
      const transcriptionJob = await this.transcriptionService.getJob(
        job.transcriptionJobId,
        job.ownerId
      );
      if (
        !transcriptionJob ||
        transcriptionJob.status !== "ready" ||
        transcriptionJob.sessionId !== job.sessionId
      ) {
        throw Object.assign(new Error("會議紀錄來源逐字稿不存在或尚未完成。"), {
          code: "MEETING_MINUTES_TRANSCRIPT_NOT_READY",
        });
      }
      const mergedArtifact = transcriptionJob.artifacts.find(
        (artifact) => artifact.type === "transcript-merged-json"
      );
      const textArtifact = transcriptionJob.artifacts.find(
        (artifact) => artifact.type === "transcript-text"
      );
      if (!mergedArtifact || !textArtifact) {
        throw Object.assign(new Error("會議紀錄來源逐字稿產物不完整。"), {
          code: "MEETING_MINUTES_TRANSCRIPT_ARTIFACT_MISSING",
        });
      }
      const [mergedFile, textFile] = await Promise.all([
        this.transcriptionService.resolveArtifact(mergedArtifact),
        this.transcriptionService.resolveArtifact(textArtifact),
      ]);
      const transcript = await this.packageService.readTranscriptDocument(mergedFile.filePath);
      if (transcript.sessionId !== job.sessionId) {
        throw Object.assign(new Error("合併逐字稿 session 不一致。"), {
          code: "MEETING_MINUTES_TRANSCRIPT_SESSION_MISMATCH",
        });
      }
      const transcriptText = await readFile(textFile.filePath, "utf8");
      const providerRecord = await this.provider.summarize(
        { transcript, human: job.input },
        { signal }
      );
      const record = applyMeetingMinutesHumanOverrides(providerRecord, job.input);
      await this.assertLeasePhase(job.jobId, workerId, "packaging");
      const generatedAt = this.now().toISOString();
      const version = await this.repository.reserveVersion({
        versionId: this.idFactory(),
        jobId: job.jobId,
        workerId,
        record,
        now: generatedAt,
      });
      const processingJob = await this.processingService.getJobForSession(
        job.sessionId,
        job.ownerId
      );
      const playbackArtifact = processingJob?.artifacts.find(
        (artifact) => artifact.type === "playback"
      );
      const playback = playbackArtifact
        ? await this.processingService.resolveArtifact(playbackArtifact)
        : null;
      const packageResult = await this.packageService.build({
        jobId: job.jobId,
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        sessionId: job.sessionId,
        record,
        generatedAt,
        transcript,
        transcriptText,
        playbackFilePath: playback?.filePath,
      });
      terminalJob = await this.repository.markReady({
        jobId: job.jobId,
        workerId,
        versionId: version.versionId,
        packageRelativePath: packageResult.packageRelativePath,
        artifacts: packageResult.artifacts,
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
        const failureCode = errorCode(error);
        terminalJob = await this.repository.markFailed({
          jobId: job.jobId,
          workerId,
          errorCode: failureCode,
          errorMessage: error instanceof Error ? error.message : String(error),
          retryable: isMeetingMinutesFailureRetryable(failureCode),
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
        provider: this.provider.name,
        model: this.provider.model,
        now: nowIso,
      });
    const providerMigrationsExpired =
      await this.repository.expireProviderMigrationFailures({
        provider: this.provider.name,
        model: this.provider.model,
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

  deleteTerminalJobsForTranscriptionJobs(transcriptionJobIds: string[]): Promise<string[]> {
    return this.repository.deleteTerminalJobsByTranscriptionJobIds(transcriptionJobIds);
  }

  resolveArtifact(
    artifact: MeetingMinutesArtifactRecord
  ): Promise<{ filePath: string; mimeType: string; sizeBytes: number }> {
    return this.packageService.resolveArtifact(artifact);
  }

  streamVersionZip(version: MeetingMinutesVersionRecord, output: NodeJS.WritableStream): Promise<void> {
    return this.packageService.streamVersionZip(version, output as import("node:stream").Writable);
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
        "Meeting 會議紀錄 provider 尚未設定。",
        "MEETING_MINUTES_PROVIDER_DISABLED"
      );
    }
  }

  private async assertLeasePhase(
    jobId: string,
    workerId: string,
    phase: "packaging"
  ): Promise<void> {
    const now = this.now();
    const updated = await this.repository.updatePhase({
      jobId,
      workerId,
      phase,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    });
    if (!updated) throw new Error("meeting minutes job lease lost");
  }
}

export const meetingMinutesService = new MeetingMinutesService();
