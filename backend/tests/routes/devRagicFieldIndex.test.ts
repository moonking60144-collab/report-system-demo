import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createDevRagicFieldIndexRouter } from "../../src/routes/devRagicFieldIndex";
import { createRagicFieldIndexRepository } from "../../src/storage/sqlite/ragicFieldIndexRepository";
import { ensureRagicFieldIndexSchema } from "../../src/storage/sqlite/ragicFieldIndexSchema";
import { errorHandler } from "../../src/middleware/errorHandler";
import { HttpError } from "../../src/utils/httpError";

const VALID_TOKEN = "test-token-valid";

async function buildEnv() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  let refreshCalls = 0;
  const service = {
    async refresh() {
      refreshCalls += 1;
      await repo.setState({
        status: "ready",
        refreshedAt: "2026-05-08T00:00:00.000Z",
        totalForms: 1,
        totalFields: 2,
        message: null,
      });
      return { totalForms: 1, totalFields: 2 };
    },
    getProgress() {
      return null;
    },
  };

  const verifyToken = (header: string | undefined) => {
    const raw = String(header ?? "").trim();
    if (!raw) {
      throw new HttpError(401, "no token", "NOTICE_TOKEN_MISSING");
    }
    const [scheme, token] = raw.split(/\s+/, 2);
    if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
      throw new HttpError(401, "bad token", "NOTICE_TOKEN_INVALID");
    }
    if (token !== VALID_TOKEN) {
      throw new HttpError(401, "invalid token", "NOTICE_TOKEN_INVALID");
    }
  };

  return {
    db,
    repo,
    service,
    verifyToken,
    getRefreshCalls: () => refreshCalls,
  };
}

async function withTestServer(
  env: Awaited<ReturnType<typeof buildEnv>>,
  run: (baseUrl: string) => Promise<void>
) {
  const app = express();
  app.use(express.json());
  // 與 production 一致：router mount 在精確 prefix，避免 middleware 污染其他 /api/* 路由
  app.use(
    "/api/dev/ragic-fields",
    createDevRagicFieldIndexRouter({
      repository: env.repo,
      service: env.service,
      verifyToken: env.verifyToken,
    })
  );
  app.use(errorHandler);

  const server = await new Promise<Server>((resolve) => {
    const next = app.listen(0, () => resolve(next));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("無 token 直接 GET state 回 401", async () => {
  const env = await buildEnv();
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/state`);
    assert.equal(res.status, 401);
  });
});

test("壞 token 回 401", async () => {
  const env = await buildEnv();
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/state`, {
      headers: { Authorization: `Bearer wrong-token` },
    });
    assert.equal(res.status, 401);
  });
});

test("帶合法 token GET state 回當前狀態", async () => {
  const env = await buildEnv();
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/state`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, "idle");
    // idle 時 autoRefreshing 必為 false
    assert.equal(body.data.autoRefreshing, false);
  });
});

// 業務規則：in-flight refresh 由背景排程擁有時（claimRefresh message="auto-refresh"），
// GET /state 的 autoRefreshing 衍生欄位為 true，前端據此隱藏取消鈕。
test("背景 refresh 進行中 (message=auto-refresh) GET state 回 autoRefreshing:true", async () => {
  const env = await buildEnv();
  await env.repo.setState({ status: "refreshing", message: "auto-refresh" });
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/state`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const body = await res.json();
    assert.equal(body.data.status, "refreshing");
    assert.equal(body.data.autoRefreshing, true);
  });
});

