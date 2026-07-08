import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createDevRagicFieldIndexRouter } from "../../src/routes/devRagicFieldIndex";
import { extractWorkflowJs } from "../../src/services/dev/ragicWorkflowScanService";
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

// ── Workflow 依賴 route（getWorkflowEdgeStats / getWorkflowFormDeps / getWorkflowSource）──

test("extractWorkflowJs 收進 pre/post/approval/sheet-scope 四種 workflow marker", () => {
  const js = extractWorkflowJs(
    [
      "D,1,1,1001,欄位,text=1",
      "PRE_WORKFLOW_START",
      "var pre = db.getAPIQuery('/forms8/104');",
      "D,1,2,1002,非JS欄位,text=1",
      "SCRIPT_START",
      "var post = param.getUpdatedEntry();",
      "APPROVAL_START",
      "var approval = 'ok';",
      "SHEET_SCOPE_START",
      "var sheetScope = 'AIza123456789012345678901234567890';",
    ].join("\n")
  );

  assert.match(js, /PRE_WORKFLOW_START/);
  assert.match(js, /var pre = db\.getAPIQuery/);
  assert.doesNotMatch(js, /非JS欄位/);
  assert.match(js, /SCRIPT_START/);
  assert.match(js, /var post = param\.getUpdatedEntry/);
  assert.match(js, /APPROVAL_START/);
  assert.match(js, /var approval = 'ok'/);
  assert.match(js, /SHEET_SCOPE_START/);
  assert.match(js, /var sheetScope = 'AIza\*\*\*REDACTED\*\*\*'/);
});

async function seedWorkflowGraph(db: Database): Promise<void> {
  await db.run(
    `INSERT INTO ragic_field_index (form_path, form_name, scope, field_pos, field_name, field_id, search_text, refreshed_at)
     VALUES ('default/a/1','表單A','main','A1','本表欄位','5000','x','2026-06-04T00:00:00.000Z')`
  );
  await db.run(
    `INSERT INTO ragic_workflow_edge (src_form_path, scope, edge_type, target_form_path, target_field_id, external_via, external_target, resolved, occur_count, refreshed_at)
     VALUES
       ('default/a/1','button','query','default/c/3',NULL,NULL,NULL,1,3,'2026-06-04T00:00:00.000Z'),
       ('default/a/1','button','set',NULL,'5000',NULL,NULL,0,4,'2026-06-04T00:00:00.000Z'),
       ('default/x/9','post','query','default/a/1',NULL,NULL,NULL,1,5,'2026-06-04T00:00:00.000Z')`
  );
  await db.run(
    `INSERT INTO ragic_workflow_source (form_path, scope, js, char_count, refreshed_at)
     VALUES ('default/a/1','button','function btn(){}',16,'2026-06-04T00:00:00.000Z')`
  );
}

test("GET /workflow/stats 帶 token 回統計（入度榜含被 query 的表）", async () => {
  const env = await buildEnv();
  await seedWorkflowGraph(env.db);
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/workflow/stats`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.queryEdges, 2);
    assert.equal(body.data.setEdges, 1);
    assert.ok(
      body.data.topDepended.some((t: { formPath: string }) => t.formPath === "default/a/1"),
      "a/1 被 x/9 query → 應在入度榜"
    );
  });
});

test("GET /workflow/form 回下游/上游/writes（鎖定本表名）/sourceScopes", async () => {
  const env = await buildEnv();
  await seedWorkflowGraph(env.db);
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(
      `${baseUrl}/api/dev/ragic-fields/workflow/form?path=${encodeURIComponent("default/a/1")}`,
      { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.data.downstreamForms.map((d: { targetFormPath: string }) => d.targetFormPath),
      ["default/c/3"]
    );
    assert.deepEqual(
      body.data.upstreamForms.map((u: { srcFormPath: string }) => u.srcFormPath),
      ["default/x/9"]
    );
    assert.equal(body.data.writes[0].fieldName, "本表欄位");
    assert.deepEqual(body.data.sourceScopes, ["button"]);
  });
});

test("GET /workflow/form 缺 path 回 400", async () => {
  const env = await buildEnv();
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/workflow/form`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.status, 400);
  });
});

