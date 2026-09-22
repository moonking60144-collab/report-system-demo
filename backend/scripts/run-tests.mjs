// 收集 .tmp-test-dist/tests 底下「所有層級」的 *.test.js 交給 node --test。
//
// 不能用 `node --test .tmp-test-dist/tests/**/*.test.js`：npm 的 /bin/sh 沒有
// globstar，`**` 會退化成 `*`，三層目錄（tests/services/dev/）整個漏掉；
// `node --test <目錄>` 在不同 Node 版本遞迴行為也不一致。改用 fs 遞迴自己收，
// 跨平台（Windows server + macOS）且相容 Node 20。
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function parseTestPathPattern(argv) {
  const prefix = "--testPathPattern=";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
    if (arg === "--testPathPattern") {
      return argv[i + 1] ?? "";
    }
  }
  return "";
}

function matchesPattern(file, pattern) {
  if (!pattern) {
    return true;
  }
  const normalizedFile = file.replaceAll("\\", "/");
  try {
    return new RegExp(pattern).test(normalizedFile);
  } catch {
    return normalizedFile.includes(pattern);
  }
}

function findTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (entry.name.endsWith(".test.js")) {
      results.push(full);
    }
  }
  return results;
}

const pattern = parseTestPathPattern(process.argv.slice(2));
const files = findTestFiles(".tmp-test-dist/tests").filter((file) =>
  matchesPattern(file, pattern)
);
if (files.length === 0) {
  console.error(
    pattern
      ? `[run-tests] 找不到符合 --testPathPattern=${pattern} 的 .test.js`
      : "[run-tests] 找不到任何 .test.js，請先 tsc -p tsconfig.test.json"
  );
  process.exit(1);
}
const testRuntimeDir = mkdtempSync(join(tmpdir(), "ragic-report-backend-tests-"));
const testEnv = {
  ...process.env,
  NODE_ENV: "test",
  RAGIC_PROTOCOL: "http",
  RAGIC_DOMAIN: "127.0.0.1:9",
  RAGIC_API_KEY: "backend-test-only",
  USE_TEST_API_KEY: "false",
  TEST_API_KEY: "backend-test-only",
  ADMIN_API_KEY: "backend-test-only",
  RAGIC_FORM_901_PATH: "/test/form-901",
  RAGIC_FORM_901_TEST_PATH: "/test/form-901",
  RAGIC_FORM_902_PATH: "/test/form-902",
  RAGIC_FORM_902_TEST_PATH: "/test/form-902",
  UPSTREAM_ACTIVITY_LOG_PATH: "/test/activity-log",
  UPSTREAM_ACTIVITY_LOG_TEST_PATH: "/test/activity-log",
  UPSTREAM_ACTIVITY_LOG_SAVE_ACTION_BUTTON_ID: "900001",
  UPSTREAM_ACTIVITY_LOG_WORK_ORDER_FIELD_ID: "900002",
  UPSTREAM_ACTIVITY_LOG_TYPE_FIELD_ID: "900003",
  UPSTREAM_ACTIVITY_LOG_PROCESS_FIELD_ID: "900004",
  UPSTREAM_ACTIVITY_LOG_DEP_FIELD_ID: "900005",
  UPSTREAM_ACTIVITY_LOG_PROD_TYPE_FIELD_ID: "900006",
  UPSTREAM_ACTIVITY_LOG_REMARK_FIELD_ID: "900007",
  UPSTREAM_ACTIVITY_LOG_DATE_FIELD_ID: "900008",
  RAGIC_SOURCE_MACHINE: "/test/source/machines",
  RAGIC_SOURCE_OPERATOR: "/test/source/operators",
  RAGIC_SOURCE_PROCESS: "/test/source/processes",
  RAGIC_WRITE_TARGET: "test",
  SQLITE_TEST_DB_DIR: testRuntimeDir,
  SQLITE_AUTO_SYNC_ENABLED: "false",
  ACTIVITY_LOG_SQLITE_AUTO_SYNC_ENABLED: "false",
  ACTIVITY_LOG_PLANNED_IDLE_SYNC_ENABLED: "false",
  ACTIVITY_LOG_WRITE_REVERIFY_ENABLED: "false",
  CREATE_TASK_PERSIST_ENABLED: "false",
  CREATE_TASK_STORE_FILE: join(testRuntimeDir, "create-report-tasks.json"),
  WORK_REPORT_TASK_REGISTRY_PERSIST_ENABLED: "false",
  WORK_REPORT_TASK_REGISTRY_STORE_FILE: join(testRuntimeDir, "work-report-tasks.json"),
  RAGIC_CALLBACK_TASK_PERSIST_ENABLED: "false",
  RAGIC_CALLBACK_TASK_STORE_FILE: join(testRuntimeDir, "ragic-callback-tasks.json"),
  ACTIVITY_LOG_WRITE_REVERIFY_STORE_FILE: join(testRuntimeDir, "activityLog-write-reverify.json"),
};

let exitCode = 1;
try {
  const result = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    env: testEnv,
  });
  exitCode = result.status ?? 1;
} finally {
  rmSync(testRuntimeDir, { recursive: true, force: true });
}
process.exit(exitCode);
