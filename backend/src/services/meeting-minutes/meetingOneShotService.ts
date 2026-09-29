import { notifyMeetingStateChanged } from "../../events/meetingStateEvents";
import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";
import { createLogger } from "../../observability/logger";
import { meetingOneShotRepository, type MeetingDeviceRequestMetadata, type MeetingOneShotRepository, type MeetingOneShotSession } from "../../storage/meeting-minutes/meetingOneShotRepository";
import { meetingSummaryArchiveRepository, type MeetingSummaryArchiveRepository } from "../../storage/meeting-minutes/meetingSummaryArchiveRepository";
import { meetingRecordingStorageService, type MeetingRecordingStorageService } from "./meetingRecordingStorageService";
import { meetingProcessingService, type MeetingProcessingService } from "./meetingProcessingService";
import { meetingTranscriptionService, type MeetingTranscriptionService } from "./meetingTranscriptionService";
import { meetingMinutesService, type MeetingMinutesService } from "./meetingMinutesService";
import { renderMeetingMinutesHtml } from "./meetingMinutesHtmlRenderer";
import { MEETING_MINUTES_INPUT_LIMITS } from "./meetingMinutesSchema";
import { compareMeetingSummaryRevision } from "./meetingSummaryRevisionChanges";
import { meetingLiveTranscriptionRepository, type MeetingLiveTranscriptionRepository } from "../../storage/meeting-minutes/meetingLiveTranscriptionRepository";
import { liveTranscriptionProfile, meetingLiveTranscriptionService, type MeetingLiveTranscriptionService } from "./meetingLiveTranscriptionService";
import { meetingTranscriptionProvider } from "./meetingTranscriptionProviderFactory";
import { meetingMinutesProvider } from "./meetingMinutesProviderFactory";

interface Dependencies {
  checkRuntimeReadiness?: () => Promise<boolean>;
  liveService?: MeetingLiveTranscriptionService;
  liveRepository?: MeetingLiveTranscriptionRepository;
  repository?: MeetingOneShotRepository;
  archive?: MeetingSummaryArchiveRepository;
  recordings?: MeetingRecordingStorageService;
  processing?: MeetingProcessingService;
  transcription?: MeetingTranscriptionService;
  minutes?: MeetingMinutesService;
  processingDir?: string;
  deliveryMs?: number;
  cleanupEnabled?: boolean;
  maxPipelines?: number;
  recorderLeaseMs?: number;
  now?: () => Date;
}

interface MeetingAdminJobState {
  status: "pending" | "running" | "ready" | "failed";
  attemptCount: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
}

interface MeetingAdminJobSet {
  processing: MeetingAdminJobState | null;
  transcription: MeetingAdminJobState | null;
  minutes: MeetingAdminJobState | null;
}

const log = createLogger("meeting-one-shot");

export class MeetingOneShotService {
  private readonly liveService;
  private readonly liveRepository;
  readonly repository: MeetingOneShotRepository;
  readonly archive: MeetingSummaryArchiveRepository;
  private readonly recordings: MeetingRecordingStorageService;
  private readonly processing: MeetingProcessingService;
  private readonly transcription: MeetingTranscriptionService;
  private readonly minutes: MeetingMinutesService;
  private readonly processingDir: string;
  private readonly deliveryMs: number;
  private readonly cleanupEnabled: boolean;
  private readonly maxPipelines: number;
  private readonly recorderLeaseMs: number;
  private readonly now: () => Date;
  private readonly checkRuntimeReadiness: () => Promise<boolean>;
  private advancing: Promise<void> | null = null;
  private cleaning: Promise<void> | null = null;

  constructor(deps: Dependencies = {}) {
    this.liveService = deps.liveService ?? meetingLiveTranscriptionService;
    this.liveRepository = deps.liveRepository ?? meetingLiveTranscriptionRepository;
    this.repository = deps.repository ?? meetingOneShotRepository;
    this.archive = deps.archive ?? meetingSummaryArchiveRepository;
    this.recordings = deps.recordings ?? meetingRecordingStorageService;
    this.processing = deps.processing ?? meetingProcessingService;
    this.transcription = deps.transcription ?? meetingTranscriptionService;
    this.minutes = deps.minutes ?? meetingMinutesService;
    this.processingDir = path.resolve(deps.processingDir ?? env.MEETING_PROCESSING_DIR);
    this.deliveryMs = deps.deliveryMs ?? env.MEETING_ONE_SHOT_DELIVERY_MS;
    this.cleanupEnabled = deps.cleanupEnabled ?? env.MEETING_RECORDING_CLEANUP_ENABLED;
    this.maxPipelines = deps.maxPipelines ?? env.MEETING_ONE_SHOT_MAX_ACTIVE_PIPELINES;
    this.recorderLeaseMs = deps.recorderLeaseMs ?? env.MEETING_RECORDER_LEASE_MS;
    this.now = deps.now ?? (() => new Date());
    this.checkRuntimeReadiness = deps.checkRuntimeReadiness ?? (async () =>
      await this.repository.workerReady(this.workerProfile(), this.now().toISOString()) &&
      (meetingTranscriptionProvider.checkReady ? await meetingTranscriptionProvider.checkReady() : meetingTranscriptionProvider.enabled));
  }

