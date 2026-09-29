import { notifyMeetingStateChanged } from "../events/meetingStateEvents";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { createLogger } from "../observability/logger";
import {
  type MeetingProcessingJobRecord,
  type MeetingProcessingJobRepository,
} from "../storage/meeting-minutes/meetingProcessingJobRepository";
import { type MeetingProcessingService } from "../services/meeting-minutes/meetingProcessingService";
import { type MeetingTranscriptionService } from "../services/meeting-minutes/meetingTranscriptionService";
import {
  type MeetingTranscriptionJobRecord,
  type MeetingTranscriptionJobRepository,
} from "../storage/meeting-minutes/meetingTranscriptionJobRepository";
import { type MeetingMinutesService } from "../services/meeting-minutes/meetingMinutesService";
import type { MeetingOneShotService } from "../services/meeting-minutes/meetingOneShotService";
import type { MeetingLiveTranscriptionService } from "../services/meeting-minutes/meetingLiveTranscriptionService";
import {
  type MeetingMinutesJobRecord,
  type MeetingMinutesJobRepository,
} from "../storage/meeting-minutes/meetingMinutesJobRepository";

interface MeetingWorkerRuntimeDeps {
  liveTranscriptionService?: MeetingLiveTranscriptionService;
  oneShotService?: MeetingOneShotService;
  repository: MeetingProcessingJobRepository;
  processingService: MeetingProcessingService;
  transcriptionRepository?: MeetingTranscriptionJobRepository;
  transcriptionService?: MeetingTranscriptionService;
  minutesRepository?: MeetingMinutesJobRepository;
  minutesService?: MeetingMinutesService;
  workerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  cleanupIntervalMs?: number;
  now?: () => Date;
}

const log = createLogger("meeting-worker");

export class MeetingWorkerRuntime {
  private readonly liveTranscriptionService;
  private readonly oneShotService: MeetingOneShotService | null;
  private readonly repository: MeetingProcessingJobRepository;
  private readonly processingService: MeetingProcessingService;
  private readonly transcriptionRepository: MeetingTranscriptionJobRepository | null;
  private readonly transcriptionService: MeetingTranscriptionService | null;
  private readonly minutesRepository: MeetingMinutesJobRepository | null;
  private readonly minutesService: MeetingMinutesService | null;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly now: () => Date;
  private stopping = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readinessTimer: NodeJS.Timeout | null = null;
  private runOncePromise: Promise<boolean> | null = null;
  private nextRecoveryAtMs: number;
  private nextCleanupAtMs: number;
  private currentAbortController: AbortController | null = null;
  private minutesAbortController: AbortController | null = null;
  private minutesPromise: Promise<void> | null = null;

  constructor(deps: MeetingWorkerRuntimeDeps) {
    this.liveTranscriptionService = deps.liveTranscriptionService;
    this.oneShotService = deps.oneShotService ?? null;
    this.repository = deps.repository;
    this.processingService = deps.processingService;
    this.transcriptionRepository = deps.transcriptionRepository ?? null;
    this.transcriptionService = deps.transcriptionService ?? null;
    this.minutesRepository = deps.minutesRepository ?? null;
    this.minutesService = deps.minutesService ?? null;
    this.workerId = deps.workerId ?? randomUUID();
    this.pollIntervalMs = deps.pollIntervalMs ?? env.MEETING_WORKER_POLL_INTERVAL_MS;
    this.leaseMs = deps.leaseMs ?? env.MEETING_PROCESSING_STALE_MS;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? Math.max(
      1_000,
      Math.min(60_000, Math.floor(this.leaseMs / 3))
    );
    this.recoveryIntervalMs = Math.max(
      5_000,
      Math.min(60_000, Math.floor(this.leaseMs / 3))
    );
    this.cleanupIntervalMs =
      deps.cleanupIntervalMs ?? env.MEETING_PROCESSING_CLEANUP_INTERVAL_MS;
    this.now = deps.now ?? (() => new Date());
    this.nextRecoveryAtMs = this.now().getTime() + this.recoveryIntervalMs;
    this.nextCleanupAtMs = this.now().getTime() + this.cleanupIntervalMs;
  }

