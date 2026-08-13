import test from "node:test";
import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { createRagicFieldIndexService } from "../../../src/services/dev/ragicFieldIndexService";
import {
  createRagicFieldIndexRepository,
  type RagicFieldIndexInsertInput,
  type RagicFieldIndexRepository,
} from "../../../src/storage/sqlite/ragicFieldIndexRepository";
import { ensureRagicFieldIndexSchema } from "../../../src/storage/sqlite/ragicFieldIndexSchema";
import { resetProgress } from "../../../src/services/dev/ragicFieldIndexProgress";
import {
  flattenParsedFormsToInsertRows,
  parseRagicDocHtml,
} from "../../../src/services/dev/ragicFieldDocParser";
import { env } from "../../../src/config/env";

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

const FIELD_SEP = "\x1f";
const ROW_SEP = "\x1e";

/**
 * 重現 service 的 entries hash 演算法（排序 + canonical string + streaming sha1）。
 * 測試與實作分別維護，但必須 byte-for-byte 對齊；任一漂移會讓 skip 斷言失效。
 */
function normalizeField(value: string | null | undefined): string {
  return ((value ?? "") + "").normalize("NFC");
}

function canonicalRow(row: RagicFieldIndexInsertInput): string {
  return (
    [
      row.formPath,
      row.formName,
      row.scope,
      row.subtableName,
      row.subtableKey,
      row.fieldPos,
      row.fieldName,
      row.fieldId,
      row.fieldType,
      row.fieldNote,
    ]
      .map(normalizeField)
      .join(FIELD_SEP) + ROW_SEP
  );
}

