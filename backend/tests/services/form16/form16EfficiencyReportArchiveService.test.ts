import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Form16EfficiencyReportArchiveService } from "../../../src/services/form16/form16EfficiencyReportArchiveService";
import { EfficiencyReportArchiveRepository } from "../../../src/storage/efficiency-report/efficiencyReportArchiveRepository";
import { HttpError } from "../../../src/utils/httpError";

function csv(value: string): Buffer {
  const header = Array.from({ length: 65 }, (_, index) => `H${index}`);
  const row = Array.from({ length: 65 }, () => "");
  row[0] = "entry-1";
  row[5] = "2026/06/15";
  row[10] = value;
  return Buffer.from([header, row].map((cells) => cells.join(",")).join("\n"), "utf8");
}

function csvWithBomAndCrLf(value: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(csv(value).toString("utf8").replace(/\n/g, "\r\n"), "utf8"),
  ]);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createHarness(options: {
  fetchSource: () => Promise<Buffer>;
  buildWorkbook?: (csvText: string, attendanceDays?: number) => Promise<Buffer>;
  validateWorkbook?: (body: Buffer) => Promise<boolean>;
  repositoryFactory?: (root: string) => EfficiencyReportArchiveRepository;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "efficiency-archive-"));
  const repository = options.repositoryFactory
    ? options.repositoryFactory(root)
    : new EfficiencyReportArchiveRepository(path.join(root, "metadata.sqlite3"));
  let sequence = 0;
  const service = new Form16EfficiencyReportArchiveService({
    repository,
    archiveDir: path.join(root, "files"),
    fetchSource: options.fetchSource,
    loadTemplate: async () => ({ body: Buffer.from("template"), version: "template-v1" }),
    buildWorkbook: async (csvText, _templateBody, attendanceDays) =>
      options.buildWorkbook
        ? options.buildWorkbook(csvText, attendanceDays)
        : Buffer.from(`xlsx:${attendanceDays ?? "default"}:${csvText}`),
    now: () => new Date("2026-07-13T12:00:00+08:00"),
    idFactory: () => `id-${(sequence += 1).toString().padStart(4, "0")}`,
    maxSourceBytes: 1024 * 1024,
    maxSourceRows: 100,
    validateWorkbook:
      options.validateWorkbook ??
      (async (body) => body.toString("utf8").startsWith("xlsx")),
  });
  return {
    root,
    repository,
    service,
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("相同月份相同內容重用來源版本，但每次操作仍重新檢查來源", async () => {
  let fetchCount = 0;
  let sourceBody = csv("10");
  const harness = await createHarness({
    fetchSource: async () => {
      fetchCount += 1;
      return sourceBody;
    },
  });
  try {
    const first = await harness.service.getOrCreateCurrentCsv("client-a");
    await writeFile(first.filePath, Buffer.from("broken"));
    sourceBody = csvWithBomAndCrLf("10");
    const second = await harness.service.getOrCreateCurrentCsv("client-a");

    assert.equal(fetchCount, 2);
    assert.equal(first.snapshot.id, second.snapshot.id);
    assert.equal(first.snapshot.version, 1);
    assert.equal(second.snapshot.sourceSizeBytes, sourceBody.byteLength);
    assert.equal(
      (await harness.repository.getSnapshot(first.snapshot.id))?.sourceSizeBytes,
      sourceBody.byteLength
    );
    assert.equal((await harness.service.listSnapshots(20, 0)).totalCount, 1);
    assert.deepEqual(await readFile(first.filePath), sourceBody);
    assert.equal((await harness.service.getStoredCsv(first.snapshot.id)).filePath, first.filePath);
  } finally {
    await harness.close();
  }
});

test("相同 canonical hash 的 BOM 與換行差異不覆寫完整歷史來源", async () => {
  let sourceBody = csv("10");
  const harness = await createHarness({ fetchSource: async () => sourceBody });
  try {
    const first = await harness.service.getOrCreateCurrentCsv();
    const originalBody = await readFile(first.filePath);
    sourceBody = csvWithBomAndCrLf("10");

    const reused = await harness.service.getOrCreateCurrentCsv();

    assert.equal(reused.snapshot.id, first.snapshot.id);
    assert.equal(reused.snapshot.sourceSizeBytes, originalBody.byteLength);
    assert.deepEqual(await readFile(reused.filePath), originalBody);
    assert.equal((await harness.service.getStoredCsv(first.snapshot.id)).filePath, first.filePath);
  } finally {
    await harness.close();
  }
});

test("current-version 分析檔重建後會更新 metadata 大小，不要求 ZIP bytes 固定", async () => {
  let body = Buffer.from("xlsx-small");
  const harness = await createHarness({
    fetchSource: async () => csv("10"),
    buildWorkbook: async () => body,
  });
  try {
    const first = await harness.service.getOrCreateCurrentAnalysis(21);
    await rm(first.filePath);
    body = Buffer.from("xlsx-rebuilt-with-different-size");

    const rebuilt = await harness.service.getOrCreateCurrentAnalysis(21);
    assert.equal(rebuilt.artifact.xlsxSizeBytes, body.byteLength);
    assert.equal(
      (await harness.repository.getArtifact(first.artifact.id))?.xlsxSizeBytes,
      body.byteLength
    );
    assert.deepEqual(await readFile(rebuilt.filePath), body);
  } finally {
    await harness.close();
  }
});

test("相同月份來源內容改變會建立下一個版本", async () => {
  let value = "10";
  const harness = await createHarness({ fetchSource: async () => csv(value) });
  try {
    const first = await harness.service.getOrCreateCurrentCsv();
    value = "11";
    const second = await harness.service.getOrCreateCurrentCsv();

    assert.notEqual(first.snapshot.id, second.snapshot.id);
    assert.equal(first.snapshot.version, 1);
    assert.equal(second.snapshot.version, 2);
    assert.equal((await harness.service.listSnapshots(20, 0)).totalCount, 2);
  } finally {
    await harness.close();
  }
});

test("同月份並發操作共用一次 Ragic 來源抓取", async () => {
  let fetchCount = 0;
  let releaseFetch: () => void = () => {
    throw new Error("releaseFetch not assigned");
  };
  const harness = await createHarness({
    fetchSource: async () => {
      fetchCount += 1;
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return csv("10");
    },
  });
  try {
    const first = harness.service.getOrCreateCurrentCsv();
    const second = harness.service.getOrCreateCurrentCsv();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fetchCount, 1);

    releaseFetch();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.snapshot.id, secondResult.snapshot.id);
  } finally {
    await harness.close();
  }
});

