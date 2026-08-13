import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createRagicFieldIndexService } from "../../../src/services/dev/ragicFieldIndexService";
import { createRagicFieldIndexRepository } from "../../../src/storage/sqlite/ragicFieldIndexRepository";
import { ensureRagicFieldIndexSchema } from "../../../src/storage/sqlite/ragicFieldIndexSchema";
import {
  getProgress,
  resetProgress,
} from "../../../src/services/dev/ragicFieldIndexProgress";

const SAMPLE_HTML = `
<html><body>
<h3><span style='color:#888;'>表單:</span>[104] 工令單</h3>
表單網址:<a href='https://demo.local/default/forms8/104' target='_blank'>...</a><br/>
<h4>主表單欄位</h4>
主表單Key: 1005987<table class='paramTable'>
<tr><th>欄位位置</th><th>對應欄位</th><th>欄位編號</th><th>欄位型態</th><th>備註</th></tr>
<tr><td>B1</td><td>工令單號</td><td>1005984</td><td>文字</td><td>唯讀</td></tr>
<tr><td>E1</td><td>工令種類</td><td>1006401</td><td>選項</td><td>預設值</td></tr>
</table>
</body></html>
`;

async function buildSvc() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  return { db, repo };
}

test("refresh 成功後 progress 被 reset 為 null、state 進 ready", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  const svc = createRagicFieldIndexService({
    repository: repo,
    fetchDocHtml: async () => SAMPLE_HTML,
  });
  const counts = await svc.refresh();
  assert.equal(counts.totalForms, 1);
  assert.equal(counts.totalFields, 2);
  assert.equal(getProgress(), null);
  const state = await repo.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.totalForms, 1);
  assert.equal(state.totalFields, 2);
});

test("refresh 中 fetchDocHtml 期間，progress 是 downloading shape", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  const captured: Array<ReturnType<typeof getProgress>> = [];
  const svc = createRagicFieldIndexService({
    repository: repo,
    fetchDocHtml: async () => {
      captured.push(getProgress());
      return SAMPLE_HTML;
    },
  });
  await svc.refresh();
  const progressDuringFetch = captured[0];
  assert.ok(progressDuringFetch, "fetchDocHtml 開始時應該已經有 progress");
  assert.equal(progressDuringFetch.phase, "downloading");
  if (progressDuringFetch.phase === "downloading") {
    assert.equal(progressDuringFetch.downloadedBytes, 0);
    assert.equal(progressDuringFetch.totalBytes, null);
    assert.ok(progressDuringFetch.startedAt);
  }
});

test("refresh 被 AbortSignal 中止，throw AbortError、state 回 idle、progress 清空", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  const controller = new AbortController();
  const svc = createRagicFieldIndexService({
    repository: repo,
    fetchDocHtml: async () => {
      // 在 fetchDocHtml 之前先 abort，service 下一個 throwIfAborted 會擋掉
      controller.abort();
      return SAMPLE_HTML;
    },
  });
  await assert.rejects(
    svc.refresh({ signal: controller.signal }),
    (err: unknown) =>
      err instanceof DOMException && err.name === "AbortError"
  );
  assert.equal(getProgress(), null);
  const state = await repo.getState();
  assert.equal(state.status, "idle");
});

test("refresh 在 abort 已觸發時立即跳出（不會跑到 parsing）", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  const controller = new AbortController();
  controller.abort();
  let fetchCalled = false;
  const svc = createRagicFieldIndexService({
    repository: repo,
    fetchDocHtml: async () => {
      fetchCalled = true;
      return SAMPLE_HTML;
    },
  });
  await assert.rejects(
    svc.refresh({ signal: controller.signal }),
    (err: unknown) =>
      err instanceof DOMException && err.name === "AbortError"
  );
  assert.equal(fetchCalled, false, "abort 已觸發時不應該真的 fetch");
});

test("parser 不健康時 throw error、state 進 error、progress 清空", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  // 先寫入一些好資料，確認 parser 失敗時不會被清空
  await repo.replaceAll(
    [
      {
        formPath: "default/forms8/104",
        formName: "舊資料",
        scope: "main",
        fieldName: "x",
        fieldId: "1",
      },
    ],
    "2026-05-08T00:00:00.000Z"
  );
  const svc = createRagicFieldIndexService({
    repository: repo,
    fetchDocHtml: async () => "<html><body>no forms here</body></html>",
  });
  await assert.rejects(svc.refresh());
  assert.equal(getProgress(), null);
  const state = await repo.getState();
  assert.equal(state.status, "error");
  // 舊資料還在
  const counts = await repo.countAll();
  assert.equal(counts.totalFields, 1);
});

// 業務規則：背景排程 (source:"auto") 失敗不得污染成 status:"error" 紅字，
// 必須 settle 成 status:"idle" + "background-refresh-failed:" 前綴 message，
// 保留上一次好資料可見，下一次 claim 能正常接續。
test("背景 refresh 失敗 (source:auto) settle 成 idle 而非 error，message 帶 background-failed 前綴", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  const svc = createRagicFieldIndexService({
    repository: repo,
    fetchDocHtml: async () => "<html><body>no forms here</body></html>",
  });
  await assert.rejects(svc.refresh({ source: "auto" }));
  const state = await repo.getState();
  assert.notEqual(state.status, "error");
  assert.equal(state.status, "idle");
  assert.match(String(state.message), /^background-refresh-failed: /);
});

// 業務規則：手動觸發 (source:"manual" / 預設) 失敗維持 status:"error"，行為不變。
test("手動 refresh 失敗 (預設 source) 仍維持 status:error", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  const svc = createRagicFieldIndexService({
    repository: repo,
    fetchDocHtml: async () => "<html><body>no forms here</body></html>",
  });
  await assert.rejects(svc.refresh());
  const state = await repo.getState();
  assert.equal(state.status, "error");
});
