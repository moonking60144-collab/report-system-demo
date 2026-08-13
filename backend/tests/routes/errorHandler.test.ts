import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "../../src/middleware/errorHandler";
import {
  KeyedSerialQueueCapacityError,
  KeyedSerialQueueClosedError,
} from "../../src/utils/keyedSerialQueue";

test("response headers 已送出時把下載串流錯誤交回 Express", () => {
  const error = new Error("download stream failed");
  let delegatedError: unknown;
  let statusCalled = false;
  const req = { path: "/api/downtime/export/monthly-csv" } as Request;
  const res = {
    headersSent: true,
    status() {
      statusCalled = true;
      return this;
    },
  } as unknown as Response;
  const next = ((nextError?: unknown) => {
    delegatedError = nextError;
  }) as NextFunction;

  errorHandler(error, req, res, next);

  assert.equal(delegatedError, error);
  assert.equal(statusCalled, false);
});

test("mutation queue 關閉時回 503 typed shutdown error", () => {
  let statusCode = 0;
  let body: unknown;
  const req = { path: "/api/forms/104/reports/1" } as Request;
  const res = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  errorHandler(new KeyedSerialQueueClosedError(), req, res, (() => {}) as NextFunction);

  assert.equal(statusCode, 503);
  assert.deepEqual(body, {
    error: {
      code: "SERVER_SHUTTING_DOWN",
      message: "服務正在重新啟動，暫時不接受新的寫入任務。",
    },
  });
});

test("mutation queue 過載時回 429 typed backpressure error", () => {
  let statusCode = 0;
  let body: unknown;
  const req = { path: "/api/forms/104/reports/1" } as Request;
  const res = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  errorHandler(
    new KeyedSerialQueueCapacityError("total", 500, 20, 30_000),
    req,
    res,
    (() => {}) as NextFunction
  );

  assert.equal(statusCode, 429);
  assert.deepEqual(body, {
    error: {
      code: "MUTATION_QUEUE_FULL",
      message: "系統正在處理較多寫入任務，請稍後再送出。",
    },
  });
});
