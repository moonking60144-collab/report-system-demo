import { notifyMeetingStateChanged } from "../events/meetingStateEvents";
import { restyleMeetingMinutesHtml } from "../services/meeting-minutes/meetingMinutesDocumentStyles";
import { renderMeetingMinutesHtml } from "../services/meeting-minutes/meetingMinutesHtmlRenderer";
import express, { NextFunction, Request, Response, Router } from "express";
import path from "node:path";
import { env } from "../config/env";
import { createLogger } from "../observability/logger";
import {
  meetingRecordingOwnerAuth,
  type MeetingRecordingOwnerAuth,
} from "../services/meeting-minutes/meetingRecordingOwnerAuth";
import {
  meetingRecordingStorageService,
  type MeetingRecordingStorageService,
} from "../services/meeting-minutes/meetingRecordingStorageService";
import {
  meetingProcessingService,
  type MeetingProcessingService,
} from "../services/meeting-minutes/meetingProcessingService";
import {
  meetingTranscriptionService,
  type MeetingTranscriptionService,
} from "../services/meeting-minutes/meetingTranscriptionService";
import {
  meetingMinutesService,
  type MeetingMinutesService,
} from "../services/meeting-minutes/meetingMinutesService";

import type { MeetingProcessingJobRecord } from "../storage/meeting-minutes/meetingProcessingJobRepository";
import { meetingLegacyRecordingAccess, type MeetingLegacyRecordingAccess } from "../services/meeting-minutes/meetingLegacyRecordingAccess";
import type { MeetingTranscriptionJobRecord } from "../storage/meeting-minutes/meetingTranscriptionJobRepository";
import type {
  MeetingMinutesJobRecord,
  MeetingMinutesVersionRecord,
} from "../storage/meeting-minutes/meetingMinutesJobRepository";
import { HttpError, ValidationError } from "../utils/httpError";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";
import { meetingOneShotService, type MeetingOneShotService } from "../services/meeting-minutes/meetingOneShotService";
import { createMeetingSummaryArchiveRouter } from "./meetingSummaryArchive";

type MeetingReadSurface = "owner" | "recorder" | "admin";

interface MeetingRecordingRequestAccess {
  ownerId: string;
  surface: MeetingReadSurface;
}

export interface MeetingRecordingsRouterOptions {
  oneShotService?: MeetingOneShotService;
  legacyAccess?: MeetingLegacyRecordingAccess;
  verifyAdminToken?: (authorizationHeader: string | undefined) => { username: string };
  nowMs?: () => number;
}

const log = createLogger("meeting-recordings-route");

function deviceRequestMetadata(req: Request) {
  return {
    userAgent: req.header("user-agent") ?? null,
    ip: req.ip || req.socket.remoteAddress || null,
  };
}

function optionalMeetingRecorderId(req: Request): string | null {
  const value = String(req.header("x-meeting-recorder-id") ?? "").trim();
  if (!value) return null;
  if (value.length > 200) {
    throw new ValidationError("錄音分頁識別格式錯誤。", "MEETING_RECORDER_ID_INVALID");
  }
  return value;
}

function meetingRecorderId(req: Request): string {
  const value = optionalMeetingRecorderId(req);
  if (!value) throw new ValidationError("缺少有效的錄音分頁識別。", "MEETING_RECORDER_ID_REQUIRED");
  return value;
}

function recordingReadBase(surface: MeetingReadSurface): string {
  return surface === "admin"
    ? "/api/meetings/admin/legacy-recordings"
    : "/api/meetings/recordings";
}

function toPublicProcessingJob(
  job: MeetingProcessingJobRecord,
  surface: MeetingReadSurface = "owner"
) {
  const base = recordingReadBase(surface);
  if (surface !== "owner") {
    return {
      jobId: job.jobId,
      sessionId: job.sessionId,
      status: job.status,
      phase: job.phase,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      errorCode: job.errorCode,
      errorMessage: null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      artifacts: job.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        jobId: artifact.jobId,
        sessionId: artifact.sessionId,
        type: artifact.type,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        createdAt: artifact.createdAt,
        downloadUrl: `${base}/${encodeURIComponent(job.sessionId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
      })),
    };
  }
  const { ownerId: _ownerId, ...publicJob } = job;
  return {
    ...publicJob,
    artifacts: job.artifacts.map(({ relativePath: _relativePath, ...artifact }) => ({
      ...artifact,
      downloadUrl: `${base}/${encodeURIComponent(job.sessionId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
    })),
  };
}

