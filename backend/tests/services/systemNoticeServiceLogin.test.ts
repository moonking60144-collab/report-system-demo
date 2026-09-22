import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { env } from "../../src/config/env";
import { HttpError } from "../../src/utils/httpError";
import {
  systemNoticeService,
  type SystemNoticeRecord,
} from "../../src/services/systemNoticeService";
import { systemNoticeLoginRateLimiter } from "../../src/services/auth/loginRateLimiter";
import { noticeSessionsRepository } from "../../src/storage/sqlite/noticeSessionsRepository";

function legacyHash(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("hex");
}

test("system notice login：同一 client/user 失敗達上限後回 429", async (t) => {
  systemNoticeLoginRateLimiter.reset();
  t.after(() => {
    systemNoticeLoginRateLimiter.reset();
  });

  const serviceInternals = systemNoticeService as unknown as {
    assertAuthConfigured: () => Promise<void>;
    resolveCredentialsByUsername: (username: string) => Promise<{
      username: string;
      passwordHash: string;
      isEnvFallback: boolean;
    }>;
  };
  t.mock.method(serviceInternals, "assertAuthConfigured", async () => undefined);
  t.mock.method(serviceInternals, "resolveCredentialsByUsername", async () => ({
    username: "admin",
    passwordHash: legacyHash("correct-password"),
    isEnvFallback: true,
  }));

  const loginWithWrongPassword = () =>
    systemNoticeService.login("admin", "wrong-password", {
      rateLimitKey: "127.0.0.1",
    });

  for (let attempt = 0; attempt < env.NOTICE_LOGIN_MAX_FAILURES - 1; attempt += 1) {
    await assert.rejects(
      loginWithWrongPassword,
      (error) =>
        error instanceof HttpError &&
        error.statusCode === 401 &&
        error.code === "NOTICE_LOGIN_INVALID"
    );
  }

  await assert.rejects(
    loginWithWrongPassword,
    (error) =>
      error instanceof HttpError &&
      error.statusCode === 429 &&
      error.code === "NOTICE_LOGIN_RATE_LIMITED"
  );
});

test("system notice login：持久化 digest，不保存可重放 raw token", async (t) => {
  systemNoticeLoginRateLimiter.reset();
  t.after(() => {
    systemNoticeLoginRateLimiter.reset();
  });

  const serviceInternals = systemNoticeService as unknown as {
    tokenSessions: Map<string, { username: string; expiresAtMs: number }>;
    assertAuthConfigured: () => Promise<void>;
    resolveCredentialsByUsername: (username: string) => Promise<{
      username: string;
      passwordHash: string;
      isEnvFallback: boolean;
    }>;
  };
  const previousSessions = new Map(serviceInternals.tokenSessions);
  serviceInternals.tokenSessions.clear();
  t.after(() => {
    serviceInternals.tokenSessions.clear();
    for (const [key, value] of previousSessions.entries()) {
      serviceInternals.tokenSessions.set(key, value);
    }
  });

  t.mock.method(serviceInternals, "assertAuthConfigured", async () => undefined);
  t.mock.method(serviceInternals, "resolveCredentialsByUsername", async () => ({
    username: "admin",
    passwordHash: legacyHash("correct-password"),
    isEnvFallback: true,
  }));

  let persistedToken = "";
  t.mock.method(noticeSessionsRepository, "insert", async (input: {
    token: string;
    username: string;
    expiresAtMs: number;
  }) => {
    persistedToken = input.token;
  });

  const result = await systemNoticeService.login("admin", "correct-password", {
    rateLimitKey: "127.0.0.1",
  });

  assert.match(result.token, /^[0-9a-f]{64}$/);
  assert.notEqual(persistedToken, result.token);
  assert.match(persistedToken, /^sha256:[0-9a-f]{64}$/);
  assert.equal(serviceInternals.tokenSessions.has(result.token), false);
  assert.equal(serviceInternals.tokenSessions.has(persistedToken), true);
  assert.equal(systemNoticeService.verifyToken(result.token).username, "admin");
});

