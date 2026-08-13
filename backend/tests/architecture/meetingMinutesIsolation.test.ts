import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function listSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(child)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(child);
    }
  }
  return files;
}

test("會議錄音 domain 不引用報工、Form 16、Ragic 或 Dev AI service", async () => {
  const roots = [
    path.resolve("src/services/meeting-minutes"),
    path.resolve("src/routes/meetingRecordings.ts"),
    path.resolve("src/bootstrap/meetingRecordingCleanup.ts"),
    path.resolve("src/storage/meeting-minutes"),
    path.resolve("src/workers"),
  ];
  const forbidden = [
    /services[/\\]work-report/,
    /services[/\\]form16/,
    /services[/\\]dev/,
    /ragic[/\\]client/,
  ];
  const violations: string[] = [];
  for (const root of roots) {
    const files = root.endsWith(".ts") ? [root] : await listSourceFiles(root);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (forbidden.some((pattern) => pattern.test(source))) {
        violations.push(path.relative(process.cwd(), file));
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("Meeting 本機錄音 staging 初始化在 HTTP listen 後背景執行", async () => {
  const source = await readFile(path.resolve("src/server.ts"), "utf8");
  const listenIndex = source.indexOf("app.listen(");
  const initializeIndex = source.indexOf("meetingRecordingStorageService.initialize()");

  assert.notEqual(listenIndex, -1);
  assert.notEqual(initializeIndex, -1);
  assert.ok(initializeIndex > listenIndex);
  assert.doesNotMatch(
    source.slice(0, listenIndex),
    /await\s+meetingRecordingStorageService\.initialize\(\)/
  );
});

test("Windows 本機 backend 明確使用 development，避免 HTTP-IP Secure cookie 失效", async () => {
  const source = await readFile(path.resolve("scripts/run-backend-local.cmd"), "utf8");
  const environmentIndex = source.indexOf('set "NODE_ENV=development"');
  const startIndex = source.indexOf("call npm run dev");

  assert.notEqual(environmentIndex, -1);
  assert.notEqual(startIndex, -1);
  assert.ok(environmentIndex < startIndex);
});
