import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { env } from "../../src/config/env";

test("backend 測試使用獨立 SQLite 與不可連到正式 Ragic 的 endpoint", () => {
  const sqliteTestDir = String(process.env.SQLITE_TEST_DB_DIR ?? "").trim();

  assert.equal(env.NODE_ENV, "test");
  assert.ok(sqliteTestDir);
  assert.equal(
    path.dirname(path.resolve(env.SQLITE_DB_FILE)),
    path.resolve(sqliteTestDir)
  );
  assert.equal(env.RAGIC_PROTOCOL, "http");
  assert.equal(env.RAGIC_DOMAIN, "127.0.0.1:9");
  assert.equal(env.RAGIC_API_KEY, "backend-test-only");
  assert.equal(env.CREATE_TASK_PERSIST_ENABLED, false);
  assert.equal(env.WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED, false);
  assert.equal(env.RAGIC_CALLBACK_TASK_PERSIST_ENABLED, false);
  assert.equal(env.SQLITE_AUTO_SYNC_ENABLED, false);
  assert.equal(env.FORM16_SQLITE_AUTO_SYNC_ENABLED, false);
});
