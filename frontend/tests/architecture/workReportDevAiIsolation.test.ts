import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = path.resolve(process.cwd());

const WORK_REPORT_TARGETS = [
  "src/features/work-report",
  "src/api/workReport.ts",
];

const DEV_AI_FORBIDDEN_PATTERNS = [
  { label: "Dev feature import", pattern: /features[/\\]dev/ },
  { label: "Dev AI component", pattern: /\bRagicDefinitionsAiAssistant\b/ },
  { label: "Dev AI symbol", pattern: /\b(?:devAi|DevAi)\b/ },
  { label: "Dev definitions AI API", pattern: /\/dev\/ragic-definitions\/ai\b/ },
  { label: "Dev AI API", pattern: /\/dev\/ai\b/ },
];

async function listSourceFiles(target: string): Promise<string[]> {
  const absolutePath = path.join(FRONTEND_ROOT, target);
  const info = await stat(absolutePath);
  if (!info.isDirectory()) {
    return absolutePath.endsWith(".ts") || absolutePath.endsWith(".tsx") ? [absolutePath] : [];
  }

  const results: string[] = [];
  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listSourceFiles(path.relative(FRONTEND_ROOT, child))));
    } else if (
      entry.isFile() &&
      (child.endsWith(".ts") || child.endsWith(".tsx")) &&
      !child.endsWith(".test.ts") &&
      !child.endsWith(".test.tsx")
    ) {
      results.push(child);
    }
  }
  return results;
}

describe("work-report 與 Dev AI 邊界", () => {
  it("正常報工 frontend 不依賴 Dev AI/RAG/formula assistant", async () => {
    const sourceFiles = (
      await Promise.all(WORK_REPORT_TARGETS.map((target) => listSourceFiles(target)))
    ).flat();
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = await readFile(file, "utf8");
      for (const { label, pattern } of DEV_AI_FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(FRONTEND_ROOT, file)} matched ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
