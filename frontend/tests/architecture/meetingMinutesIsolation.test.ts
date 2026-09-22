import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = path.resolve(process.cwd());
const MEETING_ROOT = path.join(FRONTEND_ROOT, "src/features/meeting-minutes");
const FORBIDDEN_IMPORTS = [
  { label: "work-report feature", pattern: /features[/\\]work-report/ },
  { label: "developer feature", pattern: /features[/\\]dev/ },
];

async function listSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(child)));
    } else if (
      entry.isFile() &&
      (child.endsWith(".ts") || child.endsWith(".tsx")) &&
      !child.endsWith(".test.ts")
    ) {
      files.push(child);
    }
  }
  return files;
}

describe("meeting minutes subsystem boundary", () => {
  it("會議錄音前後端接線不依賴報工或 Dev AI domain", async () => {
    const violations: string[] = [];
    for (const file of await listSourceFiles(MEETING_ROOT)) {
      const content = await readFile(file, "utf8");
      for (const { label, pattern } of FORBIDDEN_IMPORTS) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(FRONTEND_ROOT, file)} matched ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
