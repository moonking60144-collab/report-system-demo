#!/usr/bin/env node
/* eslint-disable */
// SQLite 備份：用 VACUUM INTO 產生 consistent snapshot，不阻塞讀寫
// 用法：node scripts/backup-sqlite.js
// 或 cron：每天凌晨 3 點跑一次
//
// 預設：
//   來源 = process.env.SQLITE_DB_FILE 或 ./.cache/work-report-read-model.v1.sqlite3
//   目的 = ./.cache/backups/work-report-<YYYYMMDD-HHmmss>.sqlite3
//   保留最新 N 份（預設 7），舊的刪除

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

require("dotenv").config();

const SOURCE_DB = path.resolve(
  process.env.SQLITE_DB_FILE || "./.cache/work-report-read-model.v1.sqlite3"
);
const BACKUP_DIR = path.resolve(process.env.SQLITE_BACKUP_DIR || "./.cache/backups");
const KEEP_COUNT = Number(process.env.SQLITE_BACKUP_KEEP || 7);

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
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

async function main() {
  if (!fs.existsSync(SOURCE_DB)) {
    console.error(`[sqlite-backup] source not found: ${SOURCE_DB}`);
    process.exit(1);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = formatStamp(new Date());
  const backupFile = path.join(BACKUP_DIR, `work-report-${stamp}.sqlite3`);

  const db = await open({ filename: SOURCE_DB, driver: sqlite3.Database });
  try {
    // VACUUM INTO 會建一份 consistent snapshot 到指定檔案，不需停機
    await db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
    const stat = fs.statSync(backupFile);
    console.log(`[sqlite-backup] ok`, {
      backupFile,
      sizeBytes: stat.size,
    });
  } finally {
    await db.close();
  }

  // 保留最新 KEEP_COUNT 份，其他刪除
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith("work-report-") && name.endsWith(".sqlite3"))
    .map((name) => ({
      name,
      full: path.join(BACKUP_DIR, name),
      mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const toPrune = files.slice(KEEP_COUNT);
  for (const file of toPrune) {
    fs.unlinkSync(file.full);
    console.log(`[sqlite-backup] prune`, { file: file.name });
  }
}

main().catch((err) => {
  console.error("[sqlite-backup] failed", err);
  process.exit(1);
});
