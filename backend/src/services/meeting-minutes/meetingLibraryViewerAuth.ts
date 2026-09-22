import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../config/env";
import {
  meetingLibraryRepository,
  type MeetingLibraryRecord,
  type MeetingLibraryRepository,
} from "../../storage/meeting-minutes/meetingLibraryRepository";
import { HttpError } from "../../utils/httpError";

const VIEWER_COOKIE_NAME = "meeting_library_viewer_v1";
const VIEWER_COOKIE_PATH = "/api/meetings/library";
const RECORDER_COOKIE_NAME = "meeting_library_recorder_v1";
const RECORDER_COOKIE_PATH = "/api/meetings/recordings";
const SESSION_CAPABILITY_COOKIE_NAME = "meeting_recording_session_v1";
const DEFAULT_VIEWER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const LIBRARY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface MeetingLibraryViewerAuth {
  setViewer(req: Request, res: Response, library: MeetingLibraryRecord): void;
  clearViewer(req: Request, res: Response): void;
  requireViewer(req: Request): Promise<MeetingLibraryRecord>;
  setRecorder(req: Request, res: Response, library: MeetingLibraryRecord): void;
  clearRecorder(req: Request, res: Response): void;
  resolveRecorder(req: Request): Promise<MeetingLibraryRecorderGrant | null>;
  setSessionCapability(
    req: Request,
    res: Response,
    sessionId: string,
    capability: string,
    expiresAtMs: number
  ): void;
  clearSessionCapability(req: Request, res: Response, sessionId: string): void;
  resolveSessionCapability(req: Request, sessionId: string): string | null;
}

export interface MeetingLibraryRecorderGrant {
  library: MeetingLibraryRecord;
  grantId: string;
  expiresAtMs: number;
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function createMeetingLibraryViewerAuth(options: {
  repository?: MeetingLibraryRepository;
  secret?: string;
  secureCookie?: boolean;
  nowMs?: () => number;
  maxAgeMs?: number;
  isSharingEnabled?: () => boolean;
  recorderGrantIdFactory?: () => string;
} = {}): MeetingLibraryViewerAuth {
  const repository = options.repository ?? meetingLibraryRepository;
  const secret = options.secret ?? env.MEETING_RECORDING_OWNER_COOKIE_SECRET;
  const secureCookie = options.secureCookie;
  const nowMs = options.nowMs ?? Date.now;
  const maxAgeMs = Math.max(1_000, Math.trunc(options.maxAgeMs ?? DEFAULT_VIEWER_MAX_AGE_MS));
  const isSharingEnabled =
    options.isSharingEnabled ??
    (() => Buffer.byteLength(env.MEETING_LIBRARY_CODE_PEPPER, "utf8") >= 32);
  const recorderGrantIdFactory = options.recorderGrantIdFactory ?? randomUUID;

  const assertConfigured = () => {
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new HttpError(
        503,
        "錄音庫權限尚未完成設定。",
        "MEETING_LIBRARY_AUTH_NOT_CONFIGURED"
      );
    }
  };

  const viewerSignatureFor = (
    libraryId: string,
    accessVersion: number,
    issuedAtMs: number,
    expiresAtMs: number
  ) =>
    createHmac("sha256", secret)
      .update(
        `meeting-library-viewer-v2.${libraryId}.${accessVersion}.${issuedAtMs}.${expiresAtMs}`
      )
      .digest("base64url");

  const recorderSignatureFor = (
    libraryId: string,
    accessVersion: number,
    grantId: string,
    issuedAtMs: number,
    expiresAtMs: number
  ) =>
    createHmac("sha256", secret)
      .update(
        `meeting-library-recorder-v3.${libraryId}.${accessVersion}.${grantId}.${issuedAtMs}.${expiresAtMs}`
      )
      .digest("base64url");

  const cookieAttributes = (req: Request, path: string, maxAge: number) => {
    const attributes = [
      `Path=${path}`,
      `Max-Age=${maxAge}`,
      "HttpOnly",
      "SameSite=Strict",
    ];
    if (secureCookie ?? (env.NODE_ENV === "production" || req.secure)) {
      attributes.push("Secure");
    }
    return attributes;
  };