test("GET /workflow/source 命中回原文、scope 非法回 400", async () => {
  const env = await buildEnv();
  await seedWorkflowGraph(env.db);
  await withTestServer(env, async (baseUrl) => {
    const hit = await fetch(
      `${baseUrl}/api/dev/ragic-fields/workflow/source?path=${encodeURIComponent("default/a/1")}&scope=button`,
      { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
    );
    assert.equal(hit.status, 200);
    const hitBody = await hit.json();
    assert.equal(hitBody.data.js, "function btn(){}");

    const bad = await fetch(
      `${baseUrl}/api/dev/ragic-fields/workflow/source?path=${encodeURIComponent("default/a/1")}&scope=xxx`,
      { headers: { Authorization: `Bearer ${VALID_TOKEN}` } }
    );
    assert.equal(bad.status, 400);
  });
});

// ── group 聚合 ER 鳥瞰圖（getGroupGraph）──

// 白名單群 forms8 / forms12 各一表；非白名單 'a' 應併入 other。
// 邊：FK forms8→forms12 + FK forms8→forms8（自連）、子表 forms8 掛 forms12 實體、workflow other→forms8。
async function seedGroupGraph(db: Database): Promise<void> {
  await db.run(
    `INSERT INTO ragic_field_index (form_path, form_name, scope, subtable_key, field_name, field_id, search_text, refreshed_at)
     VALUES
       ('default/forms8/1','F8','main','K_F8','f','9001','x','2026-06-04T00:00:00.000Z'),
       ('default/forms12/2','F12','main','K_F12','f','9002','x','2026-06-04T00:00:00.000Z'),
       ('default/a/3','A','main','K_A','f','9003','x','2026-06-04T00:00:00.000Z'),
       ('default/forms8/1','F8','subtable','K_F12','sub','9004','x','2026-06-04T00:00:00.000Z')`
  );
  await db.run(
    `INSERT INTO ragic_field_edge (src_form_path, src_field_id, kind, edge_type, target_form_path, resolved, refreshed_at)
     VALUES
       ('default/forms8/1','9001','data','link','default/forms12/2',1,'2026-06-04T00:00:00.000Z'),
       ('default/forms8/1','9001','data','link','default/forms8/1',1,'2026-06-04T00:00:00.000Z')`
  );
  await db.run(
    `INSERT INTO ragic_workflow_edge (src_form_path, scope, edge_type, target_form_path, target_field_id, external_via, external_target, resolved, occur_count, refreshed_at)
     VALUES ('default/a/3','button','query','default/forms8/1',NULL,NULL,NULL,1,2,'2026-06-04T00:00:00.000Z')`
  );
}

test("GET /edges/group-graph 把表收斂成 group 超級節點、三型跨群邊、群內自連歸 selfEdges", async () => {
  const env = await buildEnv();
  await seedGroupGraph(env.db);
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/edges/group-graph`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const { data } = await res.json();

    // 白名單群 forms8 / forms12 保留原名，非白名單 'a' 併入 other
    const groups = data.nodes.map((n: { group: string }) => n.group).sort();
    assert.deepEqual(groups, ["forms12", "forms8", "other"]);

    const f8 = data.nodes.find((n: { group: string }) => n.group === "forms8");
    assert.equal(f8.formCount, 1, "forms8/1 的 main + subtable 同 form_path → 算 1 張表");
    assert.equal(f8.entityCount, 1);
    assert.equal(f8.selfEdges, 1, "forms8→forms8 的 FK 自連算 selfEdges、不進跨群邊");
    // 群成員表單：抽象 group 要能追回實際 Ragic 表單，route 補 ragicUrl
    assert.equal(f8.forms.length, 1, "forms8 群成員 = default/forms8/1（main + subtable 同 form_path 去重）");
    assert.equal(f8.forms[0].formPath, "default/forms8/1");
    assert.ok(
      String(f8.forms[0].ragicUrl).endsWith("/default/forms8/1"),
      "route 應把 form_path 補成 ragicUrl"
    );

    // 三型跨群邊各一條，且沒有任何 src===dst（自連已歸 selfEdges）
    const keys = data.edges
      .map((e: { type: string; src: string; dst: string }) => `${e.type}:${e.src}->${e.dst}`)
      .sort();
    assert.deepEqual(keys, [
      "fk:forms8->forms12",
      "subtable:forms8->forms12",
      "workflow:other->forms8",
    ]);
    assert.ok(
      data.edges.every((e: { src: string; dst: string }) => e.src !== e.dst),
      "跨群邊不該含自連"
    );
  });
});

test("GET /edges/normalization 用 Link&Load fan-in/out 分主檔/交易檔/葉表", async () => {
  const env = await buildEnv();
  await seedGroupGraph(env.db);
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/edges/normalization`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const { data } = await res.json();
    const find = (p: string) =>
      data.tables.find((t: { formPath: string }) => t.formPath === p);
    // forms8 link 出去 forms12（fan-out 1）+ 有子表 → 交易檔；forms12 被 link（fan-in 1）→ 葉表
    const f8 = find("default/forms8/1");
    const f12 = find("default/forms12/2");
    assert.equal(f8.fanOut, 1);
    assert.equal(f8.hasSubtable, true);
    assert.equal(f8.kind, "transaction");
    assert.equal(f12.fanIn, 1);
    assert.equal(f12.kind, "leaf");
    assert.ok(String(f8.ragicUrl).endsWith("/default/forms8/1"), "route 補 ragicUrl");
  });
});

