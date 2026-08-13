import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Form16EfficiencyReportArchiveService } from "../../../src/services/form16/form16EfficiencyReportArchiveService";
import {
  EfficiencyReportArchiveRepository,
  type EfficiencyReportSnapshotRecord,
} from "../../../src/storage/efficiency-report/efficiencyReportArchiveRepository";

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

test("效率報表清理 dry-run 不變更資料，實際執行只刪除 24 個月邊界以前月份", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "efficiency-cleanup-"));
  const filesRoot = path.join(root, "files");
  const repository = new EfficiencyReportArchiveRepository(path.join(root, "metadata.sqlite3"));
  let fetchCount = 0;
  const service = new Form16EfficiencyReportArchiveService({
    repository,
    archiveDir: filesRoot,
    fetchSource: async () => {
      fetchCount += 1;
      throw new Error("cleanup must not fetch Ragic");
    },
    now: () => new Date("2026-07-13T12:00:00+08:00"),
  });

  const createSnapshot = async (periodMonth: string, version: number) => {
    const relativePath = path.join(periodMonth, `v${version}-snapshot`, "source.csv");
    const filePath = path.join(filesRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, periodMonth, "utf8");
    const snapshot: EfficiencyReportSnapshotRecord = {
      id: `${periodMonth}-v${version}`,
      periodMonth,
      version,
      status: "ready",
      sourceHash: `${periodMonth}-hash-${version}`,
      sourceRowCount: 1,
      sourceSizeBytes: Buffer.byteLength(periodMonth),
      csvRelativePath: relativePath,
      generatedBy: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      finalizedAt: null,
      artifacts: [],
    };
    await repository.createSnapshot(snapshot);
    return filePath;
  };

  try {
    await service.initialize();
    const expiredFile = await createSnapshot("2024-06", 1);
    const boundaryFile = await createSnapshot("2024-07", 1);
    const recentFile = await createSnapshot("2026-06", 1);
    const trashOrphan = path.join(filesRoot, ".trash", "orphan", "source.csv");
    await mkdir(path.dirname(trashOrphan), { recursive: true });
    await writeFile(trashOrphan, "must survive dry-run", "utf8");

    const preview = await service.cleanupExpiredSnapshots({
      now: new Date("2026-07-13T12:00:00+08:00"),
      retentionMonths: 24,
      dryRun: true,
    });
    assert.equal(preview.cutoffMonth, "2024-07");
    assert.equal(preview.expiredSnapshots, 1);
    assert.equal(preview.deletedSnapshots, 0);
    assert.equal(await exists(expiredFile), true);
    assert.equal(await exists(trashOrphan), true);

    const result = await service.cleanupExpiredSnapshots({
      now: new Date("2026-07-13T12:00:00+08:00"),
      retentionMonths: 24,
      dryRun: false,
    });
    assert.equal(result.deletedSnapshots, 1);
    assert.equal(result.failedSnapshots, 0);
    assert.equal(await exists(expiredFile), false);
    assert.equal(await exists(boundaryFile), true);
    assert.equal(await exists(recentFile), true);
    assert.equal((await service.listSnapshots(20, 0)).totalCount, 2);
    assert.equal(fetchCount, 0);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("效率報表清理刪除 metadata 失敗時還原封存檔並保留歷史紀錄", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "efficiency-cleanup-rollback-"));
  const filesRoot = path.join(root, "files");
  class FailingDeleteRepository extends EfficiencyReportArchiveRepository {
    override async deleteSnapshot(_snapshotId: string): Promise<void> {
      throw new Error("forced metadata delete failure");
    }
  }
  const repository = new FailingDeleteRepository(path.join(root, "metadata.sqlite3"));
  const service = new Form16EfficiencyReportArchiveService({ repository, archiveDir: filesRoot });
  const relativePath = path.join("2024-06", "v1-snapshot", "source.csv");
  const filePath = path.join(filesRoot, relativePath);

  try {
    await service.initialize();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "2024-06", "utf8");
    await repository.createSnapshot({
      id: "2024-06-v1",
      periodMonth: "2024-06",
      version: 1,
      status: "ready",
      sourceHash: "2024-06-hash-1",
      sourceRowCount: 1,
      sourceSizeBytes: 7,
      csvRelativePath: relativePath,
      generatedBy: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      finalizedAt: null,
    });

    const result = await service.cleanupExpiredSnapshots({
      now: new Date("2026-07-13T12:00:00+08:00"),
      retentionMonths: 24,
      dryRun: false,
    });

    assert.equal(result.deletedSnapshots, 0);
    assert.equal(result.failedSnapshots, 1);
    assert.equal(await exists(filePath), true);
    assert.equal((await service.listSnapshots(20, 0)).totalCount, 1);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
