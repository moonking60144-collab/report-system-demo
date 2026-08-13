import type { Server } from "http";
import compression from "compression";
import cors from "cors";
import express from "express";
import {
  startBatchCreateRowKeyCleanup,
  stopBatchCreateRowKeyCleanup,
} from "./bootstrap/batchCreateRowKeyCleanup";
import {
  startEfficiencyReportArchiveCleanup,
  stopEfficiencyReportArchiveCleanup,
} from "./bootstrap/efficiencyReportArchiveCleanup";
import {
  startMeetingRecordingCleanup,
  stopMeetingRecordingCleanup,
} from "./bootstrap/meetingRecordingCleanup";
import {
  startRecordAuditLogCleanup,
  stopRecordAuditLogCleanup,
} from "./bootstrap/recordAuditLogCleanup";
import {
  startForm16OrphanCleanup,
  stopForm16OrphanCleanup,
} from "./bootstrap/form16OrphanCleanup";
import {
  startForm16ClientRowKeyCleanup,
  stopForm16ClientRowKeyCleanup,
} from "./bootstrap/form16ClientRowKeyCleanup";
import {
  prewarmFormOptionsOnStartup,
  prewarmReportFullCacheOnStartup,
  stopFormOptionsPrewarm,
} from "./bootstrap/prewarm";
import { startSqliteAutoSync, stopSqliteAutoSync } from "./bootstrap/sqliteAutoSync";
import {
  startForm16PlannedIdleSync,
  stopForm16PlannedIdleSync,
} from "./bootstrap/form16PlannedIdleSync";
import {
  flushForm16WriteReverify,
  startForm16WriteReverify,
  stopForm16WriteReverify,
} from "./bootstrap/form16WriteReverify";
import {
  startRagicFieldIndexAutoRefresh,
  stopRagicFieldIndexAutoRefresh,
} from "./bootstrap/ragicFieldIndexAutoRefresh";
import {
  startRagicFormulaPatchArtifactCleanup,
  stopRagicFormulaPatchArtifactCleanup,
} from "./bootstrap/ragicFormulaPatchArtifactCleanup";
import {
  startNoticeSessionCleanup,
  stopNoticeSessionCleanup,
} from "./bootstrap/noticeSessionCleanup";
import { setupFrontendStaticServing } from "./bootstrap/frontendStatic";
import { env } from "./config/env";
import { runBackgroundTask } from "./infra/backgroundTaskRunner";
import { resolveRequestClientIdentity } from "./infra/requestClientIdentity";
import { demoRateLimit } from "./middleware/demoRateLimit";
import { errorHandler } from "./middleware/errorHandler";
import { workReportClientPresenceStore } from "./observability/workReportClientPresenceStore";
import {
  startRuntimeHealthLogger,
  stopRuntimeHealthLogger,
} from "./observability/runtimeHealthLogger";
import healthRouter from "./routes/health";
import debugClientsRouter from "./routes/debugClients";
import demoFaultInjectionRouter from "./routes/demoFaultInjection";
import demoResetRouter from "./routes/demoReset";
import devAiRouter from "./routes/devAi";
import devRagicDefinitionsRouter from "./routes/devRagicDefinitions";
import ragicDefinitionsSourceRouter from "./routes/ragicDefinitionsSource";
import devRagicFieldIndexRouter from "./routes/devRagicFieldIndex";
import form16DowntimeRouter from "./routes/form16Downtime";
import form16EfficiencyReportsRouter from "./routes/form16EfficiencyReports";
import itDutyRouter from "./routes/itDuty";
import itSopRouter from "./routes/itSop";
import meetingRecordingsRouter from "./routes/meetingRecordings";
import realtimeEventsRouter, {
  closeRealtimeSseConnections,
  getRealtimeSseStats,
  type RealtimeSseStats,
} from "./routes/realtimeEvents";
import recordAuditLogRouter from "./routes/recordAuditLog";
import systemNoticeRouter from "./routes/systemNotice";
import workReportRouter from "./routes/workReport";
import { createReportTaskService } from "./services/createReportTaskService";
import { form16DowntimeCreateTaskService } from "./services/form16/form16DowntimeCreateTaskService";
import { form16DowntimeCallbackRefreshService } from "./services/form16/form16DowntimeCallbackRefreshService";
import { form16EfficiencyReportArchiveService } from "./services/form16/form16EfficiencyReportArchiveService";
import { meetingRecordingStorageService } from "./services/meeting-minutes/meetingRecordingStorageService";
import { meetingLibraryAccessService } from "./services/meeting-minutes/meetingLibraryAccessService";
import { meetingProcessingService } from "./services/meeting-minutes/meetingProcessingService";
import { ragicCallbackRefreshService } from "./services/ragicCallbackRefreshService";
import {
  startRagicDefinitionsWatch,
  stopRagicDefinitionsWatch,
} from "./services/dev/ragicDefinitionsWatchService";
import { workReportTaskRegistryService } from "./services/work-report/workReportTaskRegistryService";
import {
  closeWorkReportEntryMutationQueueAdmission,
  drainWorkReportEntryMutationQueue,
  getWorkReportEntryMutationQueueStats,
} from "./services/work-report/workReportEntryMutationQueue";
import { systemNoticeService } from "./services/systemNoticeService";
import { sqliteClient } from "./storage/sqlite/sqliteClient";
import { createLogger } from "./observability/logger";
import type { KeyedSerialQueueStats } from "./utils/keyedSerialQueue";

