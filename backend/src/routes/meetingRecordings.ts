import express, { NextFunction, Request, Response, Router } from "express";
import { randomBytes } from "node:crypto";
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
import {
  meetingLibraryAccessService,
  toMeetingLibraryPublicInfo,
  type MeetingLibraryAccessService,
} from "../services/meeting-minutes/meetingLibraryAccessService";
import {
  meetingLibraryViewerAuth,
  type MeetingLibraryViewerAuth,
} from "../services/meeting-minutes/meetingLibraryViewerAuth";
import {
  MeetingLibraryAccessAttemptGuard,
  type MeetingLibraryAccessAttemptIdentity,
} from "../services/meeting-minutes/meetingLibraryAccessAttemptGuard";
import type { MeetingProcessingJobRecord } from "../storage/meeting-minutes/meetingProcessingJobRepository";
import type { MeetingLibraryRecord } from "../storage/meeting-minutes/meetingLibraryRepository";
import type { MeetingTranscriptionJobRecord } from "../storage/meeting-minutes/meetingTranscriptionJobRepository";
import type {
  MeetingMinutesJobRecord,
  MeetingMinutesVersionRecord,
} from "../storage/meeting-minutes/meetingMinutesJobRepository";
import type { MeetingMinutesHumanInput } from "../services/meeting-minutes/meetingMinutesSchema";
import { HttpError, ValidationError } from "../utils/httpError";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";

type MeetingReadSurface = "owner" | "recorder" | "library";

interface MeetingRecordingRequestAccess {
  ownerId: string;
  surface: "owner" | "recorder";
  recorderGrantId: string | null;
  library: MeetingLibraryRecord | null;
}

export interface MeetingRecordingsRouterOptions {
  libraryService?: MeetingLibraryAccessService;
  viewerAuth?: MeetingLibraryViewerAuth;
  verifyAdminToken?: (authorizationHeader: string | undefined) => { username: string };
  libraryAccessAttemptGuard?: MeetingLibraryAccessAttemptGuard;
  nowMs?: () => number;
  sessionCapabilityMaxAgeMs?: number;
}

const log = createLogger("meeting-recordings-route");
const DEFAULT_SESSION_CAPABILITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function recordingReadBase(surface: MeetingReadSurface): string {
  return surface === "library"
    ? "/api/meetings/library/recordings"
    : "/api/meetings/recordings";
}

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function encodeAdminLibraryCursor(input: {
  query: string;
  createdAt: string;
  libraryId: string;
}): string {
  return Buffer.from(JSON.stringify({ v: 1, ...input }), "utf8").toString("base64url");
}

