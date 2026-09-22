#!/usr/bin/env node
/* eslint-disable */

const fs = require("node:fs");
const path = require("node:path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

require("dotenv").config();

const SOURCE_DB = path.resolve(
  process.env.EFFICIENCY_REPORT_DB_FILE || "./.data/efficiency-reports/metadata.v1.sqlite3"
);
const SOURCE_FILES = path.resolve(
  process.env.EFFICIENCY_REPORT_ARCHIVE_DIR || "./.data/efficiency-reports/files"
);
const BACKUP_DIR = path.resolve(
  process.env.EFFICIENCY_REPORT_BACKUP_DIR || "./.data/backups/efficiency-reports"
);
const rawKeepCount = Number(process.env.EFFICIENCY_REPORT_BACKUP_KEEP || 7);
if (!Number.isInteger(rawKeepCount) || rawKeepCount < 1) {
  throw new Error("EFFICIENCY_REPORT_BACKUP_KEEP must be a positive integer");
}
const KEEP_COUNT = rawKeepCount;

function pathsOverlap(left, right) {
  return (
    left === right ||
    left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`)
  );
}

function formatStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}

function resolveContained(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`archive path escapes root: ${relativePath}`);
  }
  return resolved;
}

async function main() {
  if (pathsOverlap(SOURCE_FILES, BACKUP_DIR)) {
    throw new Error("EFFICIENCY_REPORT_BACKUP_DIR must not overlap the archive files directory");
  }
  if (!fs.existsSync(SOURCE_DB)) {
    throw new Error(`metadata database not found: ${SOURCE_DB}`);
  }
  if (!fs.existsSync(SOURCE_FILES)) {
    throw new Error(`archive files directory not found: ${SOURCE_FILES}`);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `efficiency-reports-${formatStamp(new Date())}`;
  const stagingDir = path.join(BACKUP_DIR, `.${name}-${process.pid}.tmp`);
  const targetDir = path.join(BACKUP_DIR, name);
  const backupDbFile = path.join(stagingDir, "metadata.v1.sqlite3");
  const backupFilesRoot = path.join(stagingDir, "files");
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const sourceDb = await open({ filename: SOURCE_DB, driver: sqlite3.Database });
    try {
      await sourceDb.exec(`VACUUM INTO '${escapeSqlString(backupDbFile)}'`);
    } finally {
      await sourceDb.close();
    }

    const backupDb = await open({
      filename: backupDbFile,
      driver: sqlite3.Database,
      mode: sqlite3.OPEN_READONLY,
    });
    let relativePaths;
    try {
      const snapshots = await backupDb.all(
        "SELECT csv_relative_path AS relative_path FROM efficiency_report_snapshots"
      );
      const artifacts = await backupDb.all(
        "SELECT xlsx_relative_path AS relative_path FROM efficiency_report_artifacts"
      );
      relativePaths = [...new Set([...snapshots, ...artifacts].map((row) => row.relative_path))];
    } finally {
      await backupDb.close();
    }

    let totalBytes = 0;
    for (const relativePath of relativePaths) {
      const sourceFile = resolveContained(SOURCE_FILES, relativePath);
      const targetFile = resolveContained(backupFilesRoot, relativePath);
      const sourceStat = fs.statSync(sourceFile);
      if (!sourceStat.isFile()) {
        throw new Error(`archive entry is not a file: ${sourceFile}`);
      }
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
      totalBytes += sourceStat.size;
    }

    fs.writeFileSync(
      path.join(stagingDir, "manifest.json"),
      `${JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          metadataFile: "metadata.v1.sqlite3",
          fileCount: relativePaths.length,
          totalBytes,
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    fs.renameSync(stagingDir, targetDir);

    const backups = fs
      .readdirSync(BACKUP_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("efficiency-reports-"))
      .map((entry) => ({
        name: entry.name,
        fullPath: path.join(BACKUP_DIR, entry.name),
        mtime: fs.statSync(path.join(BACKUP_DIR, entry.name)).mtimeMs,
      }))
      .sort((left, right) => right.mtime - left.mtime);
    for (const backup of backups.slice(KEEP_COUNT)) {
      fs.rmSync(backup.fullPath, { recursive: true, force: true });
      console.log("[efficiency-report-backup] prune", { backup: backup.name });
    }

    console.log("[efficiency-report-backup] ok", {
      backupDir: targetDir,
      fileCount: relativePaths.length,
      totalBytes,
    });
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error("[efficiency-report-backup] failed", error);
  process.exit(1);
});