  private workerProfile() {
    return `${liveTranscriptionProfile(meetingTranscriptionProvider)}:${meetingMinutesProvider.name}:${meetingMinutesProvider.model}`;
  }

  async heartbeatWorker(workerId: string) {
    const now = this.now();
    await this.repository.heartbeatWorker(workerId, this.workerProfile(), now.toISOString(), new Date(now.getTime()+15_000).toISOString());
  }

  async releaseWorker(workerId: string) {
    await this.repository.releaseWorker(workerId);
    notifyMeetingStateChanged();
  }

  async availability() {
    const stats = await this.archive.stats();
    const admission = await this.repository.admissionStats(this.maxPipelines, this.now().toISOString());
    const full = stats.bytes >= stats.maxBytes || await this.repository.hasArchiveCapacityFailure();
    const providersReady = this.cleanupEnabled && this.processing.workerEnabled && this.transcription.providerEnabled && this.minutes.providerEnabled && await this.checkRuntimeReadiness();
    const demoProvidersDisabled = env.DEMO_MODE && (
      !env.MEETING_WORKER_ENABLED ||
      env.MEETING_TRANSCRIPTION_PROVIDER === "disabled" ||
      env.MEETING_MINUTES_PROVIDER === "disabled"
    );
    return { mode: "one-shot" as const, available: !full && providersReady,
      reason: full ? "MEETING_SUMMARY_ARCHIVE_FULL" : providersReady ? null : demoProvidersDisabled ? "DEMO_MEETING_DISABLED" : "MEETING_ONE_SHOT_PROVIDER_NOT_READY",
      deliveryMs: this.deliveryMs, admission };
  }

  async create(ownerId: string, title: string | undefined, sourceIds: string[], additionalSectionRequest: unknown = "", recorderId = "legacy", metadata?: MeetingDeviceRequestMetadata) {
    if (typeof additionalSectionRequest !== "string" || additionalSectionRequest.length > MEETING_MINUTES_INPUT_LIMITS.additionalSectionRequest) {
      throw new HttpError(400, "額外段落要求必須是文字，最多 2,000 字元。", "MEETING_ADDITIONAL_SECTIONS_INVALID");
    }
    const availability = await this.availability();
    if (!availability.available) throw new HttpError(503, availability.reason === "MEETING_SUMMARY_ARCHIVE_FULL"
      ? "摘要庫容量已滿，請聯絡開發者處理。" : "會議處理服務尚未就緒，請稍後重試或聯絡開發者。", availability.reason!);
    const session = await this.recordings.createSession({ ownerId, title, sourceIds, deliveryMode: "one-shot" });
    let candidateExists = true;
    try {
      const registered = await this.repository.registerForOwner({ sessionId: session.sessionId, ownerId, title: session.title,
        createdAt: session.createdAt, additionalSectionRequest: additionalSectionRequest.trim(), recorderId,
        recorderLeaseUntil: new Date(Date.parse(session.createdAt) + this.recorderLeaseMs).toISOString(),
        maxPipelines: this.maxPipelines, metadata });
      if (registered.created) return { session, reused: false };
      await this.recordings.abortSession(session.sessionId, ownerId);
      candidateExists = false;
      return { session: await this.recordings.getSession(registered.session.sessionId, ownerId), reused: true };
    }
    catch (error) {
      if (candidateExists) await this.recordings.abortSession(session.sessionId, ownerId).catch(() => undefined);
      throw error;
    }
  }

  async current(ownerId: string, recorderId: string | null = null, metadata?: MeetingDeviceRequestMetadata) {
    const current = await this.repository.currentForOwnerContext(ownerId, this.now().toISOString(), recorderId, metadata);
    if (!current) return { source: null, sessionId: null };
    return {
      source: current.source ? {
        displayName: current.source.displayName,
        lastSeenAt: current.source.lastSeenAt,
      } : null,
      sessionId: current.session.sessionId,
    };
  }