test("矩陣與正規化體檢排除測試表（form_name 命中 測試/test 等關鍵字）", async () => {
  const env = await buildEnv();
  await env.db.run(
    `INSERT INTO ragic_field_index (form_path, form_name, scope, subtable_key, field_name, field_id, search_text, refreshed_at)
     VALUES
       ('default/forms8/1','正式表','main','K1','f','7001','正式表','2026-06-05T00:00:00.000Z'),
       ('default/forms8/9','需求表(測試中)','main','K9','f','7002','需求表測試中','2026-06-05T00:00:00.000Z')`
  );
  await withTestServer(env, async (baseUrl) => {
    const auth = { headers: { Authorization: `Bearer ${VALID_TOKEN}` } };
    const norm = await (
      await fetch(`${baseUrl}/api/dev/ragic-fields/edges/normalization`, auth)
    ).json();
    const paths = norm.data.tables.map((t: { formPath: string }) => t.formPath);
    assert.ok(paths.includes("default/forms8/1"), "正式表在 audit");
    assert.ok(!paths.includes("default/forms8/9"), "測試表（含『測試中』）被 audit 排除");

    const graph = await (
      await fetch(`${baseUrl}/api/dev/ragic-fields/edges/group-graph`, auth)
    ).json();
    const f8 = graph.data.nodes.find((n: { group: string }) => n.group === "forms8");
    assert.equal(f8.formCount, 1, "forms8 群只算正式表、測試表排除");
    assert.ok(
      !f8.forms.some((x: { formPath: string }) => x.formPath === "default/forms8/9"),
      "測試表不在群成員"
    );
  });
});

test("正規化體檢 SCC 抓出 Link&Load 循環（A⇄B）", async () => {
  const env = await buildEnv();
  await env.db.run(
    `INSERT INTO ragic_field_index (form_path, form_name, scope, subtable_key, field_name, field_id, search_text, refreshed_at)
     VALUES
       ('default/forms8/1','A表','main','KA','f','8001','x','2026-06-05T00:00:00.000Z'),
       ('default/forms12/2','B表','main','KB','f','8002','x','2026-06-05T00:00:00.000Z')`
  );
  await env.db.run(
    `INSERT INTO ragic_field_edge (src_form_path, src_field_id, kind, edge_type, target_form_path, resolved, refreshed_at)
     VALUES
       ('default/forms8/1','8001','data','link','default/forms12/2',1,'2026-06-05T00:00:00.000Z'),
       ('default/forms12/2','8002','data','link','default/forms8/1',1,'2026-06-05T00:00:00.000Z')`
  );
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/edges/normalization`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const { data } = await res.json();
    assert.equal(data.cycles.length, 1, "A⇄B 構成一個循環團");
    const names = data.cycles[0].members
      .map((m: { formName: string }) => m.formName)
      .sort();
    assert.deepEqual(names, ["A表", "B表"]);
    assert.ok(
      String(data.cycles[0].members[0].ragicUrl).includes("/default/"),
      "循環成員補 ragicUrl"
    );
  });
});

test("GET /workflow/stats 無 token 回 401", async () => {
  const env = await buildEnv();
  await withTestServer(env, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/dev/ragic-fields/workflow/stats`);
    assert.equal(res.status, 401);
  });
});
