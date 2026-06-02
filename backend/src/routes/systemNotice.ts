import { Router } from "express";
import {
  publishSystemNoticeContentUpdated,
  publishSystemNoticeForceRefresh,
} from "../events/realtimeEventBus";
import { asyncHandler } from "./asyncHandler";
import { systemNoticeService } from "../services/systemNoticeService";
import { parseSystemNoticeBearerToken } from "./systemNoticeAuth";
import { HttpError } from "../utils/httpError";

const systemNoticeRouter = Router();

systemNoticeRouter.get(
  "/system-notice",
  asyncHandler(async (_req, res) => {
    const notice = await systemNoticeService.getNotice();
    res.json({ data: notice });
  })
);

systemNoticeRouter.get(
  "/system-notice/version",
  asyncHandler(async (_req, res) => {
    const version = await systemNoticeService.getNoticeVersion();
    res.json({ data: version });
  })
);

systemNoticeRouter.get(
  "/system-notice/session",
  asyncHandler(async (req, res) => {
    const token = parseSystemNoticeBearerToken(req.header("authorization"));
    const session = systemNoticeService.verifyToken(token);
    res.json({ data: session });
  })
);

systemNoticeRouter.get(
  "/system-notice/config",
  asyncHandler(async (_req, res) => {
    // 公開常數（無敏感資訊），不需 token
    const data = systemNoticeService.getAdminConfig();
    res.json({ data });
  })
);

systemNoticeRouter.post(
  "/system-notice/login",
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const username = body?.username;
    const password = body?.password;
    const result = await systemNoticeService.login(username, password);
    res.json({ data: result });
  })
);

systemNoticeRouter.post(
  "/system-notice/change-password",
  asyncHandler(async (req, res) => {
    const token = parseSystemNoticeBearerToken(req.header("authorization"));
    const auth = systemNoticeService.verifyToken(token);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const currentPassword = body.currentPassword;
    const newPassword = body.newPassword;
    const nextUsername = body.nextUsername;
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      throw new HttpError(
        400,
        "currentPassword / newPassword required",
        "NOTICE_CHANGE_PASSWORD_PAYLOAD_INVALID"
      );
    }
    const result = await systemNoticeService.changePassword({
      currentPassword,
      newPassword,
      nextUsername:
        typeof nextUsername === "string" && nextUsername.trim()
          ? nextUsername.trim()
          : undefined,
      actor: auth.username,
    });
    res.json({ data: result });
  })
);

// === 多使用者管理 ===

systemNoticeRouter.get(
  "/system-notice/users",
  asyncHandler(async (req, res) => {
    const token = parseSystemNoticeBearerToken(req.header("authorization"));
    systemNoticeService.verifyToken(token);
    const data = await systemNoticeService.listUsers();
    res.json({ data });
  })
);

systemNoticeRouter.post(
  "/system-notice/users",
  asyncHandler(async (req, res) => {
    const token = parseSystemNoticeBearerToken(req.header("authorization"));
    const auth = systemNoticeService.verifyToken(token);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = body.username;
    const password = body.password;
    if (typeof username !== "string" || typeof password !== "string") {
      throw new HttpError(
        400,
        "username / password required",
        "NOTICE_CREATE_USER_PAYLOAD_INVALID"
      );
    }
    const data = await systemNoticeService.createUser({
      username,
      password,
      actor: auth.username,
    });
    res.status(201).json({ data });
  })
);

systemNoticeRouter.delete(
  "/system-notice/users/:username",
  asyncHandler(async (req, res) => {
    const token = parseSystemNoticeBearerToken(req.header("authorization"));
    const auth = systemNoticeService.verifyToken(token);
    const username = req.params.username;
    if (typeof username !== "string") {
      throw new HttpError(
        400,
        "username required",
        "NOTICE_DELETE_USER_PAYLOAD_INVALID"
      );
    }
    await systemNoticeService.deleteUser({
      username: decodeURIComponent(username),
      actor: auth.username,
    });
    res.json({ data: { ok: true } });
  })
);

systemNoticeRouter.put(
  "/system-notice",
  asyncHandler(async (req, res) => {
    const token = parseSystemNoticeBearerToken(req.header("authorization"));
    const auth = systemNoticeService.verifyToken(token);
    const rawBody = req.body as unknown;

    let payloadForUpdate: unknown = rawBody ?? {};
    let forceRefresh = false;
    if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
      const body = rawBody as Record<string, unknown>;
      const { forceRefresh: forceRefreshInput, ...noticePayload } = body;
      forceRefresh = forceRefreshInput === true;
      payloadForUpdate = noticePayload;
    }

    const notice = await systemNoticeService.updateNotice(payloadForUpdate, auth.username, {
      forceRefresh,
    });
    // 任何 notice 更新都廣播 content-updated（取代前端 /system-notice/version 輪詢）
    publishSystemNoticeContentUpdated(notice.revision);
    if (forceRefresh && notice.forceRefreshToken) {
      publishSystemNoticeForceRefresh(notice.forceRefreshToken);
    }
    res.json({ data: notice });
  })
);

export default systemNoticeRouter;