function compareRows(
  a: RagicFieldIndexInsertInput,
  b: RagicFieldIndexInsertInput
): number {
  const keys: Array<(r: RagicFieldIndexInsertInput) => string | null | undefined> = [
    (r) => r.formPath,
    (r) => r.scope,
    (r) => r.subtableKey,
    (r) => r.subtableName,
    (r) => r.fieldId,
    (r) => r.fieldPos,
  ];
  for (const key of keys) {
    const av = normalizeField(key(a));
    const bv = normalizeField(key(b));
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function entriesHash(rows: RagicFieldIndexInsertInput[]): string {
  const sorted = [...rows].sort(compareRows);
  const hash = createHash("sha1");
  hash.update(sorted.length + ROW_SEP);
  for (const row of sorted) {
    hash.update(canonicalRow(row), "utf8");
  }
  return hash.digest("hex");
}

/** 對一份 doc.jsp HTML 算出其 parsed entries hash（skip 比對用的值）。 */
function entriesHashOf(html: string): string {
  const rows = flattenParsedFormsToInsertRows(parseRagicDocHtml(html).forms);
  return entriesHash(rows);
}

async function buildSvc() {
  const db: Database = await open({ filename: ":memory:", driver: sqlite3.Database });
  await db.exec("PRAGMA foreign_keys=ON;");
  await ensureRagicFieldIndexSchema(db);
  const repo = createRagicFieldIndexRepository(async () => db);
  return { db, repo };
}

/**
 * 包一層 spy repository：紀錄 replaceAll 是否被呼叫過。
 * 真正的 IO 還是落到底層 repo（in-memory sqlite），確保 setState / getState 行為正確。
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

test("hash skip: prior hash 命中且 totalFields>0 → 不呼叫 replaceAll，state 進 ready 訊息為 no-changes-skipped", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  // 先 seed 一份 fake prior state：跟 SAMPLE_HTML 的 hash 一致 + totalFields > 0
  const priorHash = entriesHashOf(SAMPLE_HTML);
  // 用 replaceAll 寫一些 row 讓 totalFields > 0
  await repo.replaceAll(
    [
      {
        formPath: "default/forms8/104",
        formName: "[104] 工令單",
        scope: "main",
        fieldName: "工令單號",
        fieldId: "1005984",
      },
    ],
    "2026-05-08T00:00:00.000Z"
  );
  await repo.setState({
    status: "ready",
    refreshedAt: "2026-05-08T00:00:00.000Z",
    totalForms: 1,
    totalFields: 1,
    message: null,
    lastDocHash: priorHash,
  });

  const spy = spyRepository(repo);
  const svc = createRagicFieldIndexService({
    repository: spy.repo,
    fetchDocHtml: async () => SAMPLE_HTML,
  });
  const counts = await svc.refresh();

  assert.equal(spy.replaceAllCallCount(), 0, "skip path 不應該呼叫 replaceAll");
  assert.equal(counts.totalForms, 1);
  assert.equal(counts.totalFields, 1);
  const state = await repo.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.message, "no-changes-skipped");
  assert.equal(state.lastDocHash, priorHash);
  assert.equal(state.totalForms, 1);
  assert.equal(state.totalFields, 1);
});

test("hash skip: prior hash = null（首次或舊 DB 升級）→ 走完整 refresh、replaceAll 被呼叫、新 hash 寫回", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  // 不 seed lastDocHash，預設 null
  const spy = spyRepository(repo);
  const svc = createRagicFieldIndexService({
    repository: spy.repo,
    fetchDocHtml: async () => SAMPLE_HTML,
  });
  await svc.refresh();

  assert.equal(spy.replaceAllCallCount(), 1, "首次應該走完整 refresh");
  const state = await repo.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.lastDocHash, entriesHashOf(SAMPLE_HTML), "完整 refresh 後 hash 應該寫回 DB");
});

test("hash skip: prior hash 命中但 totalFields=0（被外部清空）→ 仍走完整 refresh", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  const priorHash = entriesHashOf(SAMPLE_HTML);
  // hash 對得上、但 totalFields=0（模擬資料表被外部清空）
  await repo.setState({
    status: "ready",
    refreshedAt: "2026-05-08T00:00:00.000Z",
    totalForms: 0,
    totalFields: 0,
    message: null,
    lastDocHash: priorHash,
  });

  const spy = spyRepository(repo);
  const svc = createRagicFieldIndexService({
    repository: spy.repo,
    fetchDocHtml: async () => SAMPLE_HTML,
  });
  await svc.refresh();

  assert.equal(spy.replaceAllCallCount(), 1, "totalFields=0 時不該 skip");
  const state = await repo.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.totalFields, 2, "完整 refresh 後欄位數應回到 SAMPLE_HTML 的 2 筆");
});

test("hash skip: prior hash 不等於新 hash → 走完整 refresh、新 hash 寫回", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  // 先寫一個假 hash（跟 SAMPLE_HTML 不一樣）
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
  await repo.setState({
    status: "ready",
    refreshedAt: "2026-05-08T00:00:00.000Z",
    totalForms: 1,
    totalFields: 1,
    message: null,
    lastDocHash: "deadbeef0000000000000000000000000000000000",
  });

  const spy = spyRepository(repo);
  const svc = createRagicFieldIndexService({
    repository: spy.repo,
    fetchDocHtml: async () => SAMPLE_HTML,
  });
  await svc.refresh();

  assert.equal(spy.replaceAllCallCount(), 1, "hash 不同時應該走完整 refresh");
  const state = await repo.getState();
  assert.equal(state.lastDocHash, entriesHashOf(SAMPLE_HTML));
  assert.equal(state.totalFields, 2);
});

test("hash skip: RAGIC_FIELD_INDEX_HASH_SKIP=false → escape hatch 生效、即使 hash 相同也走完整 refresh", async () => {
  resetProgress();
  // env 是 `as const` 但 runtime 上是普通 object，cast 強制改值；
  // 跑完一定要還原避免污染後續 test
  const mutableEnv = env as { RAGIC_FIELD_INDEX_HASH_SKIP: boolean };
  const original = mutableEnv.RAGIC_FIELD_INDEX_HASH_SKIP;
  mutableEnv.RAGIC_FIELD_INDEX_HASH_SKIP = false;
  try {
    const { repo } = await buildSvc();
    const priorHash = entriesHashOf(SAMPLE_HTML);
    await repo.replaceAll(
      [
        {
          formPath: "default/forms8/104",
          formName: "[104] 工令單",
          scope: "main",
          fieldName: "工令單號",
          fieldId: "1005984",
        },
      ],
      "2026-05-08T00:00:00.000Z"
    );
    await repo.setState({
      status: "ready",
      refreshedAt: "2026-05-08T00:00:00.000Z",
      totalForms: 1,
      totalFields: 1,
      message: null,
      lastDocHash: priorHash,
    });

    const spy = spyRepository(repo);
    const svc = createRagicFieldIndexService({
      repository: spy.repo,
      fetchDocHtml: async () => SAMPLE_HTML,
    });
    await svc.refresh();

    assert.equal(
      spy.replaceAllCallCount(),
      1,
      "env=false 應跳過 skip path、走完整 refresh"
    );
    const state = await repo.getState();
    assert.equal(state.status, "ready");
    assert.notEqual(
      state.message,
      "no-changes-skipped",
      "escape hatch 不應留下 skip 訊息"
    );
  } finally {
    mutableEnv.RAGIC_FIELD_INDEX_HASH_SKIP = original;
  }
});

test("hash skip: computeEntriesHash throw（crypto 異常）→ fail-open 走完整 refresh、不 crash", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  // 先 seed prior state 模擬「上次成功」
  const priorHash = entriesHashOf(SAMPLE_HTML);
  await repo.replaceAll(
    [
      {
        formPath: "default/forms8/104",
        formName: "[104] 工令單",
        scope: "main",
        fieldName: "工令單號",
        fieldId: "1005984",
      },
    ],
    "2026-05-08T00:00:00.000Z"
  );
  await repo.setState({
    status: "ready",
    refreshedAt: "2026-05-08T00:00:00.000Z",
    totalForms: 1,
    totalFields: 1,
    message: null,
    lastDocHash: priorHash,
  });

  // Monkey-patch crypto.createHash 讓它 throw 一次，service 內 try/catch 應接住
  const originalCreateHash = crypto.createHash;
  let thrown = false;
  (crypto as unknown as { createHash: typeof crypto.createHash }).createHash = ((
    ...args: Parameters<typeof crypto.createHash>
  ) => {
    if (!thrown) {
      thrown = true;
      throw new Error("simulated crypto failure");
    }
    return originalCreateHash(...args);
  }) as typeof crypto.createHash;

  try {
    const spy = spyRepository(repo);
    const svc = createRagicFieldIndexService({
      repository: spy.repo,
      fetchDocHtml: async () => SAMPLE_HTML,
    });
    await svc.refresh();

    assert.equal(thrown, true, "createHash 應該被攔截 throw 過一次");
    assert.equal(
      spy.replaceAllCallCount(),
      1,
      "hash 計算 fail 時 fail-open 走完整 refresh"
    );
    const state = await repo.getState();
    assert.equal(state.status, "ready", "不該 crash 成 error 狀態");
  } finally {
    (crypto as unknown as { createHash: typeof crypto.createHash }).createHash =
      originalCreateHash;
  }
});

test("hash skip: abort signal 在 skip path 觸發 → reject AbortError、state 不被污染", async () => {
  resetProgress();
  const { repo } = await buildSvc();
  // 先 seed prior state，這樣這次 refresh 會走 skip path
  const priorHash = entriesHashOf(SAMPLE_HTML);
  await repo.replaceAll(
    [
      {
        formPath: "default/forms8/104",
        formName: "[104] 工令單",
        scope: "main",
        fieldName: "工令單號",
        fieldId: "1005984",
      },
    ],
    "2026-05-08T00:00:00.000Z"
  );
  await repo.setState({
    status: "ready",
    refreshedAt: "2026-05-08T00:00:00.000Z",
    totalForms: 1,
    totalFields: 1,
    message: null,
    lastDocHash: priorHash,
  });

  const controller = new AbortController();
  // 用 countAll() hook 點：service 進 skip path、過 hash gate 後呼叫 countAll，
  // 在 countAll 回來那瞬間 abort → 下一行 throwIfAborted 應該炸 AbortError
  let countAllCalled = false;
  let setStateCalled = false;
  const hookedRepo: RagicFieldIndexRepository = {
    ...repo,
    async countAll() {
      countAllCalled = true;
      const result = await repo.countAll();
      controller.abort();
      return result;
    },
    async setState(input) {
      // skip path 的 setState 若被呼叫代表 abort 沒生效；
      // 但 catch 區 setState({status:'idle'}) 是合法呼叫
      if (input.status === "ready") {
        setStateCalled = true;
      }
      return repo.setState(input);
    },
  };

  const svc = createRagicFieldIndexService({
    repository: hookedRepo,
    fetchDocHtml: async () => SAMPLE_HTML,
  });

  await assert.rejects(
    () => svc.refresh({ signal: controller.signal }),
    (err) => err instanceof DOMException && err.name === "AbortError"
  );

  assert.equal(countAllCalled, true, "countAll 應該被呼叫過（gate 1 通過）");
  assert.equal(
    setStateCalled,
    false,
    "skip path 的 ready setState 應該被 throwIfAborted 攔下"
  );
  const state = await repo.getState();
  // abort 被 catch 後 setState({status:'idle'})，不會把舊資料弄壞
  assert.equal(state.status, "idle", "abort 後 state 回 idle");
  assert.equal(state.totalFields, 1, "skip path 中止不影響原有 totalFields");
  assert.equal(state.lastDocHash, priorHash, "abort 不應覆寫 lastDocHash");
});

test("entries hash KEY FIX: raw HTML 不同（動態 comment）但欄位定義相同 → 第二次 refresh skip", async () => {
  // 這是 entries hash 取代 raw-HTML hash 的核心理由：doc.jsp 帶動態雜訊
  // （timestamp comment / 廣告片段）時，raw-HTML hash 每次都不同 → 永遠 full refresh；
  // entries hash 只看 parsed 欄位定義 → 雜訊不影響 → 真正命中 skip。
  resetProgress();
  const { repo } = await buildSvc();
  const spy = spyRepository(repo);

  const htmlV1 = SAMPLE_HTML.replace("<html>", "<html><!-- 2026-01-01 -->");
  const htmlV2 = SAMPLE_HTML.replace("<html>", "<html><!-- 2026-01-02 -->");
  // 前提：兩份 raw HTML 真的不同（舊 raw-HTML hash 會誤判成「有變動」）
  assert.notEqual(htmlV1, htmlV2, "兩份 raw HTML 必須不同才測得出 KEY FIX");
  assert.notEqual(
    sha1Utf8(htmlV1),
    sha1Utf8(htmlV2),
    "raw-HTML hash 在動態 comment 下會漂（這正是舊策略的問題）"
  );
  // 但 parsed entries hash 必須相同（欄位定義沒變）
  assert.equal(
    entriesHashOf(htmlV1),
    entriesHashOf(htmlV2),
    "欄位定義相同 → entries hash 必須相同"
  );

  let call = 0;
  const fetchDocHtml = async (): Promise<string> => {
    call += 1;
    return call === 1 ? htmlV1 : htmlV2;
  };
  const svc = createRagicFieldIndexService({ repository: spy.repo, fetchDocHtml });

  // 第一次：full refresh，寫回 entries hash
  await svc.refresh();
  assert.equal(spy.replaceAllCallCount(), 1, "第一次 full refresh");
  const state1 = await repo.getState();
  assert.equal(state1.lastDocHash, entriesHashOf(htmlV1));

  // 第二次：raw HTML 變了（V2），但欄位定義一樣 → entries hash 命中 → skip
  const counts2 = await svc.refresh();
  assert.equal(
    spy.replaceAllCallCount(),
    1,
    "第二次即使 raw HTML 不同，欄位沒變應 skip、不再 replaceAll"
  );
  const state2 = await repo.getState();
  assert.equal(state2.message, "no-changes-skipped", "第二次走 skip path");
  assert.equal(state2.lastDocHash, entriesHashOf(htmlV1), "hash 保持不變");
  assert.equal(counts2.totalFields, 2);
});

function sha1Utf8(html: string): string {
  return createHash("sha1").update(Buffer.from(html, "utf8")).digest("hex");
}
