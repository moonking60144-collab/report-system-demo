import { Response, Router } from "express";
import { asyncHandler } from "./asyncHandler";
import {
  getLastRagicDefinitionsSyncStatus,
  realtimeEventBus,
  type RealtimeEventPayload,
} from "../events/realtimeEventBus";
import { SERVER_BOOT_ID } from "../observability/serverBootState";
import { SERVER_DEPLOY_VERSION } from "../observability/deployVersionState";
import { workReportClientPresenceStore } from "../observability/workReportClientPresenceStore";
import { workReportDebugLog } from "../observability/workReportDebugLog";
import { resolveRequestClientIdentity } from "../infra/requestClientIdentity";

const realtimeEventsRouter = Router();
const HEARTBEAT_INTERVAL_MS = 20_000;
const activeSseConnections = new Map<string, { closeForShutdown: () => void }>();
let acceptingSseConnections = true;
let activeHeartbeatCount = 0;
let activeEventListenerCount = 0;

export interface RealtimeSseStats {
  acceptingConnections: boolean;
  activeConnectionCount: number;
  activeHeartbeatCount: number;
  activeEventListenerCount: number;
}

export function getRealtimeSseStats(): RealtimeSseStats {
  return {
    acceptingConnections: acceptingSseConnections,
    activeConnectionCount: activeSseConnections.size,
    activeHeartbeatCount,
    activeEventListenerCount,
  };
}

export function closeRealtimeSseConnections(): number {
  acceptingSseConnections = false;
  const activeConnections = Array.from(activeSseConnections.values());
  for (const connection of activeConnections) {
    connection.closeForShutdown();
  }
  return activeConnections.length;
}

function writeSseEvent(
  res: Response,
  eventName: string,
  payload: RealtimeEventPayload | Record<string, unknown>
): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

realtimeEventsRouter.get(
  "/events",
  asyncHandler(async (req, res) => {
    if (!acceptingSseConnections) {
      res.status(503).json({
        error: {
          code: "SERVER_SHUTTING_DOWN",
          message: "伺服器正在關閉，暫不接受新的即時事件連線。",
        },
      });
      return;
    }

    // EventSource 不支援 custom header，clientId / tabId / bootId 走 query string 傳進來
    const debugClientId = String(req.query.clientId ?? "").trim() || null;
    const debugTabId = String(req.query.tabId ?? "").trim() || null;
    const debugBootId = String(req.query.bootId ?? "").trim() || null;
    const sseConnectionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const identity = resolveRequestClientIdentity(req);
    const userAgent = req.get("user-agent") ?? null;

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    writeSseEvent(res, "ready", {
      status: "ok",
      at: new Date().toISOString(),
      bootId: SERVER_BOOT_ID,
      deployVersion: SERVER_DEPLOY_VERSION,
    });
    const lastRagicDefinitionsSyncStatus = getLastRagicDefinitionsSyncStatus();
    if (lastRagicDefinitionsSyncStatus) {
      writeSseEvent(res, "work-report-event", lastRagicDefinitionsSyncStatus);
    }
    workReportDebugLog("sse", "client-connected", {
      sseConnectionId,
      // 保留 clientId 欄位當舊 log grep 相容（指向 debugClientId；沒綁就 fallback 回連線 ID）
      clientId: debugClientId ?? sseConnectionId,
      debugClientId,
      debugTabId,
      ip: identity.effectiveIp,
      userAgent,
    });

    // 有帶 clientId + tabId 才能綁到 presence store；缺任一就只跑純 SSE 不影響 presence
    if (debugClientId && debugTabId) {
      workReportClientPresenceStore.markConnected({
        clientId: debugClientId,
        tabId: debugTabId,
        effectiveIp: identity.effectiveIp,
        userAgent,
        clientBootId: debugBootId,
        serverBootIdAtConnect: SERVER_BOOT_ID,
        deployVersionAtConnect: SERVER_DEPLOY_VERSION,
      });
    }

    const unsubscribe = realtimeEventBus.subscribe((eventPayload) => {
      workReportDebugLog("sse", "broadcast", {
        sseConnectionId,
        clientId: debugClientId ?? sseConnectionId,
        debugClientId,
        debugTabId,
        eventType: eventPayload.type,
        formId: eventPayload.formId ?? null,
        entryId: eventPayload.entryId ?? null,
      });
      try {
        writeSseEvent(res, "work-report-event", eventPayload);
      } catch (error) {
        workReportDebugLog("sse", "broadcast-write-failed", {
          sseConnectionId,
          debugClientId,
          debugTabId,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          req.destroy();
        } catch {
          // ignore
        }
        return;
      }
      // #7: broadcast 到的 client 也 bump lastEventAt，讓 admin 看到該 client 最近有收到事件
      if (debugClientId && debugTabId) {
        try {
          workReportClientPresenceStore.noteSseEventDelivered(debugClientId, debugTabId);
        } catch {
          // ignore — presence 更新失敗不影響 broadcast 本身
        }
      }
    });
    activeEventListenerCount += 1;

    // Heartbeat write 失敗（client 掉線、proxy 斷連）→ 主動 destroy request，觸發 close handler 清 presence
    // 否則要等下個 tick 才發現，presence 可能謊報 online 最多 20s
    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, "ping", {
          at: new Date().toISOString(),
          bootId: SERVER_BOOT_ID,
          deployVersion: SERVER_DEPLOY_VERSION,
        });
      } catch (error) {
        workReportDebugLog("sse", "heartbeat-write-failed", {
          sseConnectionId,
          debugClientId,
          debugTabId,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          req.destroy();
        } catch {
          // ignore
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    activeHeartbeatCount += 1;

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      clearInterval(heartbeat);
      activeHeartbeatCount -= 1;
      unsubscribe();
      activeEventListenerCount -= 1;
      req.removeListener("close", handleRequestClose);
      activeSseConnections.delete(sseConnectionId);
      if (debugClientId && debugTabId) {
        try {
          workReportClientPresenceStore.markDisconnected(
            debugClientId,
            debugTabId,
            identity.effectiveIp
          );
        } catch (error) {
          workReportDebugLog("sse", "mark-disconnected-failed", {
            sseConnectionId,
            debugClientId,
            debugTabId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      workReportDebugLog("sse", "client-disconnected", {
        sseConnectionId,
        // 保留 clientId 欄位當舊 log grep 相容（指向 debugClientId；沒綁就 fallback 回連線 ID）
        clientId: debugClientId ?? sseConnectionId,
        debugClientId,
        debugTabId,
        ip: identity.effectiveIp,
      });
    };
    const handleRequestClose = () => {
      cleanup();
      try {
        res.end();
      } catch {
        // ignore — 連線已斷
      }
    };
    const closeForShutdown = () => {
      try {
        writeSseEvent(res, "shutdown", {
          status: "closing",
          at: new Date().toISOString(),
          bootId: SERVER_BOOT_ID,
          deployVersion: SERVER_DEPLOY_VERSION,
        });
      } catch (error) {
        workReportDebugLog("sse", "shutdown-write-failed", {
          sseConnectionId,
          debugClientId,
          debugTabId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      cleanup();
      try {
        res.end();
      } catch {
        // ignore — 連線已斷
      }
    };

    req.once("close", handleRequestClose);
    activeSseConnections.set(sseConnectionId, { closeForShutdown });
  })
);

export default realtimeEventsRouter;
