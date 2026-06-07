import { Router } from "express";
import { asyncHandler } from "./asyncHandler";
import { verifySystemNoticeBearerToken } from "./systemNoticeAuth";
import { workReportClientPresenceStore } from "../observability/workReportClientPresenceStore";
import { resolveRequestClientIdentity } from "../infra/requestClientIdentity";
import { SERVER_BOOT_ID } from "../observability/serverBootState";
import { SERVER_DEPLOY_VERSION } from "../observability/deployVersionState";
import { HttpError } from "../utils/httpError";

const debugClientsRouter = Router();
const MAX_DEBUG_CLIENT_ID_LENGTH = 128;
const MAX_DEBUG_TAB_ID_LENGTH = 128;
const MAX_DEBUG_ACTION_LENGTH = 128;

function parseRequiredBoundedValue(
  value: unknown,
  options: {
    fieldName: string;
    maxLength: number;
    missingMessage: string;
    missingCode: string;
    tooLongCode: string;
  }
): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new HttpError(400, options.missingMessage, options.missingCode);
  }
  if (normalized.length > options.maxLength) {
    throw new HttpError(
      400,
      `${options.fieldName} 長度不可超過 ${options.maxLength}`,
      options.tooLongCode
    );
  }
  return normalized;
}

debugClientsRouter.post(
  "/debug/clients/presence",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = parseRequiredBoundedValue(body.clientId, {
      fieldName: "clientId",
      maxLength: MAX_DEBUG_CLIENT_ID_LENGTH,
      missingMessage: "缺少 clientId 或 tabId",
      missingCode: "DEBUG_CLIENT_ID_REQUIRED",
      tooLongCode: "DEBUG_CLIENT_FIELD_TOO_LONG",
    });
    const tabId = parseRequiredBoundedValue(body.tabId, {
      fieldName: "tabId",
      maxLength: MAX_DEBUG_TAB_ID_LENGTH,
      missingMessage: "缺少 clientId 或 tabId",
      missingCode: "DEBUG_CLIENT_ID_REQUIRED",
      tooLongCode: "DEBUG_CLIENT_FIELD_TOO_LONG",
    });

    const identity = resolveRequestClientIdentity(req);
    const presence = workReportClientPresenceStore.upsertPresence({
      clientId,
      tabId,
      ...identity,
      lastSeenAt: new Date().toISOString(),
      currentPath: String(body.currentPath ?? "").trim() || null,
      currentFormId: String(body.currentFormId ?? "").trim() || null,
      currentEntryId: String(body.currentEntryId ?? "").trim() || null,
      currentTopView: String(body.currentTopView ?? "").trim() || null,
      currentLandingPageKey: String(body.currentLandingPageKey ?? "").trim() || null,
      realtimeConnected: body.realtimeConnected === true,
      clientBootId: String(body.clientBootId ?? "").trim() || null,
      serverBootIdAtConnect: SERVER_BOOT_ID,
      deployVersionAtConnect: SERVER_DEPLOY_VERSION,
    });

    const commands = workReportClientPresenceStore.consumeCommands(clientId, tabId);
    res.json({
      data: {
        presence,
        commands,
      },
    });
  })
);

debugClientsRouter.post(
  "/debug/clients/disconnect",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = parseRequiredBoundedValue(body.clientId, {
      fieldName: "clientId",
      maxLength: MAX_DEBUG_CLIENT_ID_LENGTH,
      missingMessage: "缺少 clientId 或 tabId",
      missingCode: "DEBUG_CLIENT_ID_REQUIRED",
      tooLongCode: "DEBUG_CLIENT_FIELD_TOO_LONG",
    });
    const tabId = parseRequiredBoundedValue(body.tabId, {
      fieldName: "tabId",
      maxLength: MAX_DEBUG_TAB_ID_LENGTH,
      missingMessage: "缺少 clientId 或 tabId",
      missingCode: "DEBUG_CLIENT_ID_REQUIRED",
      tooLongCode: "DEBUG_CLIENT_FIELD_TOO_LONG",
    });

    const identity = resolveRequestClientIdentity(req);
    const presence = workReportClientPresenceStore.markDisconnected(clientId, tabId, identity.effectiveIp);
    res.status(202).json({
      data: {
        accepted: true,
        presence,
      },
    });
  })
);