test("相同來源、出勤天數與範本版本重用分析檔", async () => {
  let buildCount = 0;
  const harness = await createHarness({
    fetchSource: async () => csv("10"),
    buildWorkbook: async (_csvText, attendanceDays) => {
      buildCount += 1;
      return Buffer.from(`xlsx:${attendanceDays}`);
    },
  });
  try {
    const first = await harness.service.getOrCreateCurrentAnalysis(21);
    const second = await harness.service.getOrCreateCurrentAnalysis(21);

    assert.equal(buildCount, 1);
    assert.equal(first.artifact.id, second.artifact.id);
    assert.equal(first.artifact.attendanceDays, 21);
    assert.deepEqual(await readFile(first.filePath), Buffer.from("xlsx:21"));
  } finally {
    await harness.close();
  }
});

test("current-version 分析檔缺失或同大小毀損時在 fingerprint singleflight 內原子重建", async () => {
  let buildCount = 0;
  const expectedBody = Buffer.from("xlsx-complete-body");
  const harness = await createHarness({
    fetchSource: async () => csv("10"),
    buildWorkbook: async () => {
      buildCount += 1;
      return expectedBody;
    },
  });
  try {
    const first = await harness.service.getOrCreateCurrentAnalysis(21);
    await rm(first.filePath);

    const [missingFirst, missingSecond] = await Promise.all([
      harness.service.getOrCreateCurrentAnalysis(21),
      harness.service.getOrCreateCurrentAnalysis(21),
    ]);
    assert.equal(buildCount, 2);
    assert.equal(missingFirst.artifact.id, first.artifact.id);
    assert.equal(missingSecond.artifact.id, first.artifact.id);
    assert.deepEqual(await readFile(first.filePath), expectedBody);

    await writeFile(first.filePath, Buffer.alloc(expectedBody.byteLength, 0x78));
    const [mismatchFirst, mismatchSecond] = await Promise.all([
      harness.service.getOrCreateCurrentAnalysis(21),
      harness.service.getOrCreateCurrentAnalysis(21),
    ]);
    assert.equal(buildCount, 3);
    assert.equal(mismatchFirst.artifact.id, first.artifact.id);
    assert.equal(mismatchSecond.artifact.id, first.artifact.id);
    assert.deepEqual(await readFile(first.filePath), expectedBody);
  } finally {
    await harness.close();
  }
});

