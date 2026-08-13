import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import {
  buildRagicDefinitionsSnapshotPayload,
  createRagicDefinitionsSnapshotService,
  readCurrentRagicDefinitionsSnapshotDescriptor,
} from "../../../src/services/dev/ragicDefinitionsSnapshotService";

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "ragic-snapshot-test-"));
  const formDir = join(root, "forms", "default", "devtest", "51");
  await mkdir(join(formDir, "workflows"), { recursive: true });
  await writeJson(join(root, "manifest.json"), {
    schemaVersion: 1,
    namespaceFilter: { mode: "include", namespaces: ["default"] },
    counts: { forms: 1, fields: 1, formulas: 1, workflows: 1 },
  });
  await writeJson(join(formDir, "form.json"), {
    schemaVersion: 1,
    formPath: "default/devtest/51",
    formName: "TestForm",
    nuiFile: "51_Sheet51_index.nui",
    sourceEncoding: "utf-8",
    sourceRelativePath: "default/devtest/51_Sheet51_index.nui",
    counts: { fields: 1, formulas: 1, workflows: 1 },
  });
  await writeJson(join(formDir, "fields.json"), [
    {
      fieldId: "1036615",
      fieldName: "編號",
      kind: "D",
      position: "A2",
      sourceLine: 13,
      attrs: { noDup: "true" },
    },
  ]);
  await writeJson(join(formDir, "formulas.json"), [
    {
      fieldId: "1036615",
      fieldName: "編號",
      position: "A2",
      formulaKind: "formula",
      nuiFormula: "A1+1",
      displayFormula: "A1+1",
      sourceLine: 13,
    },
  ]);
  await writeFile(
    join(formDir, "workflows", "post.js"),
    "log.println(\"masked workflow\");\n",
    "utf-8"
  );
  return { root, formDir };
}