const log = createLogger("server");

type ShutdownTimer = ReturnType<typeof setTimeout>;

interface GracefulShutdownDependencies {
  closeMutationAdmission: () => void;
  closeCallbackAdmission: () => void;
  closeSseConnections: () => number;
  closeServer: () => Promise<void>;
  stopBackgroundWork: () => void;
  drainMutationQueue: () => Promise<void>;
  drainCallbackQueue: () => Promise<void>;
  flushRegistries: () => Promise<void>;
  closeServiceStores: () => Promise<void>;
  closeSqlite: () => Promise<void>;
  getMutationQueueStats: () => KeyedSerialQueueStats;
  getCallbackQueueStats: () => KeyedSerialQueueStats;
  getSseStats: () => RealtimeSseStats;
  logger: {
    info: (fields: Record<string, unknown>) => void;
    warn: (fields: Record<string, unknown>) => void;
  };
  exit: (code: number) => void;
  forceExitTimeoutMs: number;
  drainCheckpointTimeoutMs: number;
  setForceExitTimer: (callback: () => void, timeoutMs: number) => ShutdownTimer;
  clearForceExitTimer: (timer: ShutdownTimer) => void;
}

export function createGracefulShutdownHandler(
  deps: GracefulShutdownDependencies
): (signal: string, exitCode?: number) => Promise<void> {
  let shuttingDown = false;

  return async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    let stage = "close-mutation-admission";
    deps.logger.info({ event: "shutdown.begin", signal });

    const forceExitTimer = deps.setForceExitTimer(() => {
      deps.logger.warn({
        event: "shutdown.force-exit",
        reason: `timeout ${deps.forceExitTimeoutMs}ms`,
        stage,
        mutationQueue: deps.getMutationQueueStats(),
        callbackQueue: deps.getCallbackQueueStats(),
        sse: deps.getSseStats(),
      });
      deps.exit(1);
    }, deps.forceExitTimeoutMs);
    forceExitTimer.unref();

    deps.closeMutationAdmission();
    deps.closeCallbackAdmission();
    stage = "close-sse";
    const closedSseConnectionCount = deps.closeSseConnections();
    deps.logger.info({
      event: "shutdown.sse-closed",
      closedConnectionCount: closedSseConnectionCount,
      sse: deps.getSseStats(),
    });

    stage = "stop-http-and-background";
    const serverClosePromise = deps.closeServer();
    deps.stopBackgroundWork();

    stage = "wait-server-close-and-queue-drain";
    const settlementPromise = Promise.all([
      serverClosePromise,
      deps.drainMutationQueue(),
      deps.drainCallbackQueue(),
    ]);
    let drainCheckpointTimer: ShutdownTimer | null = null;
    const settlementCheckpoint = await Promise.race([
      settlementPromise.then(() => "drained" as const),
      new Promise<"checkpoint">((resolve) => {
        drainCheckpointTimer = deps.setForceExitTimer(
          () => resolve("checkpoint"),
          deps.drainCheckpointTimeoutMs
        );
        drainCheckpointTimer.unref();
      }),
    ]);
    if (drainCheckpointTimer) {
      deps.clearForceExitTimer(drainCheckpointTimer);
    }
    if (settlementCheckpoint === "checkpoint") {
      stage = "drain-checkpoint-flush";
      deps.logger.warn({
        event: "shutdown.drain-slow",
        reason: `timeout ${deps.drainCheckpointTimeoutMs}ms`,
        mutationQueue: deps.getMutationQueueStats(),
        callbackQueue: deps.getCallbackQueueStats(),
      });
      await deps.flushRegistries();
      stage = "wait-server-close-and-queue-drain";
      await settlementPromise;
    }

    stage = "flush-registries";
    await deps.flushRegistries();

    stage = "close-service-stores";
    await deps.closeServiceStores();

    stage = "close-sqlite";
    await deps.closeSqlite();

    stage = "done";
    deps.logger.info({
      event: "shutdown.done",
      mutationQueue: deps.getMutationQueueStats(),
      callbackQueue: deps.getCallbackQueueStats(),
      sse: deps.getSseStats(),
    });
    deps.clearForceExitTimer(forceExitTimer);
    deps.exit(exitCode);
  };
}