debugClientsRouter.post(
  "/debug/clients/event",
  asyncHandler(async (req, res) => {
    const rawBody = req.body;
    const rawEvents = Array.isArray(rawBody)
      ? rawBody
      : Array.isArray((rawBody as { events?: unknown })?.events)
        ? ((rawBody as { events: unknown[] }).events ?? [])
        : [rawBody];
    if (rawEvents.length === 0) {
      throw new HttpError(400, "缺少 client event 基本欄位", "DEBUG_CLIENT_EVENT_INVALID");
    }

    for (const rawEvent of rawEvents) {
      const body = (rawEvent ?? {}) as Record<string, unknown>;
      const clientId = parseRequiredBoundedValue(body.clientId, {
        fieldName: "clientId",
        maxLength: MAX_DEBUG_CLIENT_ID_LENGTH,
        missingMessage: "缺少 client event 基本欄位",
        missingCode: "DEBUG_CLIENT_EVENT_INVALID",
        tooLongCode: "DEBUG_CLIENT_FIELD_TOO_LONG",
      });
      const tabId = parseRequiredBoundedValue(body.tabId, {
        fieldName: "tabId",
        maxLength: MAX_DEBUG_TAB_ID_LENGTH,
        missingMessage: "缺少 client event 基本欄位",
        missingCode: "DEBUG_CLIENT_EVENT_INVALID",
        tooLongCode: "DEBUG_CLIENT_FIELD_TOO_LONG",
      });
      const action = parseRequiredBoundedValue(body.action, {
        fieldName: "action",
        maxLength: MAX_DEBUG_ACTION_LENGTH,
        missingMessage: "缺少 client event 基本欄位",
        missingCode: "DEBUG_CLIENT_EVENT_INVALID",
        tooLongCode: "DEBUG_CLIENT_FIELD_TOO_LONG",
      });

      workReportClientPresenceStore.recordEvent({
        clientId,
        tabId,
        ts: String(body.ts ?? new Date().toISOString()),
        level:
          body.level === "warn" || body.level === "error" ? body.level : "info",
        category:
          body.category === "ui" ||
          body.category === "api" ||
          body.category === "task" ||
          body.category === "realtime" ||
          body.category === "navigation"
            ? body.category
            : "ui",
        action,
        summary: String(body.summary ?? "").trim() || action,
        formId: String(body.formId ?? "").trim() || undefined,
        entryId: String(body.entryId ?? "").trim() || undefined,
        rowId: String(body.rowId ?? "").trim() || undefined,
        taskId: String(body.taskId ?? "").trim() || undefined,
        operationId: String(body.operationId ?? "").trim() || undefined,
        durationMs:
          typeof body.durationMs === "number" && Number.isFinite(body.durationMs)
            ? body.durationMs
            : undefined,
      });
    }

    res.status(202).json({ data: { accepted: true, count: rawEvents.length } });
  })
);

debugClientsRouter.get(
  "/debug/clients/summary",
  asyncHandler(async (req, res) => {
    verifySystemNoticeBearerToken(req.header("authorization"));
    res.json({ data: workReportClientPresenceStore.getSummary() });
  })
);

debugClientsRouter.get(
  "/debug/clients",
  asyncHandler(async (req, res) => {
    verifySystemNoticeBearerToken(req.header("authorization"));
    res.json({ data: workReportClientPresenceStore.listClients() });
  })
);

debugClientsRouter.get(
  "/debug/clients/:clientId",
  asyncHandler(async (req, res) => {
    verifySystemNoticeBearerToken(req.header("authorization"));
    const clientId = String(req.params.clientId ?? "").trim();
    const tabId = String(req.query.tabId ?? "").trim() || undefined;
    const result = workReportClientPresenceStore.getClient(clientId, tabId);
    res.json({ data: result });
  })
);

debugClientsRouter.post(
  "/debug/clients/:clientId/commands",
  asyncHandler(async (req, res) => {
    const auth = verifySystemNoticeBearerToken(req.header("authorization"));
    const clientId = String(req.params.clientId ?? "").trim();
    if (!clientId) {
      throw new HttpError(400, "缺少 clientId", "DEBUG_CLIENT_ID_REQUIRED");
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = String(body.type ?? "").trim();
    if (
      type !== "force-refresh" &&
      type !== "force-session-expired" &&
      type !== "set-maintenance-message" &&
      type !== "clear-maintenance-message"
    ) {
      throw new HttpError(400, "不支援的 debug command type", "DEBUG_CLIENT_COMMAND_INVALID");
    }

    const command = workReportClientPresenceStore.enqueueCommand({
      clientId,
      tabId: String(body.tabId ?? "").trim() || undefined,
      type,
      createdBy: auth.username,
      message: String(body.message ?? "").trim() || undefined,
      reason: String(body.reason ?? "").trim() || undefined,
    });

    res.json({ data: command });
  })
);

export default debugClientsRouter;
