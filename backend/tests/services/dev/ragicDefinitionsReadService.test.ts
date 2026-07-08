import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createRagicDefinitionsReadService } from "../../../src/services/dev/ragicDefinitionsReadService";

const execFileAsync = promisify(execFile);

test("read service Git 狀態使用 resolved definitions pathspec", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "ragic-read-git-test-"));
  try {
    const definitionsRoot = join(repoRoot, "tools", "ragic-definitions");
    await mkdir(definitionsRoot, { recursive: true });
    await writeFile(
      join(definitionsRoot, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        counts: { forms: 0, fields: 0, formulas: 0, workflows: 0 },
      }),
      "utf-8"
    );

    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await execFileAsync("git", ["add", "tools/ragic-definitions/manifest.json"], {
      cwd: repoRoot,
    });
    const service = createRagicDefinitionsReadService({
      repoRoot,
      definitionsRoot,
      cacheTtlMs: 0,
    });
    const state = await service.getState();

    assert.equal(state.gitStatus.available, true);
    assert.equal(state.gitStatus.clean, false);
    assert.match(state.gitStatus.entries.join("\n"), /tools\/ragic-definitions/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
