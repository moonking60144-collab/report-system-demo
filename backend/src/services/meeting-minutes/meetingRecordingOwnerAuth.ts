import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";

const OWNER_COOKIE_NAME = "meeting_recording_owner_v1";
const OWNER_COOKIE_PATH = "/api/meetings/recordings";
const OWNER_COOKIE_MAX_AGE_SECONDS = 2 * 365 * 24 * 60 * 60;
const OWNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MeetingRecordingOwnerAuth {
  resolveOrCreateOwner(req: Request, res: Response): string;
  resolveOwner(req: Request): string | null;
  requireOwner(req: Request): string;
  requireMutationIntent(req: Request): void;
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

export function createMeetingRecordingOwnerAuth(options: {
  secret?: string;
  secureCookie?: boolean;
  ownerIdFactory?: () => string;
} = {}): MeetingRecordingOwnerAuth {
  const secret = options.secret ?? env.MEETING_RECORDING_OWNER_COOKIE_SECRET;
  const secureCookie = options.secureCookie;
  const ownerIdFactory = options.ownerIdFactory ?? randomUUID;

  const assertConfigured = () => {
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new HttpError(
        503,
        "會議錄音權限尚未完成設定。",
        "MEETING_RECORDING_AUTH_NOT_CONFIGURED"
      );
    }
  };

  const signatureFor = (ownerId: string) =>
    createHmac("sha256", secret).update(`v1.${ownerId}`).digest("base64url");

  const parseOwner = (req: Request): string | null => {
    assertConfigured();
    const token = readCookie(req.header("cookie"), OWNER_COOKIE_NAME);
    if (!token) return null;
    const [version, ownerId, providedSignature, ...extra] = token.split(".");
    if (
      version !== "v1" ||
      !ownerId ||
      !OWNER_ID_PATTERN.test(ownerId) ||
      !providedSignature ||
      extra.length > 0
    ) {
      return null;
    }
    const expected = Buffer.from(signatureFor(ownerId), "utf8");
    const provided = Buffer.from(providedSignature, "utf8");
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return null;
    }
    return ownerId;
  };

  const setOwnerCookie = (req: Request, res: Response, ownerId: string) => {
    const attributes = [
      `${OWNER_COOKIE_NAME}=v1.${ownerId}.${signatureFor(ownerId)}`,
      `Path=${OWNER_COOKIE_PATH}`,
      `Max-Age=${OWNER_COOKIE_MAX_AGE_SECONDS}`,
      "HttpOnly",
      "SameSite=Strict",
    ];
    if (secureCookie ?? (env.NODE_ENV === "production" || req.secure)) {
      attributes.push("Secure");
    }
    res.append("Set-Cookie", attributes.join("; "));
  };

  return {
    resolveOrCreateOwner(req, res) {
      const existing = parseOwner(req);
      if (existing) return existing;
      const ownerId = ownerIdFactory();
      if (!OWNER_ID_PATTERN.test(ownerId)) {
        throw new Error("meeting recording owner ID factory returned an invalid UUID");
      }
      setOwnerCookie(req, res, ownerId);
      return ownerId;
    },
    resolveOwner(req) {
      return parseOwner(req);
    },
    requireOwner(req) {
      const ownerId = parseOwner(req);
      if (!ownerId) {
        throw new HttpError(
          401,
          "缺少有效的會議錄音裝置憑證。",
          "MEETING_RECORDING_OWNER_REQUIRED"
        );
      }
      return ownerId;
    },
    requireMutationIntent(req) {
      if (req.header("x-meeting-request") !== "1") {
        throw new HttpError(
          403,
          "會議錄音寫入請求缺少來源驗證。",
          "MEETING_RECORDING_REQUEST_HEADER_REQUIRED"
        );
      }
    },
  };
}

export const meetingRecordingOwnerAuth = createMeetingRecordingOwnerAuth();
