import type { Server } from "http";
import cors from "cors";
import express from "express";
import { startBatchCreateRowKeyCleanup } from "./bootstrap/batchCreateRowKeyCleanup";
import { startRecordAuditLogCleanup } from "./bootstrap/recordAuditLogCleanup";
import { startForm16OrphanCleanup } from "./bootstrap/form16OrphanCleanup";
import { startForm16ClientRowKeyCleanup } from "./bootstrap/form16ClientRowKeyCleanup";
import { prewarmFormOptionsOnStartup, prewarmReportFullCacheOnStartup } from "./bootstrap/prewarm";
import { startSqliteAutoSync } from "./bootstrap/sqliteAutoSync";
import { setupFrontendStaticServing } from "./bootstrap/frontendStatic";
import { env } from "./config/env";
import { resolveRequestClientIdentity } from "./infra/requestClientIdentity";
import { demoRateLimit } from "./middleware/demoRateLimit";
import { errorHandler } from "./middleware/errorHandler";
import { workReportClientPresenceStore } from "./observability/workReportClientPresenceStore";
import { startRuntimeHealthLogger } from "./observability/runtimeHealthLogger";
import healthRouter from "./routes/health";
import debugClientsRouter from "./routes/debugClients";
import demoFaultInjectionRouter from "./routes/demoFaultInjection";
import demoResetRouter from "./routes/demoReset";
import devRagicFieldIndexRouter from "./routes/devRagicFieldIndex";
import form16DowntimeRouter from "./routes/form16Downtime";
import itDutyRouter from "./routes/itDuty";
import realtimeEventsRouter from "./routes/realtimeEvents";
import recordAuditLogRouter from "./routes/recordAuditLog";
import systemNoticeRouter from "./routes/systemNotice";
import workReportRouter from "./routes/workReport";
import { createReportTaskService } from "./services/createReportTaskService";
import { workReportTaskRegistryService } from "./services/work-report/workReportTaskRegistryService";
import { sqliteClient } from "./storage/sqlite/sqliteClient";
import { createLogger } from "./observability/logger";

const log = createLogger("server");

// Global safety net — 防止未捕捉的 exception / promise rejection 導致整個 process crash
process.on("uncaughtException", (err) => {
  log.error({ event: "uncaughtException", message: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  log.error({
    event: "unhandledRejection",
    reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
  });
});

const app = express();
// Trust only 1 hop (the immediate reverse proxy — Fly.io / Render edge / nginx).
// 用 boolean true 會盲信整條 X-Forwarded-For chain，讓任何 client 都能偽造
// req.ip 進來繞過 IP 黑名單與 rate limit。明確指定跳數安全得多。
app.set("trust proxy", 1);

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const allowedOrigins = env.CORS_ORIGINS;
      if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS origin not allowed: ${origin}`));
    },
  })
);
// 明確化 body size limit：Express 預設 100kb，這邊顯化為 1mb（報工 payload 最大幾十 KB，足量）
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use((req, res, next) => {
  const path = req.path;
  if (
    path.startsWith("/api/debug/clients") ||
    path.startsWith("/api/system-notice") ||
    path.startsWith("/api/health")
  ) {
    next();
    return;
  }

  const identity = resolveRequestClientIdentity(req);
  const blockedReason = workReportClientPresenceStore.getBlockedReasonByIp(identity.effectiveIp);
  if (!blockedReason) {
    next();
    return;
  }

  if (
    path.startsWith("/api/forms") ||
    path.startsWith("/api/downtime") ||
    path.startsWith("/api/events")
  ) {
    res.status(423).json({
      error: {
        code: "CLIENT_IP_BLOCKED",
        message: blockedReason || "此裝置已被管理端停用",
      },
    });
    return;
  }

  next();
});

app.use("/api", healthRouter);
app.use("/api", debugClientsRouter);
// Demo 防護：rate-limit + control plane（reset/info）只在 DEMO_MODE 啟用，
// production code path 不受影響。Rate limit 必須在所有 mutation route 之前 mount。
if (env.DEMO_MODE) {
  app.use(demoRateLimit);
  app.use("/api", demoResetRouter);
  app.use("/api", demoFaultInjectionRouter);
}
// form16DowntimeRouter 必須在 workReportRouter 之前 mount：
// 前者負責 `/api/forms/16/ragic-callback`，後者通用 `/api/forms/:formId/ragic-callback`，
// Express 按 mount 順序匹配，先 mount 才會先攔到 16 那條。
app.use("/api", form16DowntimeRouter);
app.use("/api", recordAuditLogRouter);
app.use("/api", systemNoticeRouter);
app.use("/api", realtimeEventsRouter);
app.use("/api", itDutyRouter);
// devRagicFieldIndexRouter 內部有 admin auth middleware：
// 一定要 mount 在精確 prefix，避免污染其他 /api/* 路由（曾因 mount 在 /api 全打 401）
app.use("/api/dev/ragic-fields", devRagicFieldIndexRouter);
app.use("/api/forms", workReportRouter);

const { shouldServeFrontend, frontendStaticDir } = setupFrontendStaticServing(app);

app.use(errorHandler);

async function bootstrapServer(): Promise<void> {
  try {
    await createReportTaskService.initialize();
  } catch (error) {
    log.warn({
      event: "create-task.initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await workReportTaskRegistryService.initialize();
  } catch (error) {
    log.warn({
      event: "task-registry.initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const server: Server = app.listen(env.PORT, () => {
    log.info({ event: "listen", port: env.PORT });
    if (shouldServeFrontend) {
      log.info({ event: "frontend-static-enabled", frontendStaticDir });
    }

    prewarmReportFullCacheOnStartup();
    prewarmFormOptionsOnStartup();
    startSqliteAutoSync();
    startBatchCreateRowKeyCleanup();
    startForm16ClientRowKeyCleanup();
    startRecordAuditLogCleanup();
    startForm16OrphanCleanup();
    startRuntimeHealthLogger();
  });

  registerGracefulShutdown(server);
}

// Graceful shutdown：SIGTERM / SIGINT 收到後停止接受新連線、等 in-flight 完成、關閉 SQLite 後再退
function registerGracefulShutdown(server: Server): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ event: "shutdown.begin", signal });

    const forceExitTimer = setTimeout(() => {
      log.warn({ event: "shutdown.force-exit", reason: "timeout 10s" });
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) {
          log.warn({ event: "shutdown.server-close-failed", error: err.message });
        } else {
          log.info({ event: "shutdown.server-closed" });
        }
        resolve();
      });
    });

    await sqliteClient.close();

    log.info({ event: "shutdown.done" });
    clearTimeout(forceExitTimer);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void bootstrapServer();