function toPublicTranscriptionJob(
  job: MeetingTranscriptionJobRecord,
  surface: MeetingReadSurface = "owner"
) {
  const base = recordingReadBase(surface);
  if (surface !== "owner") {
    return {
      jobId: job.jobId,
      processingJobId: job.processingJobId,
      sessionId: job.sessionId,
      provider: job.provider,
      model: job.model,
      status: job.status,
      phase: job.phase,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      errorCode: job.errorCode,
      errorMessage: null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      artifacts: job.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        jobId: artifact.jobId,
        sessionId: artifact.sessionId,
        type: artifact.type,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        createdAt: artifact.createdAt,
        downloadUrl: `${base}/${encodeURIComponent(job.sessionId)}/transcription-artifacts/${encodeURIComponent(artifact.artifactId)}`,
      })),
    };
  }
  const { ownerId: _ownerId, ...publicJob } = job;
  return {
    ...publicJob,
    artifacts: job.artifacts.map(({ relativePath: _relativePath, ...artifact }) => ({
      ...artifact,
      downloadUrl: `${base}/${encodeURIComponent(job.sessionId)}/transcription-artifacts/${encodeURIComponent(artifact.artifactId)}`,
    })),
  };
}

function toPublicMinutesVersion(
  version: MeetingMinutesVersionRecord,
  surface: MeetingReadSurface = "owner"
) {
  const base = recordingReadBase(surface);
  if (surface !== "owner") {
    return {
      versionId: version.versionId,
      jobId: version.jobId,
      sessionId: version.sessionId,
      versionNumber: version.versionNumber,
      record: version.record,
      generatedAt: version.generatedAt,
      artifacts: version.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        versionId: artifact.versionId,
        jobId: artifact.jobId,
        sessionId: artifact.sessionId,
        type: artifact.type,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        createdAt: artifact.createdAt,
        downloadUrl: `${base}/${encodeURIComponent(version.sessionId)}/minutes/versions/${encodeURIComponent(version.versionId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
      })),
      packageUrl: `${base}/${encodeURIComponent(version.sessionId)}/minutes/versions/${encodeURIComponent(version.versionId)}/package.zip`,
    };
  }
  const { ownerId: _ownerId, packageRelativePath: _packageRelativePath, ...publicVersion } = version;
  return {
    ...publicVersion,
    artifacts: version.artifacts.map(({ relativePath: _relativePath, ...artifact }) => ({
      ...artifact,
      downloadUrl: `${base}/${encodeURIComponent(version.sessionId)}/minutes/versions/${encodeURIComponent(version.versionId)}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
    })),
    packageUrl: `${base}/${encodeURIComponent(version.sessionId)}/minutes/versions/${encodeURIComponent(version.versionId)}/package.zip`,
  };
}

function toPublicMinutesJob(
  job: MeetingMinutesJobRecord,
  surface: MeetingReadSurface = "owner"
) {
  const {
    ownerId: _ownerId,
    inputSha256: _inputSha256,
    transcriptionJobId: _transcriptionJobId,
    ...publicJob
  } = job;
  return {
    ...publicJob,
    input: { ...job.input, previousSummary: undefined },
    errorMessage: surface === "owner" ? job.errorMessage : null,
    version: job.version ? toPublicMinutesVersion(job.version, surface) : null,
  };
}

