import { NextFunction, Request, Response } from "express";
import { createLogger } from "../observability/logger";
import { HttpError, UpstreamError } from "../utils/httpError";

const log = createLogger("errorHandler");

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
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
