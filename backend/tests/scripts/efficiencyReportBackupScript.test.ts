import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EfficiencyReportArchiveRepository } from "../../src/storage/efficiency-report/efficiencyReportArchiveRepository";

test("效率報表備份包含一致 metadata 與 SQLite 引用的封存檔", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "efficiency-backup-"));
  const dbFile = path.join(root, "metadata.sqlite3");
  const filesRoot = path.join(root, "files");
  const backupRoot = path.join(root, "backups");
  const relativePath = path.join("2026-06", "v1-snapshot", "source.csv");
  const sourceFile = path.join(filesRoot, relativePath);
  const repository = new EfficiencyReportArchiveRepository(dbFile);

  try {
    await repository.initialize();
    await mkdir(path.dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, "archived-csv", "utf8");
    await repository.createSnapshot({
      id: "snapshot-1",
      periodMonth: "2026-06",
      version: 1,
      status: "ready",
      sourceHash: "hash-1",
      sourceRowCount: 1,
      sourceSizeBytes: 12,
      csvRelativePath: relativePath,
      generatedBy: null,
      createdAt: "2026-07-13T00:00:00.000Z",
      finalizedAt: null,
    });
    await repository.close();

    const result = spawnSync(process.execPath, ["scripts/backup-efficiency-reports.js"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        EFFICIENCY_REPORT_DB_FILE: dbFile,
        EFFICIENCY_REPORT_ARCHIVE_DIR: filesRoot,
        EFFICIENCY_REPORT_BACKUP_DIR: backupRoot,
        EFFICIENCY_REPORT_BACKUP_KEEP: "2",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const backups = (await readdir(backupRoot)).filter((name) =>
      name.startsWith("efficiency-reports-")
    );
    assert.equal(backups.length, 1);
    const backupDir = path.join(backupRoot, backups[0]);
    assert.equal(await readFile(path.join(backupDir, "files", relativePath), "utf8"), "archived-csv");
    const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8")) as {
      fileCount: number;
    };
    assert.equal(manifest.fileCount, 1);
  } finally {
    await repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("效率報表備份拒絕與封存來源重疊的備份目錄", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "efficiency-backup-overlap-"));
  const dbFile = path.join(root, "metadata.sqlite3");
  const filesRoot = path.join(root, "files");
  const repository = new EfficiencyReportArchiveRepository(dbFile);

  try {
    await repository.initialize();
    await repository.close();
    await mkdir(filesRoot, { recursive: true });
    const result = spawnSync(process.execPath, ["scripts/backup-efficiency-reports.js"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        EFFICIENCY_REPORT_DB_FILE: dbFile,
        EFFICIENCY_REPORT_ARCHIVE_DIR: filesRoot,
        EFFICIENCY_REPORT_BACKUP_DIR: path.join(filesRoot, "backups"),
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not overlap the archive files directory/);
  } finally {
    await repository.close();
    await rm(root, { recursive: true, force: true });
  }
});