  const setViewerCapability = (
    cookieName: string,
    cookiePath: string,
    req: Request,
    res: Response,
    library: MeetingLibraryRecord
  ) => {
    assertConfigured();
    const issuedAtMs = Math.trunc(nowMs());
    const expiresAtMs = issuedAtMs + maxAgeMs;
    const value = `v2.${library.libraryId}.${library.accessVersion}.${issuedAtMs}.${expiresAtMs}.${viewerSignatureFor(
      library.libraryId,
      library.accessVersion,
      issuedAtMs,
      expiresAtMs
    )}`;
    res.append(
      "Set-Cookie",
      [
        `${cookieName}=${value}`,
        ...cookieAttributes(req, cookiePath, Math.ceil(maxAgeMs / 1_000)),
      ].join("; ")
    );
  };

  const setRecorderCapability = (
    req: Request,
    res: Response,
    library: MeetingLibraryRecord
  ) => {
    assertConfigured();
    const grantId = recorderGrantIdFactory();
    if (!LIBRARY_ID_PATTERN.test(grantId)) {
      throw new Error("meeting library recorder grant id is invalid");
    }
    const issuedAtMs = Math.trunc(nowMs());
    const expiresAtMs = issuedAtMs + maxAgeMs;
    const value = `v3.${library.libraryId}.${library.accessVersion}.${grantId}.${issuedAtMs}.${expiresAtMs}.${recorderSignatureFor(
      library.libraryId,
      library.accessVersion,
      grantId,
      issuedAtMs,
      expiresAtMs
    )}`;
    res.append(
      "Set-Cookie",
      [
        `${RECORDER_COOKIE_NAME}=${value}`,
        ...cookieAttributes(
          req,
          RECORDER_COOKIE_PATH,
          Math.ceil(maxAgeMs / 1_000)
        ),
      ].join("; ")
    );
  };

  const clearCapability = (
    cookieName: string,
    cookiePath: string,
    req: Request,
    res: Response
  ) => {
    res.append(
      "Set-Cookie",
      [`${cookieName}=`, ...cookieAttributes(req, cookiePath, 0)].join("; ")
    );
  };

  const sessionCapabilityPath = (sessionId: string) => {
    if (!LIBRARY_ID_PATTERN.test(sessionId)) {
      throw new Error("meeting recording session id is invalid");
    }
    return `${RECORDER_COOKIE_PATH}/${sessionId}`;
  };

  const resolveViewerCapability = async (
    req: Request,
    required: boolean
  ): Promise<MeetingLibraryRecord | null> => {
    const token = readCookie(req.header("cookie"), VIEWER_COOKIE_NAME);
    if (!token && !required) return null;
    assertConfigured();
    if (!isSharingEnabled()) {
      throw new HttpError(
        503,
        "錄音庫分享功能目前未啟用。",
        "MEETING_LIBRARY_ACCESS_NOT_CONFIGURED"
      );
    }
    const [
      version,
      libraryId,
      accessVersionRaw,
      issuedAtRaw,
      expiresAtRaw,
      providedSignature,
      ...extra
    ] = token?.split(".") ?? [];
    const accessVersion = Number(accessVersionRaw);
    const issuedAtMs = Number(issuedAtRaw);
    const expiresAtMs = Number(expiresAtRaw);
    const requiredCode = "MEETING_LIBRARY_VIEWER_REQUIRED";
    const expiredCode = "MEETING_LIBRARY_VIEWER_EXPIRED";
    if (
      version !== "v2" ||
      !libraryId ||
      !LIBRARY_ID_PATTERN.test(libraryId) ||
      !Number.isInteger(accessVersion) ||
      accessVersion <= 0 ||
      !Number.isSafeInteger(issuedAtMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs !== maxAgeMs ||
      !providedSignature ||
      extra.length > 0
    ) {
      throw new HttpError(401, "請先輸入有效的錄音庫存取碼。", requiredCode);
    }
    const expected = Buffer.from(
      viewerSignatureFor(libraryId, accessVersion, issuedAtMs, expiresAtMs),
      "utf8"
    );
    const provided = Buffer.from(providedSignature, "utf8");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new HttpError(401, "請先輸入有效的錄音庫存取碼。", requiredCode);
    }
    if (expiresAtMs <= nowMs()) {
      throw new HttpError(
        401,
        "錄音庫存取權限已過期，請重新輸入存取碼。",
        expiredCode
      );
    }
    const library = await repository.getLibrary(libraryId);
    if (!library || library.revokedAt || library.accessVersion !== accessVersion) {
      throw new HttpError(
        401,
        "錄音庫存取權限已失效，請重新輸入存取碼。",
        expiredCode
      );
    }
    return library;
  };