// 業務規則：in-flight refresh 由 route POST 觸發時（claimRefresh message="queued"），
// 屬手動擁有，autoRefreshing 必為 false（取消鈕應顯示）。
test("手動 refresh 進行中 (message=queued) GET state 回 autoRefreshing:false", async () => {
  const env = await buildEnv();
  await env.repo.setState({ status: "refreshing", message: "queued" });
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/state`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const body = await res.json();
    assert.equal(body.data.status, "refreshing");
    assert.equal(body.data.autoRefreshing, false);
  });
});

test("POST refresh 回 202、之後 state 變成 ready 且 service 被呼叫一次", async () => {
  const env = await buildEnv();
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(env.getRefreshCalls(), 1);

    const stateRes = await fetch(`${baseUrl}/api/dev/ragic-fields/state`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const state = await stateRes.json();
    assert.equal(state.data.status, "ready");
    assert.equal(state.data.totalForms, 1);
    assert.equal(state.data.totalFields, 2);
  });
});

test("refreshing 中再 POST refresh 回 409", async () => {
  const env = await buildEnv();
  await env.repo.setState({ status: "refreshing", message: "in flight" });
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.status, 409);
  });
});

test("DELETE refresh 沒在跑時回 200 + aborted:false", async () => {
  const env = await buildEnv();
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/refresh`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.aborted, false);
  });
});

test("DELETE refresh 在 in-flight 時觸發 signal.aborted、回 200 aborted:true", async () => {
  // 自訂一個 long-running refresh stub，會在 signal.aborted=true 時 throw AbortError
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  let observedSignal: AbortSignal | undefined;
  let abortObserved = false;
  const service = {
    async refresh(options?: { signal?: AbortSignal }) {
      observedSignal = options?.signal;
      // 等 signal 被 abort，最多等 1s 防止 hang
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          abortObserved = true;
          resolve();
        };
        if (options?.signal?.aborted) {
          onAbort();
          return;
        }
        options?.signal?.addEventListener("abort", onAbort);
        setTimeout(resolve, 1000);
      });
      if (options?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      return { totalForms: 0, totalFields: 0 };
    },
    getProgress() {
      return null;
    },
  };

  const verifyToken = (header: string | undefined) => {
    const raw = String(header ?? "").trim();
    if (!raw) throw new HttpError(401, "no token", "NOTICE_TOKEN_MISSING");
    const [scheme, token] = raw.split(/\s+/, 2);
    if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
      throw new HttpError(401, "bad token", "NOTICE_TOKEN_INVALID");
    }
    if (token !== VALID_TOKEN) {
      throw new HttpError(401, "invalid token", "NOTICE_TOKEN_INVALID");
    }
  };

  const env = { db, repo, service, verifyToken, getRefreshCalls: () => 0 };
  await withTestServer(env, async (baseUrl) => {
    const start = await fetch(`${baseUrl}/api/dev/ragic-fields/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(start.status, 202);
    // 給 service.refresh 一點時間註冊 abort listener
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(observedSignal, "service.refresh 應該拿到 signal");

    const abortRes = await fetch(`${baseUrl}/api/dev/ragic-fields/refresh`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(abortRes.status, 200);
    const body = await abortRes.json();
    assert.equal(body.data.aborted, true);

    // 等 service.refresh 收尾（abort listener 觸發 → resolve → throw → finally）
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(abortObserved, true);
  });
});

test("GET search 過濾 by q", async () => {
  const env = await buildEnv();
  await env.repo.replaceAll(
    [
      {
        formPath: "default/forms8/104",
        formName: "[104] 工令單",
        scope: "main",
        subtableKey: "1",
        fieldPos: "B1",
        fieldName: "工令單號",
        fieldId: "1005984",
        fieldType: "文字",
      },
      {
        formPath: "default/forms8/105",
        formName: "[105] 報工",
        scope: "main",
        subtableKey: "2",
        fieldPos: "A1",
        fieldName: "單號",
        fieldId: "1234567",
        fieldType: "文字",
      },
    ],
    "2026-05-08T00:00:00.000Z"
  );
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/search?q=104`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].fieldId, "1005984");
  });
});

test("GET search 用 fieldId 精確比對", async () => {
  const env = await buildEnv();
  await env.repo.replaceAll(
    [
      {
        formPath: "default/forms8/104",
        formName: "[104] 工令單",
        scope: "main",
        fieldName: "工令單號",
        fieldId: "1005984",
      },
      {
        formPath: "default/forms8/104",
        formName: "[104] 工令單",
        scope: "main",
        fieldName: "其他",
        fieldId: "1005985",
      },
    ],
    "2026-05-08T00:00:00.000Z"
  );
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/dev/ragic-fields/search?fieldId=1005984`,
      { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
    );
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].fieldName, "工令單號");
  });
});
