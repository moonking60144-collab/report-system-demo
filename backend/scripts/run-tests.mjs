// 收集 .tmp-test-dist/tests 底下「所有層級」的 *.test.js 交給 node --test。
//
// 不能用 `node --test .tmp-test-dist/tests/**/*.test.js`：npm 的 /bin/sh 沒有
// globstar，`**` 會退化成 `*`，三層目錄（tests/services/dev/）整個漏掉；
// `node --test <目錄>` 在不同 Node 版本遞迴行為也不一致。改用 fs 遞迴自己收，
// 跨平台（Windows server + macOS）且相容 Node 20。
import { readdirSync } from "node:fs";
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
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
