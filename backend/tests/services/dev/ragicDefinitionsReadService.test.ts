import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createRagicDefinitionsReadService } from "../../../src/services/dev/ragicDefinitionsReadService";
import {
  buildRagicDefinitionsSnapshotPayload,
  createRagicDefinitionsSnapshotService,
} from "../../../src/services/dev/ragicDefinitionsSnapshotService";

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

test("read service 以 Field ID 解析 linked 欄位與來源表單欄位", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "ragic-read-linked-field-test-"));
  try {
    const definitionsRoot = join(repoRoot, "ragic-definitions");
    const targetDir = join(definitionsRoot, "forms", "default", "devtest", "7");
    const sourceDir = join(definitionsRoot, "forms", "default", "devtest", "10");
    await mkdir(targetDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(definitionsRoot, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        counts: { forms: 2, fields: 3, formulas: 0, workflows: 0 },
      }),
      "utf-8"
    );
    await writeFile(
      join(targetDir, "form.json"),
      JSON.stringify({
        schemaVersion: 1,
        formPath: "default/devtest/7",
        formName: "TestForm1",
        nuiFile: "7.nui",
        sourceEncoding: "utf-8",
        sourceRelativePath: "default/devtest/7.nui",
        counts: { fields: 2, formulas: 0, workflows: 0 },
      }),
      "utf-8"
    );
    await writeFile(
      join(targetDir, "fields.json"),
      JSON.stringify([
        {
          fieldId: "1040341",
          fieldName: "唯一測試欄位",
          kind: "L",
          position: "H6",
          sourceLine: 40,
          attrs: { mvp: "/devtest|10_Sheet10", stf: "1040340" },
        },
        {
          fieldId: "1040347",
          fieldName: "Name",
          kind: "D",
          position: "L6",
          sourceLine: 42,
          attrs: { l: "1040341", ro: "true", vd: "1016317" },
        },
      ]),
      "utf-8"
    );
    await writeFile(join(targetDir, "formulas.json"), "[]", "utf-8");
    await writeFile(
      join(sourceDir, "form.json"),
      JSON.stringify({
        schemaVersion: 1,
        formPath: "default/devtest/10",
        formName: "TestForm3",
        nuiFile: "10.nui",
        sourceEncoding: "utf-8",
        sourceRelativePath: "default/devtest/10.nui",
        counts: { fields: 1, formulas: 0, workflows: 0 },
      }),
      "utf-8"
    );
    await writeFile(
      join(sourceDir, "fields.json"),
      JSON.stringify([
        {
          fieldId: "1016317",
          fieldName: "Name",
          kind: "D",
          position: "A2",
          sourceLine: 14,
          attrs: {},
        },
      ]),
      "utf-8"
    );
    await writeFile(join(sourceDir, "formulas.json"), "[]", "utf-8");

    const service = createRagicDefinitionsReadService({
      repoRoot,
      definitionsRoot,
      cacheTtlMs: 0,
    });
    const result = await service.search({
      formPath: "default/devtest/7",
      fieldId: "1040347",
      type: "field",
    });

    assert.equal(result.data.length, 1);
    assert.deepEqual(result.data[0]?.fieldReferences, [
      {
        attribute: "l",
        fieldId: "1040341",
        formPath: "default/devtest/7",
        fieldName: "唯一測試欄位",
        kind: "L",
        position: "H6",
      },
      {
        attribute: "vd",
        fieldId: "1016317",
        formPath: "default/devtest/10",
        fieldName: "Name",
        kind: "D",
        position: "A2",
      },
    ]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("read service：state 與 current/history snapshot 使用相同 revision", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "ragic-read-snapshot-test-"));
  try {
    const definitionsRoot = join(repoRoot, "ragic-definitions");
    const formDir = join(
      definitionsRoot,
      "forms",
      "default",
      "devtest",
      "51"
    );
    await mkdir(formDir, { recursive: true });
    await writeFile(
      join(definitionsRoot, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        namespaceFilter: { mode: "include", namespaces: ["default"] },
        counts: { forms: 1, fields: 1, formulas: 0, workflows: 0 },
      }),
      "utf-8"
    );
    await writeFile(
      join(formDir, "form.json"),
      JSON.stringify({
        schemaVersion: 1,
        formPath: "default/devtest/51",
        formName: "TestForm",
        nuiFile: "51_Sheet51_index.nui",
        sourceEncoding: "utf-8",
        sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
        counts: { fields: 1, formulas: 0, workflows: 0 },
      }),
      "utf-8"
    );
    await writeFile(
      join(formDir, "fields.json"),
      JSON.stringify([
        {
          fieldId: "1036615",
          fieldName: "編號",
          kind: "D",
          position: "A2",
          sourceLine: 13,
          attrs: {},
        },
      ]),
      "utf-8"
    );
    await writeFile(join(formDir, "formulas.json"), "[]", "utf-8");

    await execFileAsync("git", ["init"], { cwd: repoRoot });
    const service = createRagicDefinitionsReadService({
      repoRoot,
      definitionsRoot,
      cacheTtlMs: 0,
      snapshotRetainCount: 3,
    });
    const staleService = createRagicDefinitionsReadService({
      repoRoot,
      definitionsRoot,
      cacheTtlMs: 0,
      snapshotRetainCount: 1,
    });
    const state = await service.getState();
    assert.equal(
      (await staleService.getState()).snapshot?.revision,
      state.snapshot?.revision
    );
    assert.match(state.snapshot?.revision ?? "", /^sha256:[a-f0-9]{64}$/);

    const current = await service.openCurrentSnapshot();
    assert.equal(current.descriptor.revision, state.snapshot?.revision);
    assert.equal(current.descriptor.publishedAt, state.snapshot?.publishedAt);
    const history = await service.listSnapshots();
    assert.equal(history.length, 1);
    assert.equal(history[0]?.revision, current.descriptor.revision);
    assert.equal(
      (await service.openSnapshot(current.descriptor.revision))?.filePath,
      current.filePath
    );

    await writeFile(
      join(formDir, "formulas.json"),
      JSON.stringify([
        {
          fieldId: "1036615",
          fieldName: "編號",
          position: "A2",
          formulaKind: "formula",
          nuiFormula: "A1+1",
          displayFormula: "A1+1",
          sourceLine: 13,
        },
      ]),
      "utf-8"
    );
    await writeFile(
      join(formDir, "form.json"),
      JSON.stringify({
        schemaVersion: 1,
        formPath: "default/devtest/51",
        formName: "TestForm",
        nuiFile: "51_Sheet51_index.nui",
        sourceEncoding: "utf-8",
        sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
        counts: { fields: 1, formulas: 1, workflows: 0 },
      }),
      "utf-8"
    );
    await writeFile(
      join(definitionsRoot, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        namespaceFilter: { mode: "include", namespaces: ["default"] },
        counts: { forms: 1, fields: 1, formulas: 1, workflows: 0 },
      }),
      "utf-8"
    );
    const nextPayload = buildRagicDefinitionsSnapshotPayload(definitionsRoot);
    const nextManifestPath = join(definitionsRoot, "manifest.next.json");
    await writeFile(nextManifestPath, JSON.stringify(nextPayload.manifest), "utf-8");
    await rename(nextManifestPath, join(definitionsRoot, "manifest.json"));

    assert.notEqual(nextPayload.revision, state.snapshot?.revision);
    assert.equal(
      (await service.getState()).snapshot?.revision,
      nextPayload.revision
    );

    createRagicDefinitionsSnapshotService({
      definitionsRoot,
      retainCount: 1,
    }).materializeCurrent();
    const loadedAfterPrune = await staleService.loadCurrentSnapshot();
    assert.equal(loadedAfterPrune.descriptor.revision, nextPayload.revision);
    assert.equal(
      (await staleService.getState()).snapshot?.revision,
      nextPayload.revision
    );

    const concurrentReader = createRagicDefinitionsReadService({
      repoRoot,
      definitionsRoot,
      cacheTtlMs: 0,
    });
    const [concurrentA, concurrentB] = await Promise.all([
      concurrentReader.loadCurrentSnapshot(),
      concurrentReader.loadCurrentSnapshot(),
    ]);
    assert.strictEqual(concurrentA, concurrentB);

    const hiddenManifestPath = join(definitionsRoot, "manifest.hidden.json");
    await rename(join(definitionsRoot, "manifest.json"), hiddenManifestPath);
    const initiallyMissingService = createRagicDefinitionsReadService({
      repoRoot,
      definitionsRoot,
      cacheTtlMs: 0,
    });
    assert.equal((await initiallyMissingService.getState()).snapshot, null);
    await rename(hiddenManifestPath, join(definitionsRoot, "manifest.json"));
    assert.equal(
      (await initiallyMissingService.getState()).snapshot?.revision,
      nextPayload.revision
    );

    await rename(join(definitionsRoot, "manifest.json"), hiddenManifestPath);
    const restoreForDescriptor = new Promise<void>((resolveRestore, rejectRestore) => {
      setTimeout(() => {
        void rename(hiddenManifestPath, join(definitionsRoot, "manifest.json")).then(
          () => resolveRestore(),
          rejectRestore
        );
      }, 30);
    });
    assert.equal(
      (await initiallyMissingService.getSnapshotDescriptor())?.revision,
      nextPayload.revision
    );
    await restoreForDescriptor;

    await rename(join(definitionsRoot, "manifest.json"), hiddenManifestPath);
    const restoreForSnapshot = new Promise<void>((resolveRestore, rejectRestore) => {
      setTimeout(() => {
        void rename(hiddenManifestPath, join(definitionsRoot, "manifest.json")).then(
          () => resolveRestore(),
          rejectRestore
        );
      }, 30);
    });
    assert.equal(
      (await initiallyMissingService.loadCurrentSnapshot()).descriptor.revision,
      nextPayload.revision
    );
    await restoreForSnapshot;
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