// Global safety net：沿用既有 production 行為，只記錄未捕捉錯誤，不主動退出唯一 backend process。
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
app.set("trust proxy", env.TRUST_PROXY);

// gzip 壓縮所有回應；大 JSON payload（reports/full 可達數 MB）壓縮比常 >80%，直接降頻寬。
// 反向代理若已自行 gzip，這層會因 response 已帶 Content-Encoding 而跳過，不會雙重壓縮。
app.use(compression());
app.use(
  cors({
    credentials: true,
    exposedHeaders: ["Content-Disposition"],
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
if (env.DEMO_MODE) {
  app.use(demoRateLimit);
  app.use("/api", demoResetRouter);
  app.use("/api", demoFaultInjectionRouter);
}
// form16DowntimeRouter 必須在 workReportRouter 之前 mount：
// 前者負責 `/api/forms/16/ragic-callback`，後者通用 `/api/forms/:formId/ragic-callback`，
// Express 按 mount 順序匹配，先 mount 才會先攔到 16 那條。
app.use("/api", form16DowntimeRouter);
app.use("/api", form16EfficiencyReportsRouter);
app.use("/api", recordAuditLogRouter);
app.use("/api", systemNoticeRouter);
app.use("/api", realtimeEventsRouter);
app.use("/api", itDutyRouter);
app.use("/api", itSopRouter);
app.use("/api", meetingRecordingsRouter);
// devRagicFieldIndexRouter 內部有 admin auth middleware：
// 一定要 mount 在精確 prefix，避免污染其他 /api/* 路由（曾因 mount 在 /api 全打 401）
app.use("/api/dev/ragic-fields", devRagicFieldIndexRouter);
app.use("/api/dev/ai", devAiRouter);
app.use("/api/dev/ragic-definitions", devRagicDefinitionsRouter);
app.use(
  "/api/integrations/ragic-definitions",
  ragicDefinitionsSourceRouter
);
app.use("/api/forms", workReportRouter);

const { shouldServeFrontend, frontendStaticDir } = setupFrontendStaticServing(app);

app.use(errorHandler);

async function bootstrapServer(): Promise<void> {
  try {
    await workReportTaskRegistryService.initialize();
  } catch (error) {
    log.warn({
      event: "task-registry.initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await createReportTaskService.initialize();
  } catch (error) {
    log.warn({
      event: "create-task.initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await form16DowntimeCreateTaskService.initialize();
  } catch (error) {
    log.warn({
      event: "form16-downtime-create-task.initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await form16DowntimeCallbackRefreshService.initialize();
  } catch (error) {
    log.warn({
      event: "form16-downtime-callback.initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await ragicCallbackRefreshService.initialize();
  } catch (error) {
    log.warn({
      event: "ragic-callback.initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await systemNoticeService.initialize();
  } catch (error) {
    log.warn({
      event: "system-notice.initialize-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await form16EfficiencyReportArchiveService.initialize();
  } catch (error) {
    log.warn({
      event: "efficiency-report-archive.initialize-failed",
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
    startForm16PlannedIdleSync();
    startForm16WriteReverify();
    startRagicFieldIndexAutoRefresh();
    startRagicDefinitionsWatch();
    startBatchCreateRowKeyCleanup();
    startForm16ClientRowKeyCleanup();
    startRecordAuditLogCleanup();
    startForm16OrphanCleanup();
    startRagicFormulaPatchArtifactCleanup();
    startNoticeSessionCleanup();
    startRuntimeHealthLogger();
    startEfficiencyReportArchiveCleanup();
    runBackgroundTask(
      "meeting-recording-storage.initialize",
      () => meetingRecordingStorageService.initialize()
    );
    startMeetingRecordingCleanup();
  });

  registerGracefulShutdown(server);
}

// Graceful shutdown：SIGTERM / SIGINT 收到後停止接受新連線、等 in-flight 完成、關閉 SQLite 後再退
function registerGracefulShutdown(server: Server): void {
  const shutdown = createGracefulShutdownHandler({
    closeMutationAdmission: closeWorkReportEntryMutationQueueAdmission,
    closeCallbackAdmission: () => {
      ragicCallbackRefreshService.closeAdmission();
      form16DowntimeCallbackRefreshService.closeAdmission();
    },
    closeSseConnections: closeRealtimeSseConnections,
    closeServer: () =>
      new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) {
            log.warn({ event: "shutdown.server-close-failed", error: err.message });
          } else {
            log.info({ event: "shutdown.server-closed" });
          }
          resolve();
        });
      }),
    stopBackgroundWork: () => {
      stopFormOptionsPrewarm();
      stopSqliteAutoSync();
      stopForm16PlannedIdleSync();
      stopForm16WriteReverify();
      stopRagicFieldIndexAutoRefresh();
      stopRagicDefinitionsWatch();
      stopBatchCreateRowKeyCleanup();
      stopForm16ClientRowKeyCleanup();
      stopRecordAuditLogCleanup();
      stopForm16OrphanCleanup();
      stopRagicFormulaPatchArtifactCleanup();
      stopNoticeSessionCleanup();
      stopRuntimeHealthLogger();
      stopEfficiencyReportArchiveCleanup();
      stopMeetingRecordingCleanup();
    },
    drainMutationQueue: drainWorkReportEntryMutationQueue,
    drainCallbackQueue: async () => {
      await Promise.all([
        ragicCallbackRefreshService.drain(),
        form16DowntimeCallbackRefreshService.drain(),
      ]);
    },
    flushRegistries: async () => {
      await ragicCallbackRefreshService.flush();
      await createReportTaskService.flush();
      await workReportTaskRegistryService.flush();
      await flushForm16WriteReverify();
    },
    closeServiceStores: async () => {
      await form16EfficiencyReportArchiveService.close();
      await meetingProcessingService.close();
      await meetingLibraryAccessService.close();
    },
    closeSqlite: () => sqliteClient.close(),
    getMutationQueueStats: getWorkReportEntryMutationQueueStats,
    getCallbackQueueStats: () => {
      const workReport = ragicCallbackRefreshService.getQueueStats();
      const form16 = form16DowntimeCallbackRefreshService.getQueueStats();
      return {
        accepting: workReport.accepting && form16.accepting,
        activeKeyCount: workReport.activeKeyCount + form16.activeKeyCount,
        pendingTaskCount: workReport.pendingTaskCount + form16.pendingTaskCount,
      };
    },
    getSseStats: getRealtimeSseStats,
    logger: log,
    exit: (code) => process.exit(code),
    forceExitTimeoutMs: 10_000,
    drainCheckpointTimeoutMs: 6_000,
    setForceExitTimer: setTimeout,
    clearForceExitTimer: clearTimeout,
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (require.main === module) {
  void bootstrapServer();
}