function decodeAdminLibraryCursor(value: unknown, query: string): {
  createdAt: string;
  libraryId: string;
} | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new ValidationError("錄音庫清單游標不合法。", "MEETING_LIBRARY_CURSOR_INVALID");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      query?: unknown;
      createdAt?: unknown;
      libraryId?: unknown;
    };
    if (
      parsed.v !== 1 ||
      parsed.query !== query ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.libraryId !== "string"
    ) {
      throw new Error("invalid admin library cursor");
    }
    return { createdAt: parsed.createdAt, libraryId: parsed.libraryId };
  } catch {
    throw new ValidationError("錄音庫清單游標不合法。", "MEETING_LIBRARY_CURSOR_INVALID");
  }
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
  const libraryService = options.libraryService ?? meetingLibraryAccessService;
  const viewerAuth = options.viewerAuth ?? meetingLibraryViewerAuth;
  const libraryAccessAttemptGuard =
    options.libraryAccessAttemptGuard ?? new MeetingLibraryAccessAttemptGuard();
  const verifyAdminToken = options.verifyAdminToken ?? verifySystemNoticeBearerToken;
  const nowMs = options.nowMs ?? Date.now;
  const sessionCapabilityMaxAgeMs = Math.max(
    1_000,
    Math.trunc(
      options.sessionCapabilityMaxAgeMs ?? DEFAULT_SESSION_CAPABILITY_MAX_AGE_MS
    )
  );
  const router = Router();
  const authorizeLibrary = async (req: Request, code: unknown) => {
    const identity: MeetingLibraryAccessAttemptIdentity = {
      clientId: req.header("x-debug-client-id"),
      ip: clientIp(req),
    };
    libraryAccessAttemptGuard.assertAllowed(identity);
    try {
      const library = await libraryService.authorize(code);
      libraryAccessAttemptGuard.recordSuccess(identity);
      return library;
    } catch (error) {
      if (error instanceof HttpError && error.code === "MEETING_LIBRARY_CODE_INVALID") {
        libraryAccessAttemptGuard.recordFailure(identity);
      }
      throw error;
    }
  };
  const resolveRecordingAccess = async (
    req: Request,
    res?: Response
  ): Promise<MeetingRecordingRequestAccess> => {
    const recorderGrant = await viewerAuth.resolveRecorder(req);
    if (recorderGrant) {
      return {
        ownerId: recorderGrant.library.libraryId,
        surface: "recorder",
        recorderGrantId: recorderGrant.grantId,
        library: recorderGrant.library,
      };
    }
    return {
      ownerId: res
        ? ownerAuth.resolveOrCreateOwner(req, res)
        : ownerAuth.requireOwner(req),
      surface: "owner",
      recorderGrantId: null,
      library: null,
    };
  };
  const resolveSessionAccess = async (
    req: Request,
    sessionId: string,
    allowCookieCapability = false
  ): Promise<MeetingRecordingRequestAccess> => {
    const sessionCapability =
      req.header("x-meeting-session-capability") ??
      (allowCookieCapability
        ? viewerAuth.resolveSessionCapability(req, sessionId)
        : null);
    if (sessionCapability) {
      const capabilityAccess = await service.resolveSessionCapabilityOwner(
        sessionId,
        sessionCapability
      );
      await libraryService.assertSessionCapabilityActive(
        capabilityAccess.ownerId,
        capabilityAccess.libraryAccessVersion
      );
      return {
        ownerId: capabilityAccess.ownerId,
        surface: "recorder",
        recorderGrantId: null,
        library: null,
      };
    }
    const ownerId = ownerAuth.resolveOwner(req);
    if (ownerId) {
      return {
        ownerId,
        surface: "owner",
        recorderGrantId: null,
        library: null,
      };
    }
    const recorderGrant = await viewerAuth.resolveRecorder(req);
    if (recorderGrant) {
      throw new HttpError(
        401,
        "請使用這份錄音建立時取得的 session 權限。",
        "MEETING_RECORDING_SESSION_CAPABILITY_REQUIRED"
      );
    }
    return {
      ownerId: ownerAuth.requireOwner(req),
      surface: "owner",
      recorderGrantId: null,
      library: null,
    };
  };
  const parseChunk = express.raw({
    type: ["audio/webm", "audio/ogg", "application/octet-stream"],
    limit: env.MEETING_RECORDING_MAX_CHUNK_BYTES,
  });
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
  router.use(
    ["/meetings/library-access", "/meetings/library", "/meetings/admin"],
    (_req, res, next) => {
      res.setHeader("Cache-Control", "private, no-store");
      next();
    }
  );

  router.post("/meetings/library-access", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const library = await authorizeLibrary(
        req,
        (req.body as { code?: unknown } | undefined)?.code
      );
      viewerAuth.setViewer(req, res, library);
      res.json({
        data: toMeetingLibraryPublicInfo(library),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/library/logout", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      viewerAuth.clearViewer(req, res);
      viewerAuth.clearRecorder(req, res);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/meetings/library", async (req, res, next) => {
    try {
      const library = await viewerAuth.requireViewer(req);
      res.json({
        data: toMeetingLibraryPublicInfo(library),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/meetings/library/recordings", async (req, res, next) => {
    try {
      const library = await viewerAuth.requireViewer(req);
      const parsedLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
      const page = await service.listSessionsPage(library.libraryId, {
        limit,
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
      });
      res.json({
        data: page.items,
        meta: { nextCursor: page.nextCursor, hasMore: page.hasMore },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/meetings/library/recordings/:sessionId", async (req, res, next) => {
    try {
      const library = await viewerAuth.requireViewer(req);
      const [session, processingJob, transcriptionJob, minutesVersions] =
        await Promise.all([
          service.getSession(req.params.sessionId, library.libraryId),
          processingService.getJobForSession(req.params.sessionId, library.libraryId),
          transcriptionService.getJobForSession(req.params.sessionId, library.libraryId),
          minutesService.listVersions(req.params.sessionId, library.libraryId, 50),
        ]);
      res.json({
        data: {
          session,
          processingJob: processingJob
            ? toPublicProcessingJob(processingJob, "library")
            : null,
          transcriptionJob: transcriptionJob
            ? toPublicTranscriptionJob(transcriptionJob, "library")
            : null,
          minutesVersions: minutesVersions.map((version) =>
            toPublicMinutesVersion(version, "library")
          ),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/meetings/recordings", async (req, res, next) => {
    try {
      const access = await resolveRecordingAccess(req);
      const parsedLimit = Number(req.query.limit ?? 20);
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : 20;
      res.json({ data: await service.listSessions(access.ownerId, limit) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/meetings/recordings/library", async (req, res, next) => {
    try {
      let recorderGrant: Awaited<ReturnType<MeetingLibraryViewerAuth["resolveRecorder"]>>;
      try {
        recorderGrant = await viewerAuth.resolveRecorder(req);
      } catch (error) {
        const ownerId = ownerAuth.resolveOwner(req);
        const recoverableRecorderError =
          error instanceof HttpError &&
          (error.code === "MEETING_LIBRARY_RECORDER_REQUIRED" ||
            error.code === "MEETING_LIBRARY_RECORDER_EXPIRED");
        if (!recoverableRecorderError || !ownerId) throw error;

        const result = await libraryService.getOwnerLibrary(ownerId);
        viewerAuth.clearRecorder(req, res);
        res.json({
          data: {
            ...result,
            ownedLibrary: result.library,
            accessMode: "owner",
          },
        });
        return;
      }
      if (recorderGrant) {
        const ownerId = ownerAuth.resolveOwner(req);
        const ownedLibrary = ownerId
          ? (await libraryService.getOwnerLibrary(ownerId)).library
          : null;
        res.json({
          data: {
            enabled: true,
            library: toMeetingLibraryPublicInfo(recorderGrant.library),
            ownedLibrary,
            accessMode: "recorder",
          },
        });
        return;
      }
      const ownerId = ownerAuth.requireOwner(req);
      const result = await libraryService.getOwnerLibrary(ownerId);
      res.json({
        data: {
          ...result,
          ownedLibrary: result.library,
          accessMode: "owner",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/recordings/library", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const ownerId = ownerAuth.resolveOrCreateOwner(req, res);
      const current = await libraryService.getOwnerLibrary(ownerId);
      if (current.library) {
        throw new HttpError(
          409,
          "這台裝置已經建立錄音庫，請直接使用或重新命名。",
          "MEETING_LIBRARY_ALREADY_EXISTS"
        );
      }
      const result = await libraryService.ensureLibrary(
        ownerId,
        (req.body as { displayName?: unknown } | undefined)?.displayName
      );
      if (result.enabled && !result.created) {
        throw new HttpError(
          409,
          "這台裝置已經建立錄音庫，請重新整理後再操作。",
          "MEETING_LIBRARY_ALREADY_EXISTS"
        );
      }
      viewerAuth.clearRecorder(req, res);
      res.status(result.created ? 201 : 200).json({
        data: { ...result, ownedLibrary: result.library, accessMode: "owner" },
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/meetings/recordings/library", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const ownerId = ownerAuth.requireOwner(req);
      const library = await libraryService.renameLibrary(
        ownerId,
        (req.body as { displayName?: unknown } | undefined)?.displayName
      );
      res.json({
        data: {
          enabled: true,
          library,
          ownedLibrary: library,
          code: null,
          accessMode: "owner",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/recordings/library-access", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const library = await authorizeLibrary(
        req,
        (req.body as { code?: unknown } | undefined)?.code
      );
      const ownerId = ownerAuth.resolveOwner(req);
      const ownedLibrary = ownerId
        ? (await libraryService.getOwnerLibrary(ownerId)).library
        : null;
      const accessMode = ownerId === library.libraryId ? "owner" : "recorder";
      if (accessMode === "owner") {
        viewerAuth.clearRecorder(req, res);
      } else {
        viewerAuth.setRecorder(req, res, library);
      }
      viewerAuth.setViewer(req, res, library);
      res.json({
        data: {
          enabled: true,
          library: toMeetingLibraryPublicInfo(library),
          ownedLibrary,
          code: null,
          accessMode,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/recordings/library/confirm-code", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const ownerId = ownerAuth.requireOwner(req);
      const library = await libraryService.confirmOwnerCode(
        ownerId,
        (req.body as { code?: unknown } | undefined)?.code
      );
      res.json({
        data: {
          enabled: true,
          library,
          ownedLibrary: library,
          code: null,
          accessMode: "owner",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/recordings/library/rotate-code", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const ownerId = ownerAuth.requireOwner(req);
      const result = await libraryService.rotateCode(ownerId);
      res.json({
        data: {
          enabled: true,
          ...result,
          ownedLibrary: result.library,
          accessMode: "owner",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/recordings", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const access = await resolveRecordingAccess(req, res);
      const body = req.body as {
        title?: unknown;
        sourceIds?: unknown;
        libraryId?: unknown;
      };
      if (!Array.isArray(body?.sourceIds) || body.sourceIds.some((value) => typeof value !== "string")) {
        throw new ValidationError(
          "sourceIds 必須是錄音來源陣列。",
          "MEETING_RECORDING_SOURCE_REQUIRED"
        );
      }
      if (body.title !== undefined && typeof body.title !== "string") {
        throw new ValidationError("title 必須是文字。", "MEETING_RECORDING_TITLE_INVALID");
      }
      if (
        body.libraryId !== undefined &&
        body.libraryId !== null &&
        typeof body.libraryId !== "string"
      ) {
        throw new ValidationError(
          "libraryId 必須是文字。",
          "MEETING_RECORDING_LIBRARY_ID_INVALID"
        );
      }
      const expectedLibraryId =
        typeof body.libraryId === "string" ? body.libraryId.trim() : null;
      if (
        expectedLibraryId &&
        expectedLibraryId !== access.ownerId
      ) {
        throw new HttpError(
          409,
          "目前選取的錄音庫已在其他分頁變更，請重新確認後再開始錄音。",
          "MEETING_RECORDING_LIBRARY_SELECTION_CHANGED"
        );
      }
      const libraryAccess = libraryService.enabled
        ? access.library
          ? toMeetingLibraryPublicInfo(access.library)
          : (await libraryService.getOwnerLibrary(access.ownerId)).library
        : null;
      if (libraryService.enabled && libraryAccess?.setupState !== "ready") {
        throw new HttpError(
          409,
          "請先完成錄音庫名稱與存取碼設定，再開始錄音。",
          "MEETING_LIBRARY_SETUP_REQUIRED"
        );
      }
      const sessionCapability =
        access.surface === "recorder" ? randomBytes(32).toString("base64url") : null;
      const sessionCapabilityExpiresAtMs = sessionCapability
        ? Math.trunc(nowMs()) + sessionCapabilityMaxAgeMs
        : null;
      const session = await service.createSession({
        ownerId: access.ownerId,
        title: body.title,
        sourceIds: body.sourceIds as string[],
        recorderGrantId: access.recorderGrantId ?? undefined,
        sessionCapability: sessionCapability ?? undefined,
        recorderLibraryAccessVersion:
          access.surface === "recorder"
            ? access.library?.accessVersion
            : undefined,
        sessionCapabilityExpiresAt:
          sessionCapabilityExpiresAtMs !== null
            ? new Date(sessionCapabilityExpiresAtMs).toISOString()
            : undefined,
      });
      if (sessionCapability && sessionCapabilityExpiresAtMs !== null) {
        try {
          viewerAuth.setSessionCapability(
            req,
            res,
            session.sessionId,
            sessionCapability,
            sessionCapabilityExpiresAtMs
          );
        } catch (error) {
          try {
            await service.abortSession(session.sessionId, access.ownerId);
          } catch (cleanupError) {
            log.error({
              event: "meeting-session-capability-rollback-failed",
              ownerId: access.ownerId,
              sessionId: session.sessionId,
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
            });
          }
          throw error;
        }
      }
      res.status(201).json({
        data: session,
        meta: {
          libraryAccessEnabled: libraryService.enabled,
          library: libraryAccess,
          libraryCode: null,
          sessionCapability,
          accessMode: access.surface,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/meetings/recordings/:sessionId", async (req, res, next) => {
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
      const session = await service.finalizeSession({
        ownerId: access.ownerId,
        sessionId: req.params.sessionId,
        durationMs: Number(body.durationMs),
        tracks,
      });
      res.json({ data: session });
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/recordings/:sessionId/abort", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const access = await resolveSessionAccess(req, req.params.sessionId);
      await service.abortSession(req.params.sessionId, access.ownerId);
      if (access.surface === "recorder") {
        viewerAuth.clearSessionCapability(req, res, req.params.sessionId);
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

  router.get(
    "/meetings/recordings/:sessionId/processing-jobs/:jobId",
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
        const job = await processingService.retry(req.params.jobId, access.ownerId);
        res.status(202).json({
          data: toPublicProcessingJob(job, access.surface),
          meta: { accepted: true },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get("/meetings/recordings/:sessionId/artifacts", async (req, res, next) => {
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

  router.get(
    "/meetings/recordings/:sessionId/artifacts/:artifactId",
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

  router.get(
    "/meetings/recordings/:sessionId/transcription-jobs/:jobId",
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
        const job = await transcriptionService.retry(
          req.params.jobId,
          access.ownerId
        );
        res.status(202).json({
          data: toPublicTranscriptionJob(job, access.surface),
          meta: { accepted: true },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/meetings/recordings/:sessionId/transcription-artifacts/:artifactId",
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

  router.post("/meetings/recordings/:sessionId/minutes", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const access = await resolveSessionAccess(req, req.params.sessionId, true);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await minutesService.enqueue({
        sessionId: req.params.sessionId,
        ownerId: access.ownerId,
        clientRequestKey:
          typeof body?.clientRequestKey === "string" ? body.clientRequestKey : "",
        humanInput: body as Partial<MeetingMinutesHumanInput>,
      });
      res.status(202).json({
        data: toPublicMinutesJob(result.job, access.surface),
        meta: { accepted: true, reused: !result.created },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/meetings/recordings/:sessionId/minutes-jobs/:jobId",
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
        const job = await minutesService.retry(req.params.jobId, access.ownerId);
        res.status(202).json({
          data: toPublicMinutesJob(job, access.surface),
          meta: { accepted: true },
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/meetings/recordings/:sessionId/minutes/versions",
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

  router.get(
    "/meetings/recordings/:sessionId/minutes/versions/:versionId/artifacts/:artifactId",
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

  router.get("/meetings/admin/libraries", async (req, res, next) => {
    try {
      const admin = verifyAdminToken(req.header("authorization"));
      const parsedLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(200, Math.trunc(parsedLimit)))
        : 50;
      const query = String(req.query.query ?? "").trim().toLowerCase();
      const cursor = decodeAdminLibraryCursor(req.query.cursor, query);
      const [libraries, recordingSummaries] = await Promise.all([
        libraryService.listAllLibraries(),
        service.summarizeSessionsByOwner(),
      ]);
      const rows = libraries.map((library) => {
        const summary = recordingSummaries.get(library.libraryId);
        return {
          ...library,
          recordingCount: summary?.recordingCount ?? 0,
          latestRecording: summary?.latestRecording ?? null,
          recordingTitles: summary?.recordingTitles ?? [],
        };
      });
      const filtered = query
        ? rows.filter(
            (row) =>
              row.libraryId.toLowerCase().includes(query) ||
              row.displayName?.toLowerCase().includes(query) ||
              row.recordingTitles.some((title) => title.toLowerCase().includes(query))
          )
        : rows;
      const afterCursor = filtered.filter(
        (row) =>
          !cursor ||
          row.createdAt.localeCompare(cursor.createdAt) < 0 ||
          (row.createdAt === cursor.createdAt &&
            row.libraryId.localeCompare(cursor.libraryId) > 0)
      );
      const page = afterCursor.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const visible = page.slice(0, limit);
      const totalRecordingCount = filtered.reduce(
        (total, row) => total + row.recordingCount,
        0
      );
      await libraryService.recordAdminAudit({
        adminUsername: admin.username,
        action: "list-libraries",
        clientIp: clientIp(req),
      });
      res.json({
        data: visible.map(({ recordingTitles: _recordingTitles, ...row }) => row),
        meta: {
          nextCursor:
            hasMore && visible.length > 0
              ? encodeAdminLibraryCursor({
                  query,
                  createdAt: visible[visible.length - 1]!.createdAt,
                  libraryId: visible[visible.length - 1]!.libraryId,
                })
              : null,
          hasMore,
          totalCount: filtered.length,
          totalRecordingCount,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/meetings/admin/libraries/:libraryId/open", async (req, res, next) => {
    try {
      ownerAuth.requireMutationIntent(req);
      const admin = verifyAdminToken(req.header("authorization"));
      const libraryBeforeAudit = await libraryService.getLibraryRecord(req.params.libraryId);
      if (!libraryBeforeAudit) {
        throw new HttpError(404, "找不到錄音庫。", "MEETING_LIBRARY_NOT_FOUND");
      }
      await libraryService.recordAdminAudit({
        adminUsername: admin.username,
        action: "open-library",
        libraryId: libraryBeforeAudit.libraryId,
        clientIp: clientIp(req),
      });
      const library = await libraryService.getLibraryRecord(req.params.libraryId);
      if (!library) {
        throw new HttpError(404, "找不到錄音庫。", "MEETING_LIBRARY_NOT_FOUND");
      }
      viewerAuth.setViewer(req, res, library);
      res.json({
        data: toMeetingLibraryPublicInfo(library),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/meetings/admin/libraries/:libraryId/rotate-code",
    async (req, res, next) => {
      try {
        ownerAuth.requireMutationIntent(req);
        const admin = verifyAdminToken(req.header("authorization"));
        const result = await libraryService.rotateCodeForAdmin(req.params.libraryId, {
          adminUsername: admin.username,
          clientIp: clientIp(req),
        });
        res.json({ data: result });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/meetings/recordings/:sessionId/minutes/versions/:versionId/package.zip",
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

  router.get(
    "/meetings/library/recordings/:sessionId/artifacts/:artifactId",
    async (req, res, next) => {
      try {
        const library = await viewerAuth.requireViewer(req);
        const job = await processingService.getJobForSession(
          req.params.sessionId,
          library.libraryId
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

  router.get(
    "/meetings/library/recordings/:sessionId/transcription-artifacts/:artifactId",
    async (req, res, next) => {
      try {
        const library = await viewerAuth.requireViewer(req);
        const job = await transcriptionService.getJobForSession(
          req.params.sessionId,
          library.libraryId
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

  router.get(
    "/meetings/library/recordings/:sessionId/minutes/versions/:versionId/artifacts/:artifactId",
    async (req, res, next) => {
      try {
        const library = await viewerAuth.requireViewer(req);
        const version = await minutesService.getVersion(
          req.params.versionId,
          library.libraryId
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

  router.get(
    "/meetings/library/recordings/:sessionId/minutes/versions/:versionId/package.zip",
    async (req, res, next) => {
      try {
        const library = await viewerAuth.requireViewer(req);
        const version = await minutesService.getVersion(
          req.params.versionId,
          library.libraryId
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

  router.get(
    "/meetings/library/recordings/:sessionId/tracks/:sourceId",
    async (req, res, next) => {
      try {
        const library = await viewerAuth.requireViewer(req);
        const track = await service.resolveTrack(
          req.params.sessionId,
          req.params.sourceId,
          library.libraryId
        );
        res.setHeader("Content-Type", track.mimeType);
        res.setHeader("Content-Length", String(track.sizeBytes));
        const disposition = req.query.download === "1" ? "attachment" : "inline";
        res.setHeader(
          "Content-Disposition",
          `${disposition}; filename="${track.filename}"`
        );
        res.sendFile(track.filePath, (error) => {
          if (error) next(error);
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.get("/meetings/recordings/:sessionId/tracks/:sourceId", async (req, res, next) => {
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

  return router;
}

export default createMeetingRecordingsRouter();
