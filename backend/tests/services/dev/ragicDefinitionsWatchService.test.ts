import test from "node:test";
import assert from "node:assert/strict";
import {
  createRagicDefinitionsWatchService,
  suppressRagicDefinitionsWatchPaths,
  type WatchHandle,
} from "../../../src/services/dev/ragicDefinitionsWatchService";
import type { RagicDefinitionsSyncPayload } from "../../../src/events/realtimeEventBus";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildFixture(options: {
  reExport?: () => Promise<unknown>;
} = {}) {
  let listener:
    | ((eventType: string, filename: string | Buffer | null) => void)
    | null = null;
  let closed = false;
  let reExportCalls = 0;
  const published: RagicDefinitionsSyncPayload[] = [];
  const service = createRagicDefinitionsWatchService({
    builderRoot: "/tmp/ragic-builder",
    debounceMs: 100,
    settleMs: 0,
    rootExists: () => true,
    watchRoot: (_builderRoot, nextListener): WatchHandle => {
      listener = nextListener;
      return {
        close() {
          closed = true;
        },
      };
    },
    reExportService: {
      reExport: async () => {
        reExportCalls += 1;
        await options.reExport?.();
        return {
          exported: true,
          message: "已同步 Ragic 現況，definitions 有差異",
          summary: {
            forms: 1,
            fields: 2,
            formulas: 3,
            workflows: 4,
            namespaces: "default",
            outDir: "/tmp/ragic-definitions",
          },
          state: {
            definitionsRoot: "/tmp/ragic-definitions",
            exists: true,
            manifest: null,
            gitStatus: { available: true, clean: false, entries: [], error: null },
          },
          versionStatus: {
            gitAvailable: true,
            repoRoot: "/tmp/repo",
            definitionsRoot: "/tmp/ragic-definitions",
            definitionsPathspec: "ragic-definitions",
            branch: "main",
            lastCommit: "abc1234",
            remoteTrackingBranch: "origin/main",
            ahead: 0,
            behind: 0,
            clean: false,
            definitionsClean: false,
            canCommit: true,
            canPush: false,
            canAutoSyncPush: false,
            entries: [],
            definitionsEntries: [],
            outsideEntries: [],
            blockers: [],
            warnings: [],
            error: null,
          },
        };
      },
    },
    publish: (payload) => {
      published.push(payload);
    },
  });

  return {
    service,
    emit(filename: string | Buffer | null) {
      assert.ok(listener, "watch listener should be registered");
      listener("change", filename);
    },
    isClosed: () => closed,
    getReExportCalls: () => reExportCalls,
    published,
  };
}

test("definitions watcher：只在有效 .nui 變更後自動重新匯入並發 SSE 狀態", async () => {
  const fixture = buildFixture();

  assert.equal(fixture.service.start(), true);
  assert.equal(fixture.published.at(-1)?.status, "watching");

  fixture.emit("default/devtest/history/51_Sheet51_index.nui");
  fixture.emit("default/devtest/readme.txt");
  await wait(140);
  assert.equal(fixture.getReExportCalls(), 0);

  fixture.emit("default/devtest/51_Sheet51_index.nui");
  await wait(160);

  assert.equal(fixture.getReExportCalls(), 1);
  assert.deepEqual(
    fixture.published.map((item) => item.status),
    ["watching", "syncing", "synced"]
  );
  assert.equal(fixture.published.at(-1)?.summary?.formulas, 3);

  fixture.service.stop();
  assert.equal(fixture.isClosed(), true);
});

test("definitions watcher：重新匯入失敗時發 error 狀態", async () => {
  const fixture = buildFixture({
    reExport: async () => {
      throw new Error("export failed");
    },
  });

  assert.equal(fixture.service.start(), true);
  fixture.emit(Buffer.from("default/devtest/51_Sheet51_index.nui"));
  await wait(160);

  assert.equal(fixture.getReExportCalls(), 1);
  assert.equal(fixture.published.at(-1)?.status, "error");
  assert.match(fixture.published.at(-1)?.message ?? "", /export failed/);
  fixture.service.stop();
});

test("definitions watcher：沒有 builder root 時回 disabled 狀態", () => {
  const published: RagicDefinitionsSyncPayload[] = [];
  const service = createRagicDefinitionsWatchService({
    builderRoot: "",
    publish: (payload) => {
      published.push(payload);
    },
  });

  assert.equal(service.start(), false);
  assert.equal(published.at(-1)?.status, "disabled");
  assert.match(published.at(-1)?.message ?? "", /RAGIC_BUILDER_PATH 未設定/);
});

test("definitions watcher：被公式套用抑制的 .nui 變更不觸發自動 re-export", async () => {
  const fixture = buildFixture();

  assert.equal(fixture.service.start(), true);
  suppressRagicDefinitionsWatchPaths(
    ["/tmp/ragic-builder/default/devtest/51_Sheet51_index.nui"],
    { builderRoot: "/tmp/ragic-builder", durationMs: 1_000 }
  );
  fixture.emit("default/devtest/51_Sheet51_index.nui");
  await wait(160);

  assert.equal(fixture.getReExportCalls(), 0);
  assert.deepEqual(
    fixture.published.map((item) => item.status),
    ["watching"]
  );
  fixture.service.stop();
});