  async start(): Promise<void> {
    await this.processingService.initialize();
    await this.transcriptionService?.initialize();
    await this.minutesService?.initialize();
    const [recovered, transcriptionRecovered, minutesRecovered] = await Promise.all([
      this.processingService.recoverExpiredJobs(),
      this.transcriptionService?.recoverExpiredJobs(),
      this.minutesService?.recoverExpiredJobs(),
    ]);
    await this.oneShotService?.settleTerminalFailures();
    await this.cleanupArtifactsSafely();
    this.nextRecoveryAtMs = this.now().getTime() + this.recoveryIntervalMs;
    this.nextCleanupAtMs = this.now().getTime() + this.cleanupIntervalMs;
    log.info({
      event: "started",
      workerId: this.workerId,
      processing: recovered,
      transcription: transcriptionRecovered ?? null,
      minutes: minutesRecovered ?? null,
    });
    await this.oneShotService?.heartbeatWorker(this.workerId);
    notifyMeetingStateChanged();
    this.readinessTimer = setInterval(() => {
      if (this.stopping) return;
      void this.oneShotService?.heartbeatWorker(this.workerId).catch(error => log.warn({event:"readiness-heartbeat-failed",error:String(error)}));
    },5_000);
    this.readinessTimer.unref();
    this.schedule(0);
    this.liveTranscriptionService?.start();
  }

