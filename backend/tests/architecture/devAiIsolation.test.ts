import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const BACKEND_ROOT = path.resolve(process.cwd());

const REPORTING_TARGETS = [
  "src/routes/workReport.ts",
  "src/routes/workReportRouteRegistrars.ts",
  "src/routes/workReportRouterFactory.ts",
  "src/routes/workReportRouterTypes.ts",
  "src/services/work-report",
  "src/services/work-report-sync",
  "src/services/form16",
];

const DEV_AI_FORBIDDEN_PATTERNS = [
  { label: "Dev AI service import", pattern: /services[/\\]dev[/\\]ai/ },
  { label: "Dev AI route import", pattern: /routes[/\\]devAi/ },
  { label: "Dev AI symbol", pattern: /\b(?:devAi|DevAi)\b/ },
  { label: "Ragic formula AI service", pattern: /\bragicFormulaAi\b/ },
  { label: "Google Gemini client", pattern: /\b(?:googleGemini|GOOGLE_GEMINI)\b/ },
  { label: "Dev AI environment flag", pattern: /\bDEV_AI_/ },
  { label: "Dev AI API path", pattern: /\/dev\/(?:ai|ragic-definitions\/ai)\b/ },
];

async function listSourceFiles(target: string): Promise<string[]> {
  const absolutePath = path.join(BACKEND_ROOT, target);
  const info = await stat(absolutePath);
  if (!info.isDirectory()) {
    return absolutePath.endsWith(".ts") ? [absolutePath] : [];
  }

  const results: string[] = [];
  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listSourceFiles(path.relative(BACKEND_ROOT, child))));
    } else if (entry.isFile() && child.endsWith(".ts") && !child.endsWith(".test.ts")) {
      results.push(child);
    }
  }
  return results;
}

test("正常報工 backend 資料流不可依賴 Dev AI/RAG/formula assistant", async () => {
  const sourceFiles = (
    await Promise.all(REPORTING_TARGETS.map((target) => listSourceFiles(target)))
  ).flat();
  const violations: string[] = [];

  for (const file of sourceFiles) {
    const content = await readFile(file, "utf8");
    for (const { label, pattern } of DEV_AI_FORBIDDEN_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${path.relative(BACKEND_ROOT, file)} matched ${label}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