test("缺失的歷史分析檔若 template version 不同則 fail closed", async () => {
  const harness = await createHarness({ fetchSource: async () => csv("10") });
  let replacementService: Form16EfficiencyReportArchiveService | null = null;
  try {
    const original = await harness.service.getOrCreateCurrentAnalysis(21);
    await rm(original.filePath);
    await harness.service.close();

    let buildCount = 0;
    replacementService = new Form16EfficiencyReportArchiveService({
      repository: new EfficiencyReportArchiveRepository(path.join(harness.root, "metadata.sqlite3")),
      archiveDir: path.join(harness.root, "files"),
      fetchSource: async () => {
        throw new Error("歷史下載不應抓取來源");
      },
      loadTemplate: async () => ({ body: Buffer.from("template-v2"), version: "template-v2" }),
      buildWorkbook: async () => {
        buildCount += 1;
        return Buffer.from("unexpected-rebuild");
      },
    });

    await assert.rejects(
      replacementService.getStoredXlsx(original.snapshot.id, original.artifact.id),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 410 &&
        error.code === "EFFICIENCY_REPORT_ARTIFACT_VERSION_MISMATCH"
    );
    assert.equal(buildCount, 0);
  } finally {
    await replacementService?.close();
    await harness.service.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("歷史分析檔重建期間 metadata 被清理時不留下 orphan xlsx", async () => {
  let buildCount = 0;
  let releaseRebuild: () => void = () => {};
  let notifyRebuildStarted: () => void = () => {
    throw new Error("notifyRebuildStarted not assigned");
  };
  const rebuildStarted = new Promise<void>((resolve) => {
    notifyRebuildStarted = resolve;
  });
  const harness = await createHarness({
    fetchSource: async () => csv("10"),
    buildWorkbook: async () => {
      buildCount += 1;
      if (buildCount === 1) return Buffer.from("xlsx-original");
      notifyRebuildStarted();
      await new Promise<void>((resolve) => {
        releaseRebuild = resolve;
      });
      return Buffer.from("xlsx-rebuilt");
    },
  });
  try {
    const original = await harness.service.getOrCreateCurrentAnalysis(21);
    await rm(original.filePath);

    const rebuilding = harness.service.getStoredXlsx(
      original.snapshot.id,
      original.artifact.id
    );
    await rebuildStarted;
    const cleanup = await harness.service.cleanupExpiredSnapshots({
      now: new Date("2026-07-13T12:00:00+08:00"),
      retentionMonths: 0,
      dryRun: false,
    });
    assert.equal(cleanup.deletedSnapshots, 1);

    releaseRebuild();
    await assert.rejects(
      rebuilding,
      (error: unknown) =>
        error instanceof HttpError &&
        error.code === "EFFICIENCY_REPORT_ARTIFACT_METADATA_STALE"
    );
    assert.equal(await exists(original.filePath), false);
    assert.equal(await harness.repository.getSnapshot(original.snapshot.id), null);
  } finally {
    releaseRebuild();
    await harness.close();
  }
});

test("來源 metadata 寫入失敗時刪除尚未登記的來源目錄", async () => {
  class FailingSnapshotRepository extends EfficiencyReportArchiveRepository {
    override async createSnapshot(): Promise<void> {
      throw new Error("forced snapshot metadata failure");
    }
  }
  const harness = await createHarness({
    fetchSource: async () => csv("10"),
    repositoryFactory: (root) =>
      new FailingSnapshotRepository(path.join(root, "metadata.sqlite3")),
  });
  try {
    await assert.rejects(
      harness.service.getOrCreateCurrentCsv(),
      /forced snapshot metadata failure/
    );
    assert.deepEqual(await readdir(path.join(harness.root, "files", "2026-06")), []);
  } finally {
    await harness.close();
  }
});

test("分析檔 metadata 寫入失敗時刪除尚未登記的 xlsx", async () => {
  class FailingArtifactRepository extends EfficiencyReportArchiveRepository {
    override async createArtifact(): Promise<void> {
      throw new Error("forced artifact metadata failure");
    }
  }
  const harness = await createHarness({
    fetchSource: async () => csv("10"),
    repositoryFactory: (root) =>
      new FailingArtifactRepository(path.join(root, "metadata.sqlite3")),
  });
  try {
    await assert.rejects(
      harness.service.getOrCreateCurrentAnalysis(21),
      /forced artifact metadata failure/
    );
    const snapshot = await harness.service.getOrCreateCurrentCsv();
    assert.deepEqual(await readdir(path.dirname(snapshot.filePath)), ["source.csv"]);
  } finally {
    await harness.close();
  }
});
