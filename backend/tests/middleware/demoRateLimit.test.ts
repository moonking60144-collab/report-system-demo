import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import {
  __resetDemoRateLimitBuckets,
  demoRateLimit,
} from "../../src/middleware/demoRateLimit";

function invokeRateLimit(path: string, ip = "127.0.0.1") {
  let statusCode = 200;
  let nextCalled = false;
  const headers = new Map<string, string>();
  const request = {
    method: "PUT",
    path,
    headers: {},
    ip,
    socket: { remoteAddress: ip },
  } as unknown as Request;
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return this;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;

  demoRateLimit(request, response, (() => {
    nextCalled = true;
  }) as NextFunction);

  return { headers, nextCalled, statusCode };
}

test("Demo 業務寫入維持每分鐘 30 次上限", () => {
  __resetDemoRateLimitBuckets();
  for (let index = 0; index < 30; index += 1) {
    assert.equal(invokeRateLimit("/api/forms/104/reports/E-104").nextCalled, true);
  }

  const rejected = invokeRateLimit("/api/forms/104/reports/E-104");
  assert.equal(rejected.nextCalled, false);
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.headers.get("X-RateLimit-Limit"), "30");
});

test("editing presence 使用獨立額度，不會耗掉業務寫入限流", () => {
  __resetDemoRateLimitBuckets();
  for (let index = 0; index < 40; index += 1) {
    const result = invokeRateLimit(
      "/api/forms/104/reports/E-104/editing-presence"
    );
    assert.equal(result.nextCalled, true);
    assert.equal(result.headers.get("X-RateLimit-Limit"), "300");
  }

  for (let index = 0; index < 30; index += 1) {
    assert.equal(invokeRateLimit("/api/forms/104/reports/E-104").nextCalled, true);
  }
  assert.equal(invokeRateLimit("/api/forms/104/reports/E-104").statusCode, 429);
});

test("editing presence 超過獨立額度仍會被保護", () => {
  __resetDemoRateLimitBuckets();
  for (let index = 0; index < 300; index += 1) {
    assert.equal(
      invokeRateLimit("/api/forms/104/reports/E-104/editing-presence").nextCalled,
      true
    );
  }

  const rejected = invokeRateLimit(
    "/api/forms/104/reports/E-104/editing-presence"
  );
  assert.equal(rejected.nextCalled, false);
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.headers.get("X-RateLimit-Limit"), "300");
});
