/**
 * Demo rate limit — 公開 demo URL 用的輕量保險絲。
 *
 * 設計重點：
 * - 只攔 mutation：POST / PUT / DELETE / PATCH（GET 由 ragicRequestScheduler 的 token bucket 顧）
 * - 只盯需要保護的 prefix（/api/forms/*、/api/downtime/*）
 *   health / system-notice/login / __demo 跳過 — 健康檢查與 demo control plane 不該被限流
 * - per-IP 30 次/分鐘；超過回 429 + Retry-After
 * - 純記憶體 Map：扛不住多 instance，但 demo Fly 機器 scale=1 夠用；不引額外 npm 套件
 * - 過期 entry 不會回收 → 加 lazy cleanup（每次寫入順手清掉舊的）
 *
 * Production code path 不會掛這個 middleware（server.ts 只在 DEMO_MODE=true 才 mount）。
 */

import type { NextFunction, Request, Response } from "express";

interface RateLimitBucket {
  count: number;
  resetAt: number; // epoch ms
}

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;

/** 過期條目超過這個量才觸發 sweep，避免每個請求都 O(N) */
const CLEANUP_THRESHOLD = 1000;

const MUTATION_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const PROTECTED_PREFIXES: readonly string[] = [
  "/api/forms",
  "/api/downtime",
];

/** 完全跳過 — 健康檢查、demo 控制面、login 端點不該被 429 */
const SKIP_PREFIXES: readonly string[] = [
  "/api/health",
  "/api/__demo",
  "/api/system-notice/login",
];

const buckets = new Map<string, RateLimitBucket>();

function shouldEnforce(req: Request): boolean {
  if (!MUTATION_METHODS.has(req.method.toUpperCase())) return false;
  const p = req.path;
  if (SKIP_PREFIXES.some((prefix) => p.startsWith(prefix))) return false;
  return PROTECTED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function resolveClientIp(req: Request): string {
  // 信任 X-Forwarded-For（server.ts 已 set "trust proxy" true）
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  // express 在 trust proxy 開啟時，req.ip 已經是 forwarded chain 的第一個
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function lazyCleanup(now: number): void {
  if (buckets.size < CLEANUP_THRESHOLD) return;
  for (const [ip, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(ip);
  }
}

export function demoRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (!shouldEnforce(req)) {
    next();
    return;
  }

  const now = Date.now();
  lazyCleanup(now);

  const ip = resolveClientIp(req);
  let bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, bucket);
  }

  bucket.count++;

  if (bucket.count > MAX_PER_WINDOW) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    res.setHeader("X-RateLimit-Limit", String(MAX_PER_WINDOW));
    res.setHeader("X-RateLimit-Remaining", "0");
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    res.status(429).json({
      error: {
        code: "DEMO_RATE_LIMIT",
        message: `Demo 限流：每分鐘最多 ${MAX_PER_WINDOW} 次寫入，請 ${retryAfterSec} 秒後再試`,
      },
    });
    return;
  }

  res.setHeader("X-RateLimit-Limit", String(MAX_PER_WINDOW));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, MAX_PER_WINDOW - bucket.count)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  next();
}

/** 測試 / debug 用 — 清空所有 bucket */
export function __resetDemoRateLimitBuckets(): void {
  buckets.clear();
}
