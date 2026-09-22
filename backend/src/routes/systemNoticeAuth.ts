import { HttpError } from "../utils/httpError";
import { systemNoticeService } from "../services/systemNoticeService";

export function parseSystemNoticeBearerToken(authorizationHeader: string | undefined): string {
  const raw = String(authorizationHeader ?? "").trim();
  if (!raw) {
    throw new HttpError(401, "缺少授權資訊", "NOTICE_TOKEN_MISSING");
  }
  const [scheme, token] = raw.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    throw new HttpError(401, "授權格式錯誤，需使用 Bearer token", "NOTICE_TOKEN_INVALID");
  }
  return token;
}

export function verifySystemNoticeBearerToken(authorizationHeader: string | undefined) {
  const token = parseSystemNoticeBearerToken(authorizationHeader);
  return systemNoticeService.verifyToken(token);
}
