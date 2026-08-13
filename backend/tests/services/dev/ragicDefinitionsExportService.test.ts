import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
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
    assert.match(result.revision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.artifactCount, 4);
    assert.ok(result.compressedBytes > 0);
    const manifest = JSON.parse(
      await readFile(join(fixture.outDir, "manifest.json"), "utf-8")
    ) as {
      schemaVersion: number;
      revision: string;
      artifactCount: number;
    };
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.revision, result.revision);
    assert.equal(manifest.artifactCount, 4);
    const revisionHex = result.revision.slice("sha256:".length);
    const snapshot = JSON.parse(
      gunzipSync(
        await readFile(
          join(fixture.outDir, ".snapshots", `${revisionHex}.json.gz`)
        )
      ).toString("utf-8")
    ) as {
      revision: string;
      forms: Array<{ form: { formPath: string } }>;
    };
    assert.equal(snapshot.revision, result.revision);
    assert.deepEqual(
      snapshot.forms.map((item) => item.form.formPath),
      ["default/devtest/51"]
    );
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

test("exportRagicDefinitions：相同來源維持相同 revision，內容變更才建立新 revision", async () => {
  const fixture = await buildFixture();
  try {
    const first = exportRagicDefinitions({
      builderRoot: fixture.builderRoot,
      outDir: fixture.outDir,
      namespaces: "default",
    });
    const second = exportRagicDefinitions({
      builderRoot: fixture.builderRoot,
      outDir: fixture.outDir,
      namespaces: "default",
    });
    assert.equal(second.revision, first.revision);

    await writeFile(
      join(fixture.builderRoot, "default", "devtest", "51_Sheet1_index.nui"),
      [
        "N,luo test",
        "D,1,2,1036615,編號,f=A1+B1+1",
        "PRE_WORKFLOW_START",
        "log.println(\"pre\");",
      ].join("\n"),
      "utf-8"
    );
    const changed = exportRagicDefinitions({
      builderRoot: fixture.builderRoot,
      outDir: fixture.outDir,
      namespaces: "default",
    });
    assert.notEqual(changed.revision, first.revision);
    const history = await readFile(
      join(
        fixture.outDir,
        ".snapshots",
        `${first.revision.slice("sha256:".length)}.json.gz`
      )
    );
    assert.ok(history.length > 0);
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
