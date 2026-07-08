import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportRagicDefinitions } from "../../../src/services/dev/ragicDefinitionsExportService";

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "ragic-export-test-"));
  const builderRoot = join(root, "builder");
  const outDir = join(root, "ragic-definitions");
  const formDir = join(builderRoot, "default", "devtest");
  await mkdir(formDir, { recursive: true });
  await writeFile(
    join(formDir, "51_Sheet1_index.nui"),
    [
      "N,luo test",
      "D,1,2,1036615,編號,f=A1+B1",
      "PRE_WORKFLOW_START",
      "log.println(\"pre\");",
    ].join("\n"),
    "utf-8"
  );
  return { root, builderRoot, outDir };
}

test("exportRagicDefinitions：成功匯出後才替換既有 forms 與 manifest", async () => {
  const fixture = await buildFixture();
  try {
    await mkdir(join(fixture.outDir, "forms", "old"), { recursive: true });
    await writeFile(join(fixture.outDir, "forms", "old", "stale.txt"), "stale", "utf-8");
    await writeFile(join(fixture.outDir, "manifest.json"), "{\"stale\":true}\n", "utf-8");

    const result = exportRagicDefinitions({
      builderRoot: fixture.builderRoot,
      outDir: fixture.outDir,
      namespaces: "default",
    });

    assert.equal(result.forms, 1);
    const formulas = await readFile(
      join(fixture.outDir, "forms", "default", "devtest", "51", "formulas.json"),
      "utf-8"
    );
    assert.match(formulas, /A1\+B1/);
    await assert.rejects(
      readFile(join(fixture.outDir, "forms", "old", "stale.txt"), "utf-8"),
      /ENOENT/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exportRagicDefinitions：匯出中途失敗時保留舊 baseline", async () => {
  const fixture = await buildFixture();
  try {
    await mkdir(join(fixture.outDir, "forms", "old"), { recursive: true });
    await writeFile(join(fixture.outDir, "forms", "old", "stale.txt"), "stale", "utf-8");
    await writeFile(join(fixture.outDir, "manifest.json"), "{\"stale\":true}\n", "utf-8");

    assert.throws(
      () =>
        exportRagicDefinitions({
          builderRoot: fixture.builderRoot,
          outDir: fixture.outDir,
          namespaces: "default",
          ragicNuiEncoding: "shift-jis",
        }),
      /RAGIC_NUI_ENCODING 僅支援/
    );

    assert.equal(
      await readFile(join(fixture.outDir, "forms", "old", "stale.txt"), "utf-8"),
      "stale"
    );
    assert.equal(await readFile(join(fixture.outDir, "manifest.json"), "utf-8"), "{\"stale\":true}\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
