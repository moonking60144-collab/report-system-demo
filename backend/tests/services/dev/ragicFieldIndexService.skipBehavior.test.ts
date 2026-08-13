import test from "node:test";
import assert from "node:assert/strict";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createRagicFieldIndexService } from "../../../src/services/dev/ragicFieldIndexService";
import {
  createRagicFieldIndexRepository,
  type RagicFieldIndexRepository,
} from "../../../src/storage/sqlite/ragicFieldIndexRepository";
import { ensureRagicFieldIndexSchema } from "../../../src/storage/sqlite/ragicFieldIndexSchema";
import { resetProgress } from "../../../src/services/dev/ragicFieldIndexProgress";

// 跟 hashSkip.test.ts 一致的最小 sample HTML：兩個欄位、1 表單，足以驗 hash 行為
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

async function buildRepo(): Promise<{ db: Database; repo: RagicFieldIndexRepository }> {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  return { db, repo };
}

/**
 * spy repository：紀錄 replaceAll 被呼叫次數。
 * 真實 IO 仍由底層 repo 處理（in-memory sqlite），不偽造 setState/getState 行為。
 */
function spyRepository(repo: RagicFieldIndexRepository): {
  repo: RagicFieldIndexRepository;
  replaceAllCallCount: () => number;
} {
  let count = 0;
  const wrapped: RagicFieldIndexRepository = {
    ...repo,
    async replaceAll(entries, refreshedAt) {
      count += 1;
      return repo.replaceAll(entries, refreshedAt);
    },
  };
  return {
    repo: wrapped,
    replaceAllCallCount: () => count,
  };
}

test("hash skip integration: 連續兩次 refresh 同份 HTML → 第二次走 skip path 且不重寫索引", async () => {
  resetProgress();
  const { repo } = await buildRepo();
  const spy = spyRepository(repo);

  // fetch spy：每次都回傳相同的 SAMPLE_HTML，並計次
  let fetchCallCount = 0;
  const fetchDocHtml = async (): Promise<string> => {
    fetchCallCount += 1;
    return SAMPLE_HTML;
  };

  const svc = createRagicFieldIndexService({
    repository: spy.repo,
    fetchDocHtml,
  });

  // --- 第一次 refresh：應走完整 path ---
  const counts1 = await svc.refresh();

  const state1 = await repo.getState();
  assert.equal(state1.status, "ready", "第一次完成後 status 應為 ready");
  assert.notEqual(state1.lastDocHash, null, "第一次完成後 lastDocHash 應寫回（非 null）");
  assert.equal(fetchCallCount, 1, "第一次後 fetchDocHtml 呼叫應為 1 次");
  assert.equal(spy.replaceAllCallCount(), 1, "第一次後 replaceAll 應被呼叫 1 次");
  assert.equal(counts1.totalFields, 2, "SAMPLE_HTML 解析出 2 個欄位");

  const firstHash = state1.lastDocHash;

  // --- 第二次 refresh：hash 命中 → 應走 skip path ---
  const counts2 = await svc.refresh();

  const state2 = await repo.getState();
  assert.equal(state2.lastDocHash, firstHash, "第二次後 lastDocHash 應與第一次相同");
  assert.equal(state2.message, "no-changes-skipped", "skip path 應留下 no-changes-skipped 訊息");
  assert.equal(state2.status, "ready", "第二次完成後 status 仍為 ready");
  assert.equal(fetchCallCount, 2, "每次 refresh 都應 fetch，第二次後 fetch 計數應為 2");
  assert.equal(
    spy.replaceAllCallCount(),
    1,
    "skip path 不應呼叫 replaceAll，計數應仍為 1"
  );
  assert.equal(counts2.totalFields, 2, "skip path 仍回傳實際 countAll 結果");

});
