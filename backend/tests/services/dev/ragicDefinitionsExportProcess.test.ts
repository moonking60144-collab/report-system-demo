import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportRagicDefinitionsInChildProcess } from "../../../src/services/dev/ragicDefinitionsExportProcess";

test("definitions 匯出由獨立子程序完成並產生可讀 baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ragic-definitions-export-process-"));
  const builderRoot = join(root, "builder");
  const outDir = join(root, "definitions");
  const nuiDir = join(builderRoot, "default", "devtest");
  await mkdir(nuiDir, { recursive: true });
  await writeFile(
    join(nuiDir, "51_Sheet51_index.nui"),
    [
      "N,luo test",
      "D,1,2,1036615,編號,text=1",
      "D,7,6,1036641,測試,text=1&f=F6*D6+123456",
    ].join("\n"),
    "utf-8"
  );

  try {
    const result = await exportRagicDefinitionsInChildProcess({
      builderRoot,
      outDir,
      namespaces: "default",
      ragicNuiEncoding: "utf-8",
    });

    assert.equal(result.forms, 1);
    assert.equal(result.fields, 2);
    assert.equal(result.formulas, 1);
    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf-8"));
    assert.equal(manifest.counts.forms, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