  async assertRecorder(sessionId: string, ownerId: string, recorderId: string): Promise<void> {
    const entry = await this.requireEntry(sessionId, ownerId);
    if (entry.cancelRequestedAt) {
      throw new HttpError(409, "這場會議正在取消，不能再上傳或完成錄音。", "MEETING_CANCEL_IN_PROGRESS");
    }
    if (entry.deviceSessionReleasedAt || !recorderId || entry.recorderId !== recorderId) {
      throw new HttpError(409, "這場會議正在另一個分頁錄音，這個分頁只能查看進度。", "MEETING_RECORDER_LEASE_NOT_OWNER");
    }
  }

  async renewRecorderLease(sessionId: string, ownerId: string, recorderId: string): Promise<void> {
    const now = this.now();
    await this.repository.renewRecorderLease({
      sessionId,
      ownerId,
      recorderId,
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + this.recorderLeaseMs).toISOString(),
      maxPipelines: this.maxPipelines,
    });
  }

  markRecordingFinalized(sessionId: string, ownerId: string): Promise<void> {
    return this.repository.markRecordingFinalized(sessionId, ownerId, this.now().toISOString(), this.maxPipelines);
  }

  async finalizeRecording<T>(sessionId: string, ownerId: string, recorderId: string,
    finalize: () => Promise<T>): Promise<T> {
    const leaseUntil = () => new Date(this.now().getTime() + this.recorderLeaseMs).toISOString();
    const leaseId = await this.repository.acquireFinalizationLease(sessionId, ownerId, recorderId,
      this.now().toISOString(), leaseUntil(), this.maxPipelines);
    let renewal: Promise<void> | null = null;
    const heartbeat = setInterval(() => {
      if (renewal) return;
      renewal = this.repository.renewFinalizationLease(leaseId, leaseUntil(), this.now().toISOString())
        .catch(error => { log.warn({ event: "finalize-lease-renewal-failed", sessionId, error: String(error) }); })
        .finally(() => { renewal = null; });
    }, Math.floor(this.recorderLeaseMs / 3));
    try {
      const result = await finalize();
      await this.markRecordingFinalized(sessionId, ownerId);
      return result;
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await this.repository.releaseFinalizationLease(leaseId);
    }
  }

  async releaseCurrent(sessionId: string, ownerId: string): Promise<void> {
    const entry = await this.requireEntry(sessionId, ownerId);
    if (entry.revisionJobId && entry.expiresAt && entry.expiresAt > this.now().toISOString()) throw new HttpError(409, "請先採用或放棄修訂，再開始下一場。", "MEETING_REVISION_PENDING");
    const state = await this.status(sessionId, ownerId);
    if (!["ready", "failed", "expired", "cancelled", "interrupted"].includes(state.phase)) {
      throw new HttpError(409, "會議仍在錄音或處理中，尚不能開始下一場。", "MEETING_ONE_SHOT_STILL_ACTIVE");
    }
    await this.repository.releaseCurrent(sessionId, ownerId, this.now().toISOString(), state.phase !== "ready");
  }

  async listMeetings() {
    const now = this.now().toISOString();
    const [entries, occupyingSessionIds, execution] = await Promise.all([
      this.repository.listManagedSessions(),
      this.repository.listOccupyingSessionIds(now),
      this.repository.executionSessionIds(now),
    ]);
    const jobs = await this.loadAdminJobs(entries.map(entry => entry.sessionId));
    return {
      meetings: await Promise.all(entries.map(entry => this.adminMeeting(
        entry,
        jobs.get(entry.sessionId),
        occupyingSessionIds.has(entry.sessionId), execution
      ))),
      stats: { activeMeetings: occupyingSessionIds.size, maxMeetings: this.maxPipelines },
    };
  }

  async getMeetingForAdmin(sessionId: string) {
    const entry = await this.repository.get(sessionId);
    if (!entry) throw new HttpError(404, "找不到會議。", "MEETING_ONE_SHOT_NOT_FOUND");
    const jobs = await this.loadAdminJobs([sessionId]);
    const now = this.now().toISOString();
    const occupiesSlot = (await this.repository.listOccupyingSessionIds(now)).has(sessionId);
    return this.adminMeeting(entry, jobs.get(sessionId), occupiesSlot, await this.repository.executionSessionIds(now));
  }

  async cancelMeeting(sessionId: string) {
    const entry = await this.repository.get(sessionId);
    if (!entry) throw new HttpError(404, "找不到會議。", "MEETING_ONE_SHOT_NOT_FOUND");
    await this.repository.requestCancellation(sessionId, this.now().toISOString());
    const recording = await this.recordings.getSession(sessionId, entry.ownerId).catch(() => null);
    if (recording?.status === "recording") {
      await this.recordings.abortSession(sessionId, entry.ownerId).catch(error => {
        if (!(error instanceof HttpError && error.code === "MEETING_RECORDING_ALREADY_FINALIZED")) throw error;
      });
    }
    return this.getMeetingForAdmin(sessionId);
  }

  async settleCancellation(sessionId: string): Promise<boolean> {
    if (!await this.repository.isCancellationRequested(sessionId)) return false;
    // This runs in the worker process so cleanupSession can seal and await any
    // live inference owned by that process before the admission slot is released.
    await this.liveService.cleanupSession(sessionId);
    await Promise.all([
      this.processing.cancelPendingForSession(sessionId),
      this.transcription.cancelPendingForSession(sessionId),
      this.minutes.cancelPendingForSession(sessionId),
    ]);
    return this.repository.completeCancellationIfIdle(sessionId, this.now().toISOString());
  }

  async retryMeeting(sessionId: string) {
    const entry = await this.repository.get(sessionId);
    if (!entry) throw new HttpError(404, "找不到會議。", "MEETING_ONE_SHOT_NOT_FOUND");
    const state = await this.status(sessionId, entry.ownerId);
    const failed = state.minutes?.status === "failed" ? { kind: "minutes" as const, id: state.minutes.jobId }
      : state.transcription?.status === "failed" ? { kind: "transcription" as const, id: state.transcription.jobId }
        : state.processing?.status === "failed" ? { kind: "processing" as const, id: state.processing.jobId }
          : null;
    if (!failed) throw new HttpError(409, "這場會議目前沒有可重試的失敗工作。", "MEETING_RETRY_INVALID");
    if (failed.kind === "minutes") await this.retryMinutesJob(sessionId, entry.ownerId, failed.id);
    else if (failed.kind === "transcription") await this.retryTranscriptionJob(sessionId, entry.ownerId, failed.id);
    else await this.retryProcessingJob(sessionId, entry.ownerId, failed.id);
    return this.getMeetingForAdmin(sessionId);
  }

  retryProcessingJob(sessionId: string, ownerId: string, jobId: string) {
    return this.retryWithAdmission(sessionId, ownerId, () => this.processing.retry(jobId, ownerId, true));
  }

  retryTranscriptionJob(sessionId: string, ownerId: string, jobId: string) {
    return this.retryWithAdmission(sessionId, ownerId, () => this.transcription.retry(jobId, ownerId, true));
  }

  retryMinutesJob(sessionId: string, ownerId: string, jobId: string) {
    return this.retryWithAdmission(sessionId, ownerId, () => this.minutes.retry(jobId, ownerId, true));
  }

  async status(sessionId: string, ownerId: string) {
    const entry = await this.requireEntry(sessionId, ownerId);
    const now = this.now().toISOString();
    const admission = await this.repository.admissionStats(this.maxPipelines, now);
    if (entry.cancelledAt) {
      return { phase: "cancelled" as const, expiresAt: entry.expiresAt, errorCode: "MEETING_CANCELLED", errorMessage: null,
        retryAvailable: false, processing: null, transcription: null, minutes: null, admission };
    }
    if (entry.expiresAt && entry.expiresAt <= this.now().toISOString()) {
      return { phase: "expired", expiresAt: entry.expiresAt, errorCode: null, errorMessage: null,
        retryAvailable: false, processing: null, transcription: null, minutes: null, admission };
    }
    const processing = await this.processing.getJobForSession(sessionId, ownerId);
    const liveTranscription = await this.liveRepository.progress(sessionId, liveTranscriptionProfile(meetingTranscriptionProvider));
    const transcription = await this.transcription.getJobForSession(sessionId, ownerId);
    const automatic = entry.expiresAt ? await this.deliveredMinutes(entry)
      : transcription ? await this.autoMinutes(entry, transcription, false) : null;
    const revision = entry.revisionJobId ? await this.revisionForDelivery(entry.revisionJobId, ownerId) : null;
    const currentJob = automatic ?? transcription ?? processing;
    const failed = currentJob?.status === "failed" ? currentJob : null;
    const terminalFailure = failed && failed.attemptCount >= failed.maxAttempts;
    const recordingFinalized = !currentJob && !entry.expiresAt
      ? (await this.recordings.getSession(sessionId, ownerId).catch(() => null))?.status === "finalized"
      : false;
    if (recordingFinalized && !entry.recordingFinalizedAt) {
      await this.repository.markRecordingFinalized(sessionId, ownerId, now, this.maxPipelines);
    }
    const recorderLeaseActive = Boolean(entry.recorderLeaseUntil && entry.recorderLeaseUntil > now);
    const execution = await this.repository.executionSessionIds(now);
    return { phase: entry.cancelRequestedAt ? "cancelling" : entry.expiresAt ? "ready" : terminalFailure || (entry.pipelineReleasedAt && entry.errorCode) ? "failed" : automatic ? "summarizing" : transcription ? "transcribing" : processing || recordingFinalized || entry.recordingFinalizedAt ? "processing" : execution.finalizing.has(sessionId) ? "finalizing" : recorderLeaseActive ? "recording" : execution.live.has(sessionId) ? "transcribing" : "interrupted",
      additionalSectionRequest: entry.additionalSectionRequest, liveTranscription,
      retryAvailable: Boolean(entry.pipelineReleasedAt && terminalFailure),
      expiresAt: entry.expiresAt, errorCode: entry.errorCode ?? failed?.errorCode ?? null,
      errorMessage: entry.errorMessage ?? failed?.errorMessage ?? null, processing, transcription, minutes: automatic, revision, admission };
  }

  async requestRevision(sessionId: string, ownerId: string, input: { baseVersionId: unknown; request: unknown; clientRequestKey: unknown; confirmedFacts?: unknown }) {
    await this.assertAccess(sessionId, ownerId, false);
    const facts = input.confirmedFacts ?? "";
    if (typeof input.request !== "string" || typeof facts !== "string" || (!input.request.trim() && !facts.trim()) || input.request.length > 2000 || facts.length > 2000 || typeof input.baseVersionId !== "string"
      || typeof input.clientRequestKey !== "string" || !input.clientRequestKey.trim() || input.clientRequestKey.length > 100) {
      throw new HttpError(400, "請提供採用版本、修訂內容（最多 2,000 字元）及請求編號。", "MEETING_REVISION_INPUT_INVALID");
    }
    const entry = await this.requireEntry(sessionId, ownerId);
    if (!entry.expiresAt) throw new HttpError(409, "摘要尚未完成，暫時不能修訂。", "MEETING_REVISION_NOT_READY");
    const base = await this.minutes.getVersion(input.baseVersionId, ownerId);
    if (!base || base.sessionId !== sessionId) throw new HttpError(404, "找不到摘要版本。", "MEETING_MINUTES_VERSION_NOT_FOUND");
    await this.deliveredMinutes(entry);
    const baseJob = await this.minutes.getJob(base.jobId, ownerId);
    if (!baseJob) throw new HttpError(409, "摘要來源已無法取得。", "MEETING_REVISION_NOT_READY");
    const result = await this.minutes.enqueue({ sessionId, ownerId, clientRequestKey: `revision:${input.clientRequestKey.trim()}`,
      humanInput: { ...baseJob.input, title: base.record.title, date: base.record.date,
        revisionRequest: input.request.trim() || "請依明確人工確認事實補充摘要。", previousSummary: JSON.stringify(base.record),
        revisionConfirmedFacts: facts.trim(),
        confirmedFacts: [baseJob.input.confirmedFacts, baseJob.input.revisionConfirmedFacts].filter(Boolean).join("\n"),
        revisionHistory: [baseJob.input.revisionHistory, baseJob.input.revisionRequest].filter(Boolean).join("\n\n"),
        otherNotes: baseJob.input.revisionRequest
          ? baseJob.input.otherNotes.split(/(?:^|\n\n)使用者修訂要求：\n/)[0]!
          : baseJob.input.otherNotes },
      deliveryRevision: { baseVersionId: base.versionId, maxPending: 2 } });
    if (result.created) notifyMeetingStateChanged();
    return result.job;
  }

  async adoptRevision(sessionId: string, ownerId: string, jobId: string, expectedVersionId: unknown, acknowledgementToken?: unknown) {
    await this.assertAccess(sessionId, ownerId, false);
    if (typeof expectedVersionId !== "string") throw new HttpError(400, "請提供目前採用版本。", "MEETING_REVISION_INPUT_INVALID");
    const job = await this.minutes.getJob(jobId, ownerId);
    if (!job || job.sessionId !== sessionId || !job.clientRequestKey.startsWith("revision:")) throw new HttpError(404, "找不到修訂工作。", "MEETING_MINUTES_JOB_NOT_FOUND");
    const version = job.status === "ready" ? job.version : null;
    if (!version) throw new HttpError(409, "修訂版尚未完成。", "MEETING_REVISION_NOT_READY");
    await this.archive.publish({ sessionId, versionNumber: version.versionNumber, title: version.record.title,
      meetingDate: version.record.date, generatedAt: version.generatedAt,
      html: renderMeetingMinutesHtml({ record: version.record, versionNumber: version.versionNumber,
        generatedAt: version.generatedAt, audioFiles: [], includeAudio: false }) }, this.now().toISOString(),
    { ownerId, expectedVersionId, versionId: version.versionId, jobId, acknowledgementToken });
    notifyMeetingStateChanged();
    return this.status(sessionId, ownerId);
  }

  async discardRevision(sessionId: string, ownerId: string, jobId: string) {
    await this.assertAccess(sessionId, ownerId, false);
    await this.repository.discardRevision(sessionId, ownerId, jobId, this.now().toISOString());
  }

  private async revisionForDelivery(jobId: string, ownerId: string) {
    const job = await this.minutes.getJob(jobId, ownerId);
    if (!job || job.status !== "ready" || !job.version) return job;
    const base = job.revisionBaseVersionId ? await this.minutes.getVersion(job.revisionBaseVersionId, ownerId) : null;
    if (!base || base.sessionId !== job.sessionId) return { ...job, revisionChanges: null, revisionComparisonError: "修訂來源版本缺失，請放棄後重新產生。" };
    return { ...job, revisionChanges: compareMeetingSummaryRevision(base.versionId, job.version.versionId, base.record, job.version.record) };
  }

  private async deliveredMinutes(entry: MeetingOneShotSession) {
    if (entry.adoptedVersionId) {
      const version = await this.minutes.getVersion(entry.adoptedVersionId, entry.ownerId);
      return version ? this.minutes.getJob(version.jobId, entry.ownerId) : null;
    }
    // 升級前的完成會議依已歸檔版本定位，不能採用未確認的最新版本。
    const archived = await this.archive.get(entry.sessionId);
    if (!archived) return null;
    const versions = await this.minutes.listVersions(entry.sessionId, entry.ownerId, 100);
    const version = versions.find(item => item.versionNumber === archived.versionNumber);
    if (!version) return null;
    await this.repository.pinDeliveredVersion(entry.sessionId, version.versionId);
    return this.minutes.getJob(version.jobId, entry.ownerId);
  }

  async assertAccess(sessionId: string, ownerId: string, mutation: boolean): Promise<MeetingOneShotSession | null> {
    const entry = await this.repository.get(sessionId);
    if (!entry) return null;
    if (entry.ownerId !== ownerId) throw new HttpError(404, "找不到錄音 session。", "MEETING_RECORDING_NOT_FOUND");
    if (entry.cleanupStartedAt || (entry.expiresAt && entry.expiresAt <= this.now().toISOString())) {
      throw new HttpError(410, "這筆會議的下載期限已到，請使用已下載的檔案。", "MEETING_ONE_SHOT_EXPIRED");
    }
    if (mutation && entry.cancelRequestedAt) {
      throw new HttpError(409, "這場會議正在取消，不能再建立新的處理工作。", "MEETING_CANCEL_IN_PROGRESS");
    }
    if (mutation && entry.expiresAt) throw new HttpError(409, "這筆一次性會議已產出，請下載保存。", "MEETING_ONE_SHOT_COMPLETED");
    return entry;
  }

  advance(): Promise<void> {
    this.advancing ??= this.advanceInternal().finally(() => { this.advancing = null; });
    return this.advancing;
  }

  async reconcileMinutesCompletion(sessionId: string): Promise<void> {
    await this.advancing;
    await this.repository.checked(sessionId, this.now().toISOString());
    await this.advance();
  }

  private async advanceInternal(): Promise<void> {
    await this.repository.expireRecorderLeases(this.now().toISOString());
    for (const sessionId of await this.repository.listPendingCancellations()) {
      await this.settleCancellation(sessionId).catch(error => {
        log.warn({ event: "cancel-settlement-failed", sessionId, error: error instanceof Error ? error.message : String(error) });
      });
    }
    for (const entry of await this.repository.due(this.now().toISOString())) {
      const nextCheck = new Date(this.now().getTime() + 2_000).toISOString();
      try {
        if (!entry.expiresAt && !entry.cleanupStartedAt) {
          const session = await this.recordings.getSession(entry.sessionId, entry.ownerId);
          if (session.status === "finalized") {
            if (!entry.recordingFinalizedAt) {
              await this.repository.markRecordingFinalized(entry.sessionId, entry.ownerId, this.now().toISOString(), this.maxPipelines);
            }
            const processing = await this.processing.enqueue(entry.sessionId, entry.ownerId);
            if (processing.job.status === "ready" && this.transcription.providerEnabled) {
              const transcription = await this.transcription.enqueueFromProcessingJob(processing.job);
              if (transcription.job.status === "ready" && this.minutes.providerEnabled) {
                const job = await this.autoMinutes(entry, transcription.job, true);
                if (job?.status === "ready" && job.version) {
                  const version = job.version;
                  const item = await this.archive.publish({ sessionId: entry.sessionId, versionNumber: version.versionNumber,
                    title: version.record.title, meetingDate: version.record.date, generatedAt: version.generatedAt,
                    html: renderMeetingMinutesHtml({ record: version.record, versionNumber: version.versionNumber,
                      generatedAt: version.generatedAt, audioFiles: [], includeAudio: false }) }, this.now().toISOString());
                  const delivered = await this.repository.publishDelivery(entry.sessionId, item.archivedAt,
                    new Date(Date.parse(item.archivedAt) + this.deliveryMs).toISOString(), version.versionId);
                  if (delivered) {
                    await this.liveService.cleanupSession(entry.sessionId).catch(async error => {
                      log.warn({ event: "delivery-live-cleanup-failed", sessionId: entry.sessionId, error: error instanceof Error ? error.message : String(error) });
                      await this.liveService.releaseSessionState(entry.sessionId).catch(() => undefined);
                    });
                  }
                }
              }
            }
          }
        }
        await this.repository.checked(entry.sessionId, nextCheck);
      } catch (error) {
        if (error instanceof HttpError && error.code === "MEETING_RECORDING_NOT_FOUND" && !entry.expiresAt) {
          try {
            await this.liveService.cleanupSession(entry.sessionId);
            await this.repository.forgetMissing(entry.sessionId);
          } catch (cleanupError) {
            await this.repository.checked(entry.sessionId, new Date(this.now().getTime()+30_000).toISOString(),
              "MEETING_LIVE_CLEANUP_FAILED", String(cleanupError));
            log.warn({ event:"live-cleanup-failed",sessionId:entry.sessionId,error:String(cleanupError) });
          }
          continue;
        }
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "MEETING_ONE_SHOT_ADVANCE_FAILED";
        await this.repository.checked(entry.sessionId, nextCheck, code, error instanceof Error ? error.message : "會議處理暫時失敗。");
        log.warn({ event: "advance-failed", sessionId: entry.sessionId, code });
      }
    }
  }

  private async autoMinutes(entry: MeetingOneShotSession, transcription: Awaited<ReturnType<MeetingTranscriptionService["getJobForSession"]>>, create: boolean) {
    if (!transcription || transcription.status !== "ready") return null;
    const artifact = transcription.artifacts.find(item => item.type === "transcript-merged-json");
    if (!artifact) return null;
    const key = `one-shot:${transcription.jobId}:${createHash("sha256").update(artifact.sha256).digest("hex").slice(0, 16)}`;
    if (!create) return this.minutes.getJobByRequestKey(entry.sessionId, entry.ownerId, key);
    const result = await this.minutes.enqueue({ sessionId: entry.sessionId, ownerId: entry.ownerId,
      clientRequestKey: key, humanInput: { title: entry.title, date: entry.createdAt.slice(0, 10), additionalSectionRequest: entry.additionalSectionRequest } });
    if (result.created) notifyMeetingStateChanged();
    return result.job;
  }

  private async loadAdminJobs(sessionIds: string[]): Promise<Map<string, MeetingAdminJobSet>> {
    const [processing, transcription, minutes] = await Promise.all([
      this.processing.listJobStatesForSessions(sessionIds),
      this.transcription.listJobStatesForSessions(sessionIds),
      this.minutes.listJobStatesForSessions(sessionIds),
    ]);
    const states = new Map<string, MeetingAdminJobSet>(sessionIds.map(sessionId => [sessionId, {
      processing: null, transcription: null, minutes: null,
    }]));
    for (const job of processing) states.get(job.sessionId)!.processing = job;
    for (const job of transcription) states.get(job.sessionId)!.transcription = job;
    for (const job of minutes) states.get(job.sessionId)!.minutes = job;
    return states;
  }

  private async adminMeeting(
    entry: MeetingOneShotSession,
    jobs: MeetingAdminJobSet | undefined,
    occupiesSlot: boolean,
    execution: { live: Set<string>; finalizing: Set<string> }
  ) {
    const currentJob = jobs?.minutes ?? jobs?.transcription ?? jobs?.processing ?? null;
    const terminalFailure = currentJob?.status === "failed" && currentJob.attemptCount >= currentJob.maxAttempts;
    let phase: "recording" | "interrupted" | "finalizing" | "processing" | "transcribing" | "summarizing" | "cancelling" | "cancelled" | "ready" | "failed" | "expired" | "unknown";
    let statusError: unknown = null;
    if (entry.cancelledAt) phase = "cancelled";
    else if (entry.cancelRequestedAt) phase = "cancelling";
    else if (entry.expiresAt && entry.expiresAt <= this.now().toISOString()) phase = "expired";
    else if (entry.expiresAt) phase = "ready";
    else if (terminalFailure || entry.pipelineReleasedAt) phase = "failed";
    else if (jobs?.minutes) phase = "summarizing";
    else if (jobs?.transcription) phase = "transcribing";
    else if (jobs?.processing) phase = "processing";
    else if (execution.finalizing.has(entry.sessionId)) phase = "finalizing";
    else {
      try {
        const finalized = (await this.recordings.getSession(entry.sessionId, entry.ownerId)).status === "finalized";
        phase = finalized ? "processing" : entry.recorderLeaseUntil && entry.recorderLeaseUntil > this.now().toISOString() ? "recording" : execution.live.has(entry.sessionId) ? "transcribing" : "interrupted";
      } catch (error) {
        if (error instanceof HttpError && error.code === "MEETING_RECORDING_NOT_FOUND") phase = "interrupted";
        else {
          phase = "unknown";
          statusError = error;
        }
      }
    }
    return {
      sessionId: entry.sessionId,
      title: entry.title,
      createdAt: entry.createdAt,
      phase,
      occupiesSlot,
      errorCode: entry.errorCode ?? currentJob?.errorCode
        ?? (statusError && typeof statusError === "object" && "code" in statusError ? String(statusError.code) : statusError ? "MEETING_STATUS_UNAVAILABLE" : null),
      errorMessage: entry.errorMessage ?? currentJob?.errorMessage
        ?? (statusError instanceof Error ? statusError.message : statusError ? "無法讀取會議狀態。" : null),
      source: {
        displayName: entry.sourceName ?? "未命名來源",
        userAgent: entry.sourceUserAgent,
        ip: entry.sourceIp,
      },
      actions: {
        canCancel: !entry.pipelineReleasedAt && !entry.cancelledAt && !entry.cancelRequestedAt && !entry.cleanedAt,
        canRetry: Boolean(entry.pipelineReleasedAt && terminalFailure),
      },
    };
  }

  async settleTerminalFailure(sessionId: string): Promise<boolean> {
    const entry = await this.repository.get(sessionId);
    if (!entry || entry.pipelineReleasedAt || entry.cancelRequestedAt) return false;
    const state = await this.status(sessionId, entry.ownerId);
    const currentJob = state.minutes ?? state.transcription ?? state.processing;
    const terminal = currentJob?.status === "failed" && currentJob.attemptCount >= currentJob.maxAttempts;
    if (!terminal) return false;
    let liveCleanupFailed = false;
    await this.liveService.cleanupSession(sessionId).catch(error => {
      liveCleanupFailed = true;
      log.warn({ event: "terminal-live-cleanup-failed", sessionId, error: error instanceof Error ? error.message : String(error) });
    });
    const released = await this.repository.releaseTerminalFailure(sessionId, this.now().toISOString());
    if (liveCleanupFailed) await this.liveService.releaseSessionState(sessionId).catch(() => undefined);
    return released;
  }

  async settleTerminalFailures(): Promise<void> {
    for (const entry of await this.repository.listActivePipelines()) {
      await this.settleTerminalFailure(entry.sessionId);
    }
  }

  private async retryWithAdmission<T>(sessionId: string, ownerId: string, action: () => Promise<T>): Promise<T> {
    await this.repository.claimRetryAdmission(sessionId, ownerId, this.now().toISOString(), this.maxPipelines);
    try {
      return await action();
    } catch (error) {
      await this.repository.releaseRetryAdmissionIfIdle(sessionId, this.now().toISOString()).catch(() => false);
      throw error;
    }
  }

  cleanup(): Promise<void> {
    this.cleaning ??= this.cleanupInternal().finally(() => { this.cleaning = null; });
    return this.cleaning;
  }

  private async cleanupInternal(): Promise<void> {
    await Promise.all([this.processing.initialize(), this.transcription.initialize(), this.minutes.initialize(), this.archive.stats()]);
    for (const entry of await this.repository.expired(this.now().toISOString())) {
      try {
        if (!await this.repository.claimCleanup(entry.sessionId, this.now().toISOString())) continue;
        await this.liveService.cleanupSession(entry.sessionId);
        if (!await this.recordings.removeCompletedOneShot(entry.sessionId, entry.ownerId)) continue;
        if (!/^[0-9a-f-]{36}$/i.test(entry.sessionId)) throw new Error("Invalid one-shot cleanup identity");
        const directory = path.join(this.processingDir, entry.sessionId);
        const info = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (info?.isSymbolicLink()) throw new Error("Refusing one-shot cleanup symlink");
        await rm(directory, { recursive: true, force: true });
        await this.repository.finishCleanup(entry.sessionId, this.now().toISOString());
      } catch (error) {
        log.warn({ event: "cleanup-failed", sessionId: entry.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async requireEntry(sessionId: string, ownerId: string): Promise<MeetingOneShotSession> {
    const entry = await this.repository.get(sessionId);
    if (!entry || entry.ownerId !== ownerId) throw new HttpError(404, "找不到一次性會議。", "MEETING_ONE_SHOT_NOT_FOUND");
    return entry;
  }
}

export const meetingOneShotService = new MeetingOneShotService();
