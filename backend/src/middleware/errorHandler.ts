import { NextFunction, Request, Response } from "express";
import { createLogger } from "../observability/logger";
import { HttpError, UpstreamError } from "../utils/httpError";
import {
  KeyedSerialQueueCapacityError,
  KeyedSerialQueueClosedError,
} from "../utils/keyedSerialQueue";

const log = createLogger("errorHandler");

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof UpstreamError) {
    log.warn({
      event: "UpstreamError",
      path: req.path,
      code: error.code,
      message: error.message,
      detail: error.upstreamDetail,
    });
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  if (error instanceof HttpError) {
    // 業務錯誤（validation / 404 / conflict 等），不 log
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  if (error instanceof KeyedSerialQueueClosedError) {
    res.status(503).json({
      error: {
        code: "SERVER_SHUTTING_DOWN",
        message: "服務正在重新啟動，暫時不接受新的寫入任務。",
      },
    });
    return;
  }

  if (error instanceof KeyedSerialQueueCapacityError) {
    log.warn({
      event: "MutationQueueCapacityExceeded",
      path: req.path,
      reason: error.reason,
      pendingTaskCount: error.pendingTaskCount,
      pendingTaskCountForKey: error.pendingTaskCountForKey,
      oldestPendingTaskAgeMs: error.oldestPendingTaskAgeMs,
    });
    res.status(429).json({
      error: {
        code: "MUTATION_QUEUE_FULL",
        message: "系統正在處理較多寫入任務，請稍後再送出。",
      },
    });
    return;
  }

  log.error({
    event: "UnhandledError",
    path: req.path,
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "伺服器發生未預期錯誤",
    },
  });
}