export function createMeetingRecordingsRouter(
  service: MeetingRecordingStorageService = meetingRecordingStorageService,
  ownerAuth: MeetingRecordingOwnerAuth = meetingRecordingOwnerAuth,
  processingService: MeetingProcessingService = meetingProcessingService,
  transcriptionService: MeetingTranscriptionService = meetingTranscriptionService,
  minutesService: MeetingMinutesService = meetingMinutesService,
  options: MeetingRecordingsRouterOptions = {}
): Router {
  const legacyAccess = options.legacyAccess ?? meetingLegacyRecordingAccess;
  const verifyAdminToken = options.verifyAdminToken ?? verifySystemNoticeBearerToken;
  const nowMs = options.nowMs ?? Date.now;
  const router = Router();
  router.use((req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.path.includes("/chunks") &&
      !req.path.endsWith("/heartbeat")
    ) {
      res.once("finish", () => { if (res.statusCode < 400) notifyMeetingStateChanged(); });
    }
    next();
  });
  const oneShot = options.oneShotService;
  if (oneShot) {
    router.use(createMeetingSummaryArchiveRouter(oneShot.archive, verifyAdminToken, () => oneShot.availability()));
    router.get("/meetings/one-shot", async (_req, res, next) => {
      try { res.setHeader("Cache-Control", "no-store"); res.json({ data: await oneShot.availability() }); }
      catch (error) { next(error); }
    });
    router.get("/meetings/recordings/current", async (req, res, next) => {
      try {
        const ownerId = ownerAuth.resolveOwner(req);
        res.setHeader("Cache-Control", "private, no-store");
        res.json({ data: ownerId ? await oneShot.current(ownerId, optionalMeetingRecorderId(req), deviceRequestMetadata(req)) : { source: null, sessionId: null } });
      } catch (error) { next(error); }
    });
    router.post("/meetings/recordings/:sessionId/release-current", async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        await oneShot.releaseCurrent(req.params.sessionId, ownerAuth.requireOwner(req));
        res.status(204).end();
      } catch (error) { next(error); }
    });
    router.get("/meetings/admin/meetings", async (req, res, next) => {
      try {
        verifyAdminToken(req.header("authorization"));
        res.setHeader("Cache-Control", "no-store");
        res.json({ data: await oneShot.listMeetings() });
      } catch (error) { next(error); }
    });
    router.get("/meetings/admin/meetings/:sessionId", async (req, res, next) => {
      try {
        verifyAdminToken(req.header("authorization"));
        res.setHeader("Cache-Control", "no-store");
        res.json({ data: await oneShot.getMeetingForAdmin(req.params.sessionId) });
      } catch (error) { next(error); }
    });
    router.post("/meetings/admin/meetings/:sessionId/cancel", async (req, res, next) => {
      try {
        verifyAdminToken(req.header("authorization"));
        res.json({ data: await oneShot.cancelMeeting(req.params.sessionId) });
      } catch (error) { next(error); }
    });
    router.post("/meetings/admin/meetings/:sessionId/retry", async (req, res, next) => {
      try {
        verifyAdminToken(req.header("authorization"));
        res.status(202).json({ data: await oneShot.retryMeeting(req.params.sessionId) });
      } catch (error) { next(error); }
    });
    router.get("/meetings/recordings/:sessionId/delivery", async (req, res, next) => {
      try {
        if (!await oneShot.repository.get(req.params.sessionId)) {
          const access = await resolveSessionAccess(req, req.params.sessionId, true);
          const session = await service.getSession(req.params.sessionId, access.ownerId);
          res.setHeader("Cache-Control", "no-store");
          res.json({ data: { phase: session.status === "finalized" ? "legacy-saved" : "recording", session,
            expiresAt: null, errorCode: null, errorMessage: null, processing: null, transcription: null, minutes: null } });
          return;
        }
        const ownerId = ownerAuth.requireOwner(req);
        const state = await oneShot.status(req.params.sessionId, ownerId);
        res.setHeader("Cache-Control", "no-store");
        res.json({ data: { ...state,
          processing: state.processing ? toPublicProcessingJob(state.processing) : null,
          transcription: state.transcription ? toPublicTranscriptionJob(state.transcription) : null,
          minutes: state.minutes ? toPublicMinutesJob(state.minutes) : null,
          revision: "revision" in state && state.revision ? toPublicMinutesJob(state.revision) : null,
        } });
      } catch (error) { next(error); }
    });
  }
  const resolveSessionAccess = async (
    req: Request,
    sessionId: string,
    allowCookieCapability = false
  ): Promise<MeetingRecordingRequestAccess> => {
    if (req.path.startsWith("/meetings/admin/legacy-recordings/")) {
      verifyAdminToken(req.header("authorization"));
      const legacy = await service.getLegacySessionForAdmin(sessionId);
      return { ownerId: legacy.ownerId, surface: "admin" };
    }

    if (oneShot && await oneShot.repository.get(sessionId)) {
      const ownerId = ownerAuth.requireOwner(req);
      await oneShot.assertAccess(sessionId, ownerId,
        req.method !== "GET" && req.method !== "HEAD" && req.route?.path !== "/meetings/recordings/:sessionId/finalize");
      const res = req.res!;
      if (!res.locals.meetingOneShotLease) {
        const lease = await oneShot.repository.acquireAccess(sessionId, new Date(nowMs()).toISOString(), new Date(nowMs() + 60_000).toISOString());
        res.locals.meetingOneShotLease = lease;
        const timer = setInterval(() => {
          void oneShot.repository.renewAccess(lease, new Date(nowMs() + 60_000).toISOString()).catch(() => res.destroy());
        }, 15_000);
        timer.unref();
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          clearInterval(timer);
          void oneShot.repository.releaseAccess(lease).catch(error => log.warn({ event: "one-shot-lease-release-failed", error: String(error) }));
        };
        res.once("finish", release);
        res.once("close", release);
      }
      return { ownerId, surface: "owner" };
    }
    if (req.method === "POST" && !["/meetings/recordings/:sessionId/finalize", "/meetings/recordings/:sessionId/abort"].includes(req.route?.path)) {
      throw new HttpError(410, "舊錄音僅保留續傳與唯讀存取。", "MEETING_LEGACY_READ_ONLY");
    }
    const sessionCapability =
      req.header("x-meeting-session-capability") ??
      (allowCookieCapability
        ? legacyAccess.readCookie(req)
        : null);
    if (sessionCapability) {
      const capabilityAccess = await service.resolveSessionCapabilityOwner(
        sessionId,
        sessionCapability
      );
      await legacyAccess.assertActive(
        capabilityAccess.ownerId,
        capabilityAccess.libraryAccessVersion
      );
      return {
        ownerId: capabilityAccess.ownerId,
        surface: "recorder",
      };
    }
    const ownerId = ownerAuth.resolveOwner(req);
    if (ownerId) {
      return {
        ownerId,
        surface: "owner",
      };
    }
    return {
      ownerId: ownerAuth.requireOwner(req),
      surface: "owner",
    };
  };
  const parseChunk = express.raw({
    type: ["audio/webm", "audio/ogg", "application/octet-stream"],
    limit: env.MEETING_RECORDING_MAX_CHUNK_BYTES,
  });
  if (oneShot) {
    router.post("/meetings/recordings/:sessionId/delivery/revisions", async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        const job = await oneShot.requestRevision(req.params.sessionId, ownerAuth.requireOwner(req), req.body ?? {});
        res.status(202).json({ data: toPublicMinutesJob(job), meta: { accepted: true } });
      } catch (error) { next(error); }
    });
    router.post("/meetings/recordings/:sessionId/delivery/revisions/:jobId/adopt", async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        await oneShot.adoptRevision(req.params.sessionId, ownerAuth.requireOwner(req), req.params.jobId, req.body?.expectedVersionId, req.body?.acknowledgementToken);
        res.status(204).end();
      } catch (error) { next(error); }
    });
    router.post("/meetings/recordings/:sessionId/delivery/revisions/:jobId/discard", async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        await oneShot.discardRevision(req.params.sessionId, ownerAuth.requireOwner(req), req.params.jobId);
        res.status(204).end();
      } catch (error) { next(error); }
    });
    router.get("/meetings/recordings/:sessionId/delivery/revisions/:jobId/html", async (req, res, next) => {
      try {
        const access = await resolveSessionAccess(req, req.params.sessionId);
        const entry = await oneShot.repository.get(req.params.sessionId);
        const job = entry?.revisionJobId === req.params.jobId ? await minutesService.getJob(req.params.jobId, access.ownerId) : null;
        if (job?.sessionId !== req.params.sessionId || job.status !== "ready" || !job.version) throw new HttpError(404, "修訂版尚未完成或已更新。", "MEETING_REVISION_NOT_READY");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.type("html").send(renderMeetingMinutesHtml({ record: job.version.record, versionNumber: job.version.versionNumber,
          generatedAt: job.version.generatedAt, audioFiles: [], includeAudio: false }));
      } catch (error) { next(error); }
    });
    router.get("/meetings/recordings/:sessionId/delivery/html", async (req, res, next) => {
      try {
        await resolveSessionAccess(req, req.params.sessionId);
        const item = await oneShot.archive.get(req.params.sessionId);
        if (!item) throw new HttpError(404, "摘要尚未產出。", "MEETING_SUMMARY_NOT_READY");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="meeting-summary.html"`);
        res.type("html").send(restyleMeetingMinutesHtml(item.html));
      } catch (error) { next(error); }
    });
  }
  const chunkBody = (req: Request, res: Response, next: NextFunction) => {
    parseChunk(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      const status =
        error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      if (status === 413) {
        next(
          new HttpError(
            413,
            "錄音分段超過允許大小。",
            "MEETING_RECORDING_CHUNK_TOO_LARGE"
          )
        );
        return;
      }
      next(error);
    });
  };

  router.use("/meetings/recordings", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.post("/meetings/recordings", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const body = req.body ?? {};
      if (body.deliveryMode !== "one-shot") throw new HttpError(426, "舊錄音模式已退場，請重新整理頁面。", "MEETING_CLIENT_UPDATE_REQUIRED");
      if (!Array.isArray(body.sourceIds) || body.sourceIds.some((value: unknown) => typeof value !== "string")) throw new ValidationError("sourceIds 必須是錄音來源陣列。", "MEETING_RECORDING_SOURCE_REQUIRED");
      if (body.title !== undefined && typeof body.title !== "string") throw new ValidationError("title 必須是文字。", "MEETING_RECORDING_TITLE_INVALID");
      if (!oneShot) throw new HttpError(503, "一次性會議服務尚未啟用。", "MEETING_ONE_SHOT_UNAVAILABLE");
      const created = await oneShot.create(ownerAuth.resolveOrCreateOwner(req, res), body.title, body.sourceIds,
        body.additionalSectionRequest, meetingRecorderId(req), deviceRequestMetadata(req));
      res.status(created.reused ? 200 : 201).json({ data: created.session, meta: { sessionCapability: null, reusedSession: created.reused } });
    } catch (error) { next(error); }
  });

  router.post("/meetings/recordings/:sessionId/heartbeat", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      if (!oneShot) {
        throw new HttpError(503, "一次性會議服務尚未啟用。", "MEETING_ONE_SHOT_UNAVAILABLE");
      }
      await oneShot.renewRecorderLease(
        req.params.sessionId,
        ownerAuth.requireOwner(req),
        meetingRecorderId(req)
      );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get(["/meetings/recordings/:sessionId", "/meetings/admin/legacy-recordings/:sessionId"], async (req, res, next) => {
    try {
      const access = await resolveSessionAccess(req, req.params.sessionId);
      res.json({
        data: await service.getSession(req.params.sessionId, access.ownerId),
      });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/meetings/recordings/:sessionId/tracks/:sourceId/chunks/:sequence",
    async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        res.locals.meetingRecordingAccess = await resolveSessionAccess(
          req,
          req.params.sessionId
        );
        next();
      } catch (error) {
        next(error);
      }
    },
    chunkBody,
    async (req, res, next) => {
      try {
        const access = res.locals.meetingRecordingAccess as MeetingRecordingRequestAccess;
        if (oneShot && await oneShot.repository.get(req.params.sessionId)) {
          await oneShot.renewRecorderLease(req.params.sessionId, access.ownerId, meetingRecorderId(req));
        }
        if (!Buffer.isBuffer(req.body)) {
          throw new ValidationError(
            "錄音分段 body 必須是音訊內容。",
            "MEETING_RECORDING_CHUNK_BODY_INVALID"
          );
        }
        const mimeType = String(req.headers["content-type"] ?? "");
        const result = await service.uploadChunk({
          ownerId: access.ownerId,
          sessionId: req.params.sessionId,
          sourceId: req.params.sourceId,
          sequence: Number(req.params.sequence),
          mimeType,
          body: req.body,
        });
        res.json({ data: result });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post("/meetings/recordings/:sessionId/finalize", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const access = await resolveSessionAccess(req, req.params.sessionId);
      const body = req.body as { durationMs?: unknown; tracks?: unknown };
      if (!Array.isArray(body?.tracks)) {
        throw new ValidationError(
          "tracks 必須是音軌完成資訊陣列。",
          "MEETING_RECORDING_TRACKS_INVALID"
        );
      }
      const tracks = body.tracks.map((value) => {
        const track = value as { sourceId?: unknown; chunkCount?: unknown };
        if (typeof track.sourceId !== "string" || !Number.isInteger(track.chunkCount)) {
          throw new ValidationError(
            "音軌完成資訊不合法。",
            "MEETING_RECORDING_TRACKS_INVALID"
          );
        }
        return { sourceId: track.sourceId, chunkCount: Number(track.chunkCount) };
      });
      const finalize = () => service.finalizeSession({
        ownerId: access.ownerId,
        sessionId: req.params.sessionId,
        durationMs: Number(body.durationMs),
        tracks,
      });
      const session = oneShot && await oneShot.repository.get(req.params.sessionId)
        ? await oneShot.finalizeRecording(req.params.sessionId, access.ownerId, meetingRecorderId(req), finalize)
        : await finalize();
      res.json({ data: session });
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/recordings/:sessionId/abort", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const access = await resolveSessionAccess(req, req.params.sessionId);
      if (oneShot && await oneShot.repository.get(req.params.sessionId)) {
        await oneShot.assertRecorder(req.params.sessionId, access.ownerId, meetingRecorderId(req));
        await oneShot.cancelMeeting(req.params.sessionId);
      } else {
        await service.abortSession(req.params.sessionId, access.ownerId);
      }
      if (access.surface === "recorder") {
        legacyAccess.clearCookie(req, res, req.params.sessionId);
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/recordings/:sessionId/process", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const access = await resolveSessionAccess(req, req.params.sessionId, true);
      if (!processingService.workerEnabled) {
        throw new HttpError(
          503,
          "錄音後處理 worker 尚未啟用。",
          "MEETING_PROCESSING_WORKER_DISABLED"
        );
      }
      const result = await processingService.enqueue(
        req.params.sessionId,
        access.ownerId
      );
      res.status(202).json({
        data: toPublicProcessingJob(result.job, access.surface),
        meta: { accepted: true, reused: !result.created },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get(["/meetings/recordings/:sessionId/processing-jobs/:jobId", "/meetings/admin/legacy-recordings/:sessionId/processing-jobs/:jobId"],
    async (req, res, next) => {
      try {
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const job = await processingService.getJob(
          req.params.jobId,
          access.ownerId
        );
        if (!job || job.sessionId !== req.params.sessionId) {
          throw new HttpError(
            404,
            "找不到後處理任務。",
            "MEETING_PROCESSING_JOB_NOT_FOUND"
          );
        }
        res.json({ data: toPublicProcessingJob(job, access.surface) });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/meetings/recordings/:sessionId/processing-jobs/:jobId/retry",
    async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const current = await processingService.getJob(
          req.params.jobId,
          access.ownerId
        );
        if (!current || current.sessionId !== req.params.sessionId) {
          throw new HttpError(
            404,
            "找不到後處理任務。",
            "MEETING_PROCESSING_JOB_NOT_FOUND"
          );
        }
        const job = oneShot && await oneShot.repository.get(req.params.sessionId)
          ? await oneShot.retryProcessingJob(req.params.sessionId, access.ownerId, req.params.jobId)
          : await processingService.retry(req.params.jobId, access.ownerId);
        res.status(202).json({
          data: toPublicProcessingJob(job, access.surface),
          meta: { accepted: true },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(["/meetings/recordings/:sessionId/artifacts", "/meetings/admin/legacy-recordings/:sessionId/artifacts"], async (req, res, next) => {
    try {
      const access = await resolveSessionAccess(req, req.params.sessionId, true);
      const job = await processingService.getJobForSession(
        req.params.sessionId,
        access.ownerId
      );
      if (!job) {
        throw new HttpError(
          404,
          "找不到後處理任務。",
          "MEETING_PROCESSING_JOB_NOT_FOUND"
        );
      }
      res.json({ data: toPublicProcessingJob(job, access.surface).artifacts });
    } catch (error) {
      next(error);
    }
  });

  router.get(["/meetings/recordings/:sessionId/artifacts/:artifactId", "/meetings/admin/legacy-recordings/:sessionId/artifacts/:artifactId"],
    async (req, res, next) => {
      try {
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const job = await processingService.getJobForSession(
          req.params.sessionId,
          access.ownerId
        );
        const artifact = job?.artifacts.find(
          (candidate) => candidate.artifactId === req.params.artifactId
        );
        if (!job || !artifact) {
          throw new HttpError(
            404,
            "找不到後處理產物。",
            "MEETING_PROCESSING_ARTIFACT_NOT_FOUND"
          );
        }
        const file = await processingService.resolveArtifact(artifact);
        res.setHeader("Content-Type", file.mimeType);
        res.setHeader("Content-Length", String(file.sizeBytes));
        const disposition = req.query.download === "1" ? "attachment" : "inline";
        res.setHeader(
          "Content-Disposition",
          `${disposition}; filename="${path.basename(artifact.relativePath)}"`
        );
        res.sendFile(file.filePath, (error) => {
          if (error) next(error);
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/meetings/recordings/:sessionId/transcriptions",
    async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const result = await transcriptionService.enqueue(
          req.params.sessionId,
          access.ownerId
        );
        res.status(202).json({
          data: toPublicTranscriptionJob(result.job, access.surface),
          meta: { accepted: true, reused: !result.created },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(["/meetings/recordings/:sessionId/transcription-jobs/:jobId", "/meetings/admin/legacy-recordings/:sessionId/transcription-jobs/:jobId"],
    async (req, res, next) => {
      try {
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const job = await transcriptionService.getJob(
          req.params.jobId,
          access.ownerId
        );
        if (!job || job.sessionId !== req.params.sessionId) {
          throw new HttpError(
            404,
            "找不到逐字稿任務。",
            "MEETING_TRANSCRIPTION_JOB_NOT_FOUND"
          );
        }
        res.json({ data: toPublicTranscriptionJob(job, access.surface) });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/meetings/recordings/:sessionId/transcription-jobs/:jobId/retry",
    async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const current = await transcriptionService.getJob(
          req.params.jobId,
          access.ownerId
        );
        if (!current || current.sessionId !== req.params.sessionId) {
          throw new HttpError(
            404,
            "找不到逐字稿任務。",
            "MEETING_TRANSCRIPTION_JOB_NOT_FOUND"
          );
        }
        const job = oneShot && await oneShot.repository.get(req.params.sessionId)
          ? await oneShot.retryTranscriptionJob(req.params.sessionId, access.ownerId, req.params.jobId)
          : await transcriptionService.retry(req.params.jobId, access.ownerId);
        res.status(202).json({
          data: toPublicTranscriptionJob(job, access.surface),
          meta: { accepted: true },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(["/meetings/recordings/:sessionId/transcription-artifacts/:artifactId", "/meetings/admin/legacy-recordings/:sessionId/transcription-artifacts/:artifactId"],
    async (req, res, next) => {
      try {
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const job = await transcriptionService.getJobForSession(
          req.params.sessionId,
          access.ownerId
        );
        const artifact = job?.artifacts.find(
          (candidate) => candidate.artifactId === req.params.artifactId
        );
        if (!job || !artifact) {
          throw new HttpError(
            404,
            "找不到逐字稿產物。",
            "MEETING_TRANSCRIPTION_ARTIFACT_NOT_FOUND"
          );
        }
        const file = await transcriptionService.resolveArtifact(artifact);
        res.setHeader("Content-Type", file.mimeType);
        res.setHeader("Content-Length", String(file.sizeBytes));
        const disposition = req.query.download === "1" ? "attachment" : "inline";
        res.setHeader(
          "Content-Disposition",
          `${disposition}; filename="${path.basename(artifact.relativePath)}"`
        );
        res.sendFile(file.filePath, (error) => {
          if (error) next(error);
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(["/meetings/recordings/:sessionId/minutes-jobs/:jobId", "/meetings/admin/legacy-recordings/:sessionId/minutes-jobs/:jobId"],
    async (req, res, next) => {
      try {
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const job = await minutesService.getJob(req.params.jobId, access.ownerId);
        if (!job || job.sessionId !== req.params.sessionId) {
          throw new HttpError(
            404,
            "找不到會議紀錄任務。",
            "MEETING_MINUTES_JOB_NOT_FOUND"
          );
        }
        res.json({ data: toPublicMinutesJob(job, access.surface) });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/meetings/recordings/:sessionId/minutes-jobs/:jobId/retry",
    async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const current = await minutesService.getJob(
          req.params.jobId,
          access.ownerId
        );
        if (!current || current.sessionId !== req.params.sessionId) {
          throw new HttpError(
            404,
            "找不到會議紀錄任務。",
            "MEETING_MINUTES_JOB_NOT_FOUND"
          );
        }
        const job = oneShot && await oneShot.repository.get(req.params.sessionId)
          ? await oneShot.retryMinutesJob(req.params.sessionId, access.ownerId, req.params.jobId)
          : await minutesService.retry(req.params.jobId, access.ownerId);
        res.status(202).json({
          data: toPublicMinutesJob(job, access.surface),
          meta: { accepted: true },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(["/meetings/recordings/:sessionId/minutes/versions", "/meetings/admin/legacy-recordings/:sessionId/minutes/versions"],
    async (req, res, next) => {
      try {
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const parsedLimit = Number(req.query.limit ?? 20);
        const versions = await minutesService.listVersions(
          req.params.sessionId,
          access.ownerId,
          Number.isFinite(parsedLimit) ? parsedLimit : 20
        );
        res.json({
          data: versions.map((version) =>
            toPublicMinutesVersion(version, access.surface)
          ),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(["/meetings/recordings/:sessionId/minutes/versions/:versionId/artifacts/:artifactId", "/meetings/admin/legacy-recordings/:sessionId/minutes/versions/:versionId/artifacts/:artifactId"],
    async (req, res, next) => {
      try {
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const version = await minutesService.getVersion(
          req.params.versionId,
          access.ownerId
        );
        const artifact = version?.artifacts.find(
          (candidate) => candidate.artifactId === req.params.artifactId
        );
        if (!version || version.sessionId !== req.params.sessionId || !artifact) {
          throw new HttpError(
            404,
            "找不到會議紀錄產物。",
            "MEETING_MINUTES_ARTIFACT_NOT_FOUND"
          );
        }
        const file = await minutesService.resolveArtifact(artifact);
        res.setHeader("Content-Type", file.mimeType);
        res.setHeader("Content-Length", String(file.sizeBytes));
        const disposition = req.query.download === "1" ? "attachment" : "inline";
        res.setHeader(
          "Content-Disposition",
          `${disposition}; filename="${artifact.filename}"`
        );
        res.sendFile(file.filePath, (error) => {
          if (error) next(error);
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(["/meetings/recordings/:sessionId/minutes/versions/:versionId/package.zip", "/meetings/admin/legacy-recordings/:sessionId/minutes/versions/:versionId/package.zip"],
    async (req, res, next) => {
      try {
        const access = await resolveSessionAccess(req, req.params.sessionId, true);
        const version = await minutesService.getVersion(
          req.params.versionId,
          access.ownerId
        );
        if (!version || version.sessionId !== req.params.sessionId) {
          throw new HttpError(
            404,
            "找不到會議紀錄版本。",
            "MEETING_MINUTES_VERSION_NOT_FOUND"
          );
        }
        res.setHeader("Content-Type", "application/zip");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="meeting-minutes-v${version.versionNumber}.zip"`
        );
        await minutesService.streamVersionZip(version, res);
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(["/meetings/recordings/:sessionId/tracks/:sourceId", "/meetings/admin/legacy-recordings/:sessionId/tracks/:sourceId"], async (req, res, next) => {
    try {
      const access = await resolveSessionAccess(req, req.params.sessionId, true);
      const track = await service.resolveTrack(
        req.params.sessionId,
        req.params.sourceId,
        access.ownerId
      );
      res.setHeader("Content-Type", track.mimeType);
      res.setHeader("Content-Length", String(track.sizeBytes));
      const disposition = req.query.download === "1" ? "attachment" : "inline";
      res.setHeader("Content-Disposition", `${disposition}; filename="${track.filename}"`);
      res.sendFile(track.filePath, (error) => {
        if (error) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/meetings/admin/legacy-recordings", async (req, res, next) => {
    try {
      verifyAdminToken(req.header("authorization"));
      const offset = Number(req.query.offset ?? 0);
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!Number.isSafeInteger(offset) || offset < 0 || query.length > 200) throw new ValidationError("查詢條件不合法。", "MEETING_LEGACY_QUERY_INVALID");
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: await service.listLegacySessionsForAdmin(50, offset, query) });
    } catch (error) { next(error); }
  });
  return router;
}

export default createMeetingRecordingsRouter(undefined, undefined, undefined, undefined, undefined, { oneShotService: meetingOneShotService });