test("snapshot service：legacy manifest 可產生 deterministic revision 與 gzip artifact", async () => {
  const fixture = await buildFixture();
  try {
    const payload = buildRagicDefinitionsSnapshotPayload(fixture.root);
    assert.equal(payload.manifest.schemaVersion, 2);
    assert.equal(payload.manifest.revision, payload.revision);
    assert.equal(payload.artifactCount, 4);
    assert.match(payload.revision, /^sha256:[a-f0-9]{64}$/);

    const service = createRagicDefinitionsSnapshotService({
      definitionsRoot: fixture.root,
      retainCount: 3,
    });
    const artifact = service.materializeCurrent();
    const compressed = await readFile(artifact.filePath);
    assert.equal(artifact.descriptor.compressedBytes, compressed.length);
    assert.equal(
      artifact.descriptor.artifactSha256,
      createHash("sha256").update(compressed).digest("hex")
    );
    const decoded = JSON.parse(gunzipSync(compressed).toString("utf-8")) as {
      revision: string;
      forms: Array<{ form: { formName: string } }>;
    };
    assert.equal(decoded.revision, payload.revision);
    assert.equal(decoded.forms[0]?.form.formName, "TestForm");
    assert.equal(
      artifact.descriptor.payloadSha256,
      createHash("sha256").update(gunzipSync(compressed)).digest("hex")
    );

    const descriptor = readCurrentRagicDefinitionsSnapshotDescriptor(fixture.root);
    assert.equal(descriptor?.revision, payload.revision);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot service：runtime cold materialize 使用非同步 I/O 並產出同一 revision", async () => {
  const fixture = await buildFixture();
  try {
    const service = createRagicDefinitionsSnapshotService({
      definitionsRoot: fixture.root,
    });
    const expected = buildRagicDefinitionsSnapshotPayload(fixture.root);
    let eventLoopYielded = false;
    setImmediate(() => {
      eventLoopYielded = true;
    });

    const loaded = await service.materializeCurrentAsync();

    assert.equal(eventLoopYielded, true);
    assert.equal(loaded.descriptor.revision, expected.revision);
    assert.equal(
      (await service.loadVerified(expected.revision))?.descriptor.revision,
      expected.revision
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot service：cache 被竄改時不回傳 artifact，重新 materialize 可修復", async () => {
  const fixture = await buildFixture();
  try {
    const service = createRagicDefinitionsSnapshotService({
      definitionsRoot: fixture.root,
    });
    const first = service.materializeCurrent();
    assert.equal(
      (await service.loadVerified(first.descriptor.revision))?.descriptor.revision,
      first.descriptor.revision
    );
    const corrupted = Buffer.from(await readFile(first.filePath));
    corrupted[Math.max(0, corrupted.length - 1)] ^= 0xff;
    await writeFile(first.filePath, corrupted);
    assert.equal(service.open(first.descriptor.revision), null);
    assert.equal(
      service.list().some((item) => item.revision === first.descriptor.revision),
      false
    );

    const repaired = service.materializeCurrent();
    assert.equal(repaired.descriptor.revision, first.descriptor.revision);
    assert.doesNotThrow(() => gunzipSync(readFileSync(repaired.filePath)));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot service：sidecar payload hash 被竄改時視為無效並可重建", async () => {
  const fixture = await buildFixture();
  try {
    const service = createRagicDefinitionsSnapshotService({
      definitionsRoot: fixture.root,
    });
    const first = service.materializeCurrent();
    assert.equal(
      (await service.loadVerified(first.descriptor.revision))?.descriptor.revision,
      first.descriptor.revision
    );
    const revisionHex = first.descriptor.revision.slice("sha256:".length);
    const metadataPath = join(
      service.snapshotRoot,
      `${revisionHex}.meta.json`
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8")) as {
      payloadSha256: string;
    };
    await writeJson(metadataPath, {
      ...metadata,
      payloadSha256: "f".repeat(64),
    });

    assert.equal(service.open(first.descriptor.revision), null);
    assert.equal(await service.loadVerified(first.descriptor.revision), null);
    const repaired = service.materializeCurrent();
    assert.notEqual(repaired.descriptor.payloadSha256, "f".repeat(64));
    assert.equal(
      service.open(first.descriptor.revision)?.descriptor.payloadSha256,
      repaired.descriptor.payloadSha256
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot service：prepare 階段不可被 history/open 看見，publish 後才可讀", async () => {
  const fixture = await buildFixture();
  try {
    const service = createRagicDefinitionsSnapshotService({
      definitionsRoot: fixture.root,
    });
    const payload = buildRagicDefinitionsSnapshotPayload(fixture.root);
    const prepared = service.preparePayload(payload);

    assert.equal(service.open(payload.revision), null);
    assert.equal(service.list().length, 0);

    prepared.publish();
    assert.equal(service.open(payload.revision)?.descriptor.revision, payload.revision);
    assert.equal(service.list()[0]?.revision, payload.revision);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot service：namespace contract 改變時 revision 必須改變", async () => {
  const fixture = await buildFixture();
  try {
    const first = buildRagicDefinitionsSnapshotPayload(fixture.root);
    await writeJson(join(fixture.root, "manifest.json"), {
      schemaVersion: 1,
      namespaceFilter: { mode: "all" },
      counts: first.manifest.counts,
    });
    const second = buildRagicDefinitionsSnapshotPayload(fixture.root);

    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(second.manifest.namespaceFilter, { mode: "all" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot service：retention 只保留最近 revision 並保護目前 revision", async () => {
  const fixture = await buildFixture();
  try {
    const service = createRagicDefinitionsSnapshotService({
      definitionsRoot: fixture.root,
      retainCount: 2,
    });
    const revisions: string[] = [];
    for (const formula of ["A1+1", "A1+2", "A1+3"]) {
      await writeJson(join(fixture.formDir, "formulas.json"), [
        {
          fieldId: "1036615",
          fieldName: "編號",
          position: "A2",
          formulaKind: "formula",
          nuiFormula: formula,
          displayFormula: formula,
          sourceLine: 13,
        },
      ]);
      revisions.push(service.materializeCurrent().descriptor.revision);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const history = service.list();
    assert.equal(history.length, 2);
    assert.equal(
      history.some((item) => item.revision === revisions.at(-1)),
      true
    );
    assert.equal(service.open(revisions[0]!), null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot service：retention 會清除超過 grace period 的 orphan artifact", async () => {
  const fixture = await buildFixture();
  try {
    const service = createRagicDefinitionsSnapshotService({
      definitionsRoot: fixture.root,
    });
    const current = service.materializeCurrent();
    const orphanHex = "f".repeat(64);
    const orphanPath = join(service.snapshotRoot, `${orphanHex}.json.gz`);
    await writeFile(orphanPath, "orphan", "utf-8");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(orphanPath, old, old);

    service.prune(current.descriptor.revision);

    assert.equal(existsSync(orphanPath), false);
    assert.notEqual(service.open(current.descriptor.revision), null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("snapshot service：manifest revision 與 artifact 不一致時 fail closed", async () => {
  const fixture = await buildFixture();
  try {
    const payload = buildRagicDefinitionsSnapshotPayload(fixture.root);
    await writeJson(join(fixture.root, "manifest.json"), {
      ...payload.manifest,
      revision:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    });
    assert.throws(
      () => buildRagicDefinitionsSnapshotPayload(fixture.root),
      /manifest revision 不一致/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