  runOnce(): Promise<boolean> {
    if (this.runOncePromise) return this.runOncePromise;
    this.runOncePromise = this.runOnceInternal().finally(() => {
      this.runOncePromise = null;
    });
    return this.runOncePromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.readinessTimer) clearInterval(this.readinessTimer);
    this.currentAbortController?.abort();
    this.minutesAbortController?.abort();
    await this.oneShotService?.releaseWorker(this.workerId).catch(error => log.warn({event:"readiness-release-failed",error:String(error)}));
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    await this.liveTranscriptionService?.stop();
    await this.runOncePromise?.catch(() => undefined);
    await this.minutesPromise;
    await Promise.all([
      this.processingService.close(),
      this.transcriptionService?.close(),
      this.minutesService?.close(),
      this.liveTranscriptionService?.close(),
    ]);
    log.info({ event: "stopped", workerId: this.workerId });
  }

  private async runOnceInternal(): Promise<boolean> {
    if (this.stopping) return false;
    await this.oneShotService?.advance().catch(error => log.warn({ event: "one-shot-reconcile-failed", error: String(error) }));
    const now = this.now();
    if (now.getTime() >= this.nextRecoveryAtMs) {
      const recovered = await this.processingService.recoverExpiredJobs({
        reconcileTerminalLocks: false,
      });
      this.nextRecoveryAtMs = now.getTime() + this.recoveryIntervalMs;
      if (recovered.requeued > 0 || recovered.exhausted > 0 || recovered.autoRetried > 0) {
        log.info({
          event: "lease-recovered",
          workerId: this.workerId,
          jobType: "audio-processing",
          ...recovered,
        });
      }
      if (this.transcriptionService) {
        const transcriptionRecovered = await this.transcriptionService.recoverExpiredJobs();
        if (
          transcriptionRecovered.requeued > 0 ||
          transcriptionRecovered.exhausted > 0 ||
          transcriptionRecovered.autoRetried > 0 ||
          transcriptionRecovered.providerMigrationsDetected > 0 ||
          transcriptionRecovered.providerMigrationsExpired > 0
        ) {
          notifyMeetingStateChanged();
          log.info({
            event: "lease-recovered",
            workerId: this.workerId,
            jobType: "transcription",
            ...transcriptionRecovered,
          });
        }
      }
      if (this.minutesService) {
        const minutesRecovered = await this.minutesService.recoverExpiredJobs();
        if (
          minutesRecovered.requeued > 0 ||
          minutesRecovered.exhausted > 0 ||
          minutesRecovered.autoRetried > 0 ||
          minutesRecovered.providerMigrationsDetected > 0 ||
          minutesRecovered.providerMigrationsExpired > 0
        ) {
          notifyMeetingStateChanged();
          log.info({
            event: "lease-recovered",
            workerId: this.workerId,
            jobType: "meeting-minutes",
            ...minutesRecovered,
          });
        }
      }
      await this.oneShotService?.settleTerminalFailures();
    }
    if (now.getTime() >= this.nextCleanupAtMs) {
      await this.cleanupArtifactsSafely();
      this.nextCleanupAtMs = now.getTime() + this.cleanupIntervalMs;
    }
    let minutesClaimed = false;
    if (!this.minutesPromise && this.minutesRepository && this.minutesService?.providerEnabled) {
      const minutesJob = await this.minutesRepository.claimNext({
        workerId: this.workerId,
        now: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      });
      if (minutesJob) {
        notifyMeetingStateChanged();
        minutesClaimed = true;
        this.minutesPromise = this.processMinutesJob(minutesJob)
          .catch(error => log.error({ event: "minutes-job-failed", jobId: minutesJob.jobId, error: String(error) }))
          .finally(() => { this.minutesPromise = null; });
      }
    }
    const job = await this.repository.claimNext({
      workerId: this.workerId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    });
    if (job) {
      notifyMeetingStateChanged();
      const result = await this.processJob(job);
      const cancelled = await this.oneShotService?.repository.isCancellationRequested(result.sessionId) ?? false;
      if (
        result.status === "ready" &&
        this.transcriptionService?.providerEnabled &&
        !cancelled
      ) {
        try {
          await this.transcriptionService.enqueueFromProcessingJob(result);
        } catch (error) {
          log.warn({
            event: "transcription-auto-enqueue-failed",
            workerId: this.workerId,
            processingJobId: result.jobId,
            sessionId: result.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      notifyMeetingStateChanged();
      return true;
    }
    if (
      this.transcriptionRepository &&
      this.transcriptionService?.providerEnabled
    ) {
      const transcriptionJob = await this.transcriptionRepository.claimNext({
        workerId: this.workerId,
        now: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      });
      if (transcriptionJob) {
        notifyMeetingStateChanged();
        await this.processTranscriptionJob(transcriptionJob);
        return true;
      }
    }
    return minutesClaimed;
  }

  private async processJob(
    job: MeetingProcessingJobRecord
  ): Promise<MeetingProcessingJobRecord> {
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    if (this.stopping) abortController.abort();
    if (await this.oneShotService?.repository.isCancellationRequested(job.sessionId)) abortController.abort();
    const heartbeatTimer = setInterval(() => {
      void Promise.all([
        this.processingService.heartbeat(job.jobId, this.workerId),
        this.oneShotService?.repository.isCancellationRequested(job.sessionId) ?? false,
      ]).then(([owned, cancelled]) => {
        if (!owned || cancelled) {
          log.warn({ event: "lease-lost", workerId: this.workerId, jobId: job.jobId });
          abortController.abort();
        }
      }).catch((error) => {
        log.warn({
          event: "heartbeat-failed",
          workerId: this.workerId,
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.heartbeatIntervalMs);
    heartbeatTimer.unref();
    try {
      const result = await this.processingService.processClaimedJob(
        job,
        this.workerId,
        abortController.signal
      );
      log.info({
        event: "job-finished",
        workerId: this.workerId,
        jobType: "audio-processing",
        jobId: job.jobId,
        status: result.status,
        errorCode: result.errorCode,
      });
      return result;
    } finally {
      notifyMeetingStateChanged();
      clearInterval(heartbeatTimer);
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
      await this.oneShotService?.settleCancellation(job.sessionId);
      await this.oneShotService?.settleTerminalFailure(job.sessionId);
    }
  }

  private async processTranscriptionJob(
    job: MeetingTranscriptionJobRecord
  ): Promise<void> {
    if (!this.transcriptionService) return;
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    if (this.stopping) abortController.abort();
    if (await this.oneShotService?.repository.isCancellationRequested(job.sessionId)) abortController.abort();
    const heartbeatTimer = setInterval(() => {
      void this.transcriptionService!.heartbeat(job.jobId, this.workerId).then((owned) => {
        if (!owned) {
          log.warn({
            event: "lease-lost",
            workerId: this.workerId,
            jobType: "transcription",
            jobId: job.jobId,
          });
          abortController.abort();
        }
      }).catch((error) => {
        log.warn({
          event: "heartbeat-failed",
          workerId: this.workerId,
          jobType: "transcription",
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.heartbeatIntervalMs);
    heartbeatTimer.unref();
    try {
      await this.liveTranscriptionService?.seal(job.sessionId);
      const result = await this.transcriptionService.processClaimedJob(
        job,
        this.workerId,
        abortController.signal
      );
      log.info({
        event: "job-finished",
        workerId: this.workerId,
        jobType: "transcription",
        jobId: job.jobId,
        status: result.status,
        errorCode: result.errorCode,
      });
    } finally {
      notifyMeetingStateChanged();
      clearInterval(heartbeatTimer);
      if (this.currentAbortController === abortController) {
        this.currentAbortController = null;
      }
      await this.oneShotService?.settleCancellation(job.sessionId);
      await this.oneShotService?.settleTerminalFailure(job.sessionId);
    }
  }

  private async processMinutesJob(job: MeetingMinutesJobRecord): Promise<void> {
    if (!this.minutesService) return;
    const abortController = new AbortController();
    this.minutesAbortController = abortController;
    if (this.stopping) abortController.abort();
    if (await this.oneShotService?.repository.isCancellationRequested(job.sessionId)) abortController.abort();
    const heartbeatTimer = setInterval(() => {
      void this.minutesService!.heartbeat(job.jobId, this.workerId).then((owned) => {
        if (!owned) {
          log.warn({
            event: "lease-lost",
            workerId: this.workerId,
            jobType: "meeting-minutes",
            jobId: job.jobId,
          });
          abortController.abort();
        }
      }).catch((error) => {
        log.warn({
          event: "heartbeat-failed",
          workerId: this.workerId,
          jobType: "meeting-minutes",
          jobId: job.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.heartbeatIntervalMs);
    heartbeatTimer.unref();
    let completed = false;
    try {
      const result = await this.minutesService.processClaimedJob(
        job,
        this.workerId,
        abortController.signal
      );
      completed = result.status === "ready";
      log.info({
        event: "job-finished",
        workerId: this.workerId,
        jobType: "meeting-minutes",
        jobId: job.jobId,
        status: result.status,
        errorCode: result.errorCode,
      });
    } finally {
      notifyMeetingStateChanged();
      clearInterval(heartbeatTimer);
      if (this.minutesAbortController === abortController) {
        this.minutesAbortController = null;
      }
      await this.oneShotService?.settleCancellation(job.sessionId);
      await this.oneShotService?.settleTerminalFailure(job.sessionId);
      if (completed && !this.stopping) await this.oneShotService?.reconcileMinutesCompletion(job.sessionId);
    }
  }

  private async cleanupArtifactsSafely(): Promise<void> {
    try {
      const [activeTranscriptionSessions, activeMinutesSessions, oneShotSessions] = await Promise.all([
        this.transcriptionService?.listActiveSessionIds() ?? [],
        this.minutesService?.listActiveSessionIds() ?? [],
        this.oneShotService?.repository.protectedSessionIds() ?? [],
      ]);
      const protectedSessionIds = new Set([
        ...activeTranscriptionSessions,
        ...activeMinutesSessions,
        ...oneShotSessions,
      ]);
      const result = await this.processingService.cleanupArtifacts(protectedSessionIds);
      if (result.deletedJobIds.length > 0) {
        log.info({ event: "artifact-cleanup", workerId: this.workerId, ...result });
      }
    } catch (error) {
      log.warn({
        event: "artifact-cleanup-failed",
        workerId: this.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.runOnce()
        .then((processed) => this.schedule(processed ? 0 : this.pollIntervalMs))
        .catch((error) => {
          log.error({
            event: "poll-failed",
            workerId: this.workerId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
  }
}