  const resolveRecorderCapability = async (
    req: Request
  ): Promise<MeetingLibraryRecorderGrant | null> => {
    const token = readCookie(req.header("cookie"), RECORDER_COOKIE_NAME);
    if (!token) return null;
    assertConfigured();
    if (!isSharingEnabled()) {
      throw new HttpError(
        503,
        "錄音庫分享功能目前未啟用。",
        "MEETING_LIBRARY_ACCESS_NOT_CONFIGURED"
      );
    }
    const [
      version,
      libraryId,
      accessVersionRaw,
      grantId,
      issuedAtRaw,
      expiresAtRaw,
      providedSignature,
      ...extra
    ] = token.split(".");
    const accessVersion = Number(accessVersionRaw);
    const issuedAtMs = Number(issuedAtRaw);
    const expiresAtMs = Number(expiresAtRaw);
    if (
      version !== "v3" ||
      !libraryId ||
      !LIBRARY_ID_PATTERN.test(libraryId) ||
      !grantId ||
      !LIBRARY_ID_PATTERN.test(grantId) ||
      !Number.isInteger(accessVersion) ||
      accessVersion <= 0 ||
      !Number.isSafeInteger(issuedAtMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs - issuedAtMs !== maxAgeMs ||
      !providedSignature ||
      extra.length > 0
    ) {
      throw new HttpError(
        401,
        "請先輸入有效的錄音庫存取碼。",
        "MEETING_LIBRARY_RECORDER_REQUIRED"
      );
    }
    const expected = Buffer.from(
      recorderSignatureFor(
        libraryId,
        accessVersion,
        grantId,
        issuedAtMs,
        expiresAtMs
      ),
      "utf8"
    );
    const provided = Buffer.from(providedSignature, "utf8");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new HttpError(
        401,
        "請先輸入有效的錄音庫存取碼。",
        "MEETING_LIBRARY_RECORDER_REQUIRED"
      );
    }
    if (expiresAtMs <= nowMs()) {
      throw new HttpError(
        401,
        "錄音庫存取權限已過期，請重新輸入存取碼。",
        "MEETING_LIBRARY_RECORDER_EXPIRED"
      );
    }
    const library = await repository.getLibrary(libraryId);
    if (!library || library.revokedAt || library.accessVersion !== accessVersion) {
      throw new HttpError(
        401,
        "錄音庫存取權限已失效，請重新輸入存取碼。",
        "MEETING_LIBRARY_RECORDER_EXPIRED"
      );
    }
    return { library, grantId, expiresAtMs };
  };

  return {
    setViewer(req, res, library) {
      setViewerCapability(VIEWER_COOKIE_NAME, VIEWER_COOKIE_PATH, req, res, library);
    },
    clearViewer(req, res) {
      clearCapability(VIEWER_COOKIE_NAME, VIEWER_COOKIE_PATH, req, res);
    },
    async requireViewer(req) {
      return (await resolveViewerCapability(req, true))!;
    },
    setRecorder(req, res, library) {
      setRecorderCapability(req, res, library);
    },
    clearRecorder(req, res) {
      clearCapability(RECORDER_COOKIE_NAME, RECORDER_COOKIE_PATH, req, res);
    },
    resolveRecorder(req) {
      return resolveRecorderCapability(req);
    },
    setSessionCapability(req, res, sessionId, capability, expiresAtMs) {
      if (!SESSION_CAPABILITY_PATTERN.test(capability)) {
        throw new Error("meeting recording session capability is invalid");
      }
      const remainingMs = expiresAtMs - nowMs();
      if (!Number.isSafeInteger(expiresAtMs) || remainingMs <= 0) {
        throw new Error("meeting recording session capability expiry is invalid");
      }
      res.append(
        "Set-Cookie",
        [
          `${SESSION_CAPABILITY_COOKIE_NAME}=${capability}`,
          ...cookieAttributes(
            req,
            sessionCapabilityPath(sessionId),
            Math.ceil(remainingMs / 1_000)
          ),
        ].join("; ")
      );
    },
    clearSessionCapability(req, res, sessionId) {
      clearCapability(
        SESSION_CAPABILITY_COOKIE_NAME,
        sessionCapabilityPath(sessionId),
        req,
        res
      );
    },
    resolveSessionCapability(req, sessionId) {
      sessionCapabilityPath(sessionId);
      return readCookie(req.header("cookie"), SESSION_CAPABILITY_COOKIE_NAME);
    },
  };
}

export const meetingLibraryViewerAuth = createMeetingLibraryViewerAuth();