test("system notice update：落盤失敗時不更新 in-memory notice", async (t) => {
  const serviceInternals = systemNoticeService as unknown as {
    notice: SystemNoticeRecord;
    loaded: boolean;
    loadPromise: Promise<void> | null;
    updateChain: Promise<void>;
    persistChain: Promise<void>;
    persistToDisk: (notice?: SystemNoticeRecord) => Promise<void>;
  };
  const previousNotice = serviceInternals.notice;
  const previousLoaded = serviceInternals.loaded;
  const previousLoadPromise = serviceInternals.loadPromise;
  const previousUpdateChain = serviceInternals.updateChain;
  const previousPersistChain = serviceInternals.persistChain;
  const stableNotice: SystemNoticeRecord = {
    enabled: false,
    level: "info",
    title: "舊通知",
    message: "",
    maintenanceMode: false,
    maintenanceDecision: "auto",
    maintenanceSuggested: false,
    maintenanceSuggestedReasons: [],
    startAt: null,
    endAt: null,
    linkText: null,
    linkUrl: null,
    updatedAt: "2026-06-30T00:00:00.000Z",
    updatedBy: "system",
    revision: 7,
    forceRefreshToken: null,
  };

  serviceInternals.notice = stableNotice;
  serviceInternals.loaded = true;
  serviceInternals.loadPromise = null;
  serviceInternals.updateChain = Promise.resolve();
  serviceInternals.persistChain = Promise.resolve();
  t.after(() => {
    serviceInternals.notice = previousNotice;
    serviceInternals.loaded = previousLoaded;
    serviceInternals.loadPromise = previousLoadPromise;
    serviceInternals.updateChain = previousUpdateChain;
    serviceInternals.persistChain = previousPersistChain;
  });

  t.mock.method(serviceInternals, "persistToDisk", async () => {
    throw new Error("disk full");
  });

  await assert.rejects(
    () => systemNoticeService.updateNotice({ title: "新通知" }, "tester"),
    /disk full/
  );

  const after = await systemNoticeService.getNotice();
  assert.equal(after.title, "舊通知");
  assert.equal(after.revision, 7);
});

test("system notice update：並發更新需用最新 notice 序列化計算", async (t) => {
  const serviceInternals = systemNoticeService as unknown as {
    notice: SystemNoticeRecord;
    loaded: boolean;
    loadPromise: Promise<void> | null;
    updateChain: Promise<void>;
    persistChain: Promise<void>;
    persistToDisk: (notice?: SystemNoticeRecord) => Promise<void>;
  };
  const previousNotice = serviceInternals.notice;
  const previousLoaded = serviceInternals.loaded;
  const previousLoadPromise = serviceInternals.loadPromise;
  const previousUpdateChain = serviceInternals.updateChain;
  const previousPersistChain = serviceInternals.persistChain;
  const stableNotice: SystemNoticeRecord = {
    enabled: false,
    level: "info",
    title: "舊通知",
    message: "",
    maintenanceMode: false,
    maintenanceDecision: "auto",
    maintenanceSuggested: false,
    maintenanceSuggestedReasons: [],
    startAt: null,
    endAt: null,
    linkText: null,
    linkUrl: null,
    updatedAt: "2026-06-30T00:00:00.000Z",
    updatedBy: "system",
    revision: 7,
    forceRefreshToken: null,
  };

  serviceInternals.notice = stableNotice;
  serviceInternals.loaded = true;
  serviceInternals.loadPromise = null;
  serviceInternals.updateChain = Promise.resolve();
  serviceInternals.persistChain = Promise.resolve();
  t.after(() => {
    serviceInternals.notice = previousNotice;
    serviceInternals.loaded = previousLoaded;
    serviceInternals.loadPromise = previousLoadPromise;
    serviceInternals.updateChain = previousUpdateChain;
    serviceInternals.persistChain = previousPersistChain;
  });

  const persisted: SystemNoticeRecord[] = [];
  const releaseFirstPersistCallbacks: Array<() => void> = [];
  const firstPersistStarted = new Promise<void>((resolve) => {
    t.mock.method(serviceInternals, "persistToDisk", async (notice?: SystemNoticeRecord) => {
      assert.ok(notice);
      persisted.push({ ...notice });
      if (persisted.length === 1) {
        resolve();
        await new Promise<void>((release) => {
          releaseFirstPersistCallbacks.push(release);
        });
      }
    });
  });

  const firstUpdate = systemNoticeService.updateNotice({ title: "第一個通知" }, "admin-a");
  await firstPersistStarted;
  const secondUpdate = systemNoticeService.updateNotice({ message: "第二個訊息" }, "admin-b");
  assert.equal(persisted.length, 1);

  assert.equal(releaseFirstPersistCallbacks.length, 1);
  releaseFirstPersistCallbacks[0]();
  const [firstResult, secondResult] = await Promise.all([firstUpdate, secondUpdate]);

  assert.equal(firstResult.title, "第一個通知");
  assert.equal(firstResult.revision, 8);
  assert.equal(secondResult.title, "第一個通知");
  assert.equal(secondResult.message, "第二個訊息");
  assert.equal(secondResult.revision, 9);
  assert.equal(persisted.length, 2);

  const after = await systemNoticeService.getNotice();
  assert.equal(after.title, "第一個通知");
  assert.equal(after.message, "第二個訊息");
  assert.equal(after.revision, 9);
});
