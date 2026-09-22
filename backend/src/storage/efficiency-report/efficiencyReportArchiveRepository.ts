import fs from "node:fs/promises";
import path from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { env } from "../../config/env";

export type EfficiencyReportSnapshotStatus = "ready" | "finalized";

export interface EfficiencyReportArtifactRecord {
  id: string;
  snapshotId: string;
  attendanceDays: number | null;
  templateVersion: string;
  calculationVersion: string;
  reportFingerprint: string;
  xlsxRelativePath: string;
  xlsxSizeBytes: number;
  createdAt: string;
}

export interface EfficiencyReportSnapshotRecord {
  id: string;
  periodMonth: string;
  version: number;
  status: EfficiencyReportSnapshotStatus;
  sourceHash: string;
  sourceRowCount: number;
  sourceSizeBytes: number;
  csvRelativePath: string;
  generatedBy: string | null;
  createdAt: string;
  finalizedAt: string | null;
  artifacts: EfficiencyReportArtifactRecord[];
}

interface SnapshotRow {
  id: string;
  period_month: string;
  version: number;
  status: EfficiencyReportSnapshotStatus;
  source_hash: string;
  source_row_count: number;
  source_size_bytes: number;
  csv_relative_path: string;
  generated_by: string | null;
  created_at: string;
  finalized_at: string | null;
}

interface ArtifactRow {
  id: string;
  snapshot_id: string;
  attendance_days: number | null;
  template_version: string;
  calculation_version: string;
  report_fingerprint: string;
  xlsx_relative_path: string;
  xlsx_size_bytes: number;
  created_at: string;
}

function mapArtifact(row: ArtifactRow): EfficiencyReportArtifactRecord {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    attendanceDays: row.attendance_days,
    templateVersion: row.template_version,
    calculationVersion: row.calculation_version,
    reportFingerprint: row.report_fingerprint,
    xlsxRelativePath: row.xlsx_relative_path,
    xlsxSizeBytes: row.xlsx_size_bytes,
    createdAt: row.created_at,
  };
}

function mapSnapshot(
  row: SnapshotRow,
  artifacts: EfficiencyReportArtifactRecord[] = []
): EfficiencyReportSnapshotRecord {
  return {
    id: row.id,
    periodMonth: row.period_month,
    version: row.version,
    status: row.status,
    sourceHash: row.source_hash,
    sourceRowCount: row.source_row_count,
    sourceSizeBytes: row.source_size_bytes,
    csvRelativePath: row.csv_relative_path,
    generatedBy: row.generated_by,
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
    artifacts,
  };
}

export class EfficiencyReportArchiveRepository {
  private dbPromise: Promise<Database> | null = null;

  constructor(private readonly dbFile = env.EFFICIENCY_REPORT_DB_FILE) {}

  async initialize(): Promise<void> {
    await this.getDb();
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    this.dbPromise = null;
    await db.close();
  }

  async findSnapshotBySourceHash(
    periodMonth: string,
    sourceHash: string
  ): Promise<EfficiencyReportSnapshotRecord | null> {
    const db = await this.getDb();
    const row = await db.get<SnapshotRow>(
      "SELECT * FROM efficiency_report_snapshots WHERE period_month = ? AND source_hash = ?",
      periodMonth,
      sourceHash
    );
    return row ? this.attachArtifacts(mapSnapshot(row)) : null;
  }

  async getSnapshot(snapshotId: string): Promise<EfficiencyReportSnapshotRecord | null> {
    const db = await this.getDb();
    const row = await db.get<SnapshotRow>(
      "SELECT * FROM efficiency_report_snapshots WHERE id = ?",
      snapshotId
    );
    return row ? this.attachArtifacts(mapSnapshot(row)) : null;
  }

  async getNextVersion(periodMonth: string): Promise<number> {
    const db = await this.getDb();
    const row = await db.get<{ next_version: number }>(
      "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM efficiency_report_snapshots WHERE period_month = ?",
      periodMonth
    );
    return row?.next_version ?? 1;
  }

  async createSnapshot(input: Omit<EfficiencyReportSnapshotRecord, "artifacts">): Promise<void> {
    const db = await this.getDb();
    await db.run(
      `INSERT INTO efficiency_report_snapshots (
        id, period_month, version, status, source_hash, source_row_count,
        source_size_bytes, csv_relative_path, generated_by, created_at, finalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.periodMonth,
      input.version,
      input.status,
      input.sourceHash,
      input.sourceRowCount,
      input.sourceSizeBytes,
      input.csvRelativePath,
      input.generatedBy,
      input.createdAt,
      input.finalizedAt
    );
  }

  async updateSnapshotSourceSize(snapshotId: string, sourceSizeBytes: number): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.run(
      "UPDATE efficiency_report_snapshots SET source_size_bytes = ? WHERE id = ?",
      sourceSizeBytes,
      snapshotId
    );
    return (result.changes ?? 0) === 1;
  }

  async findArtifactByFingerprint(
    reportFingerprint: string
  ): Promise<EfficiencyReportArtifactRecord | null> {
    const db = await this.getDb();
    const row = await db.get<ArtifactRow>(
      "SELECT * FROM efficiency_report_artifacts WHERE report_fingerprint = ?",
      reportFingerprint
    );
    return row ? mapArtifact(row) : null;
  }

  async getArtifact(artifactId: string): Promise<EfficiencyReportArtifactRecord | null> {
    const db = await this.getDb();
    const row = await db.get<ArtifactRow>(
      "SELECT * FROM efficiency_report_artifacts WHERE id = ?",
      artifactId
    );
    return row ? mapArtifact(row) : null;
  }

  async createArtifact(input: EfficiencyReportArtifactRecord): Promise<void> {
    const db = await this.getDb();
    await db.run(
      `INSERT INTO efficiency_report_artifacts (
        id, snapshot_id, attendance_days, template_version, calculation_version,
        report_fingerprint, xlsx_relative_path, xlsx_size_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.snapshotId,
      input.attendanceDays,
      input.templateVersion,
      input.calculationVersion,
      input.reportFingerprint,
      input.xlsxRelativePath,
      input.xlsxSizeBytes,
      input.createdAt
    );
  }

  async updateArtifactSize(artifactId: string, xlsxSizeBytes: number): Promise<boolean> {
    const db = await this.getDb();
    const result = await db.run(
      "UPDATE efficiency_report_artifacts SET xlsx_size_bytes = ? WHERE id = ?",
      xlsxSizeBytes,
      artifactId
    );
    return (result.changes ?? 0) === 1;
  }

  async listSnapshots(limit: number, offset: number): Promise<{
    records: EfficiencyReportSnapshotRecord[];
    totalCount: number;
  }> {
    const db = await this.getDb();
    const countRow = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM efficiency_report_snapshots"
    );
    const rows = await db.all<SnapshotRow[]>(
      `SELECT * FROM efficiency_report_snapshots
       ORDER BY period_month DESC, version DESC
       LIMIT ? OFFSET ?`,
      limit,
      offset
    );
    const records = await Promise.all(rows.map((row) => this.attachArtifacts(mapSnapshot(row))));
    return { records, totalCount: countRow?.count ?? 0 };
  }

  async listSnapshotsBefore(periodMonth: string): Promise<EfficiencyReportSnapshotRecord[]> {
    const db = await this.getDb();
    const rows = await db.all<SnapshotRow[]>(
      `SELECT * FROM efficiency_report_snapshots
       WHERE period_month < ?
       ORDER BY period_month ASC, version ASC`,
      periodMonth
    );
    return Promise.all(rows.map((row) => this.attachArtifacts(mapSnapshot(row))));
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const db = await this.getDb();
    await db.run("DELETE FROM efficiency_report_snapshots WHERE id = ?", snapshotId);
  }

  private async attachArtifacts(
    snapshot: EfficiencyReportSnapshotRecord
  ): Promise<EfficiencyReportSnapshotRecord> {
    const db = await this.getDb();
    const rows = await db.all<ArtifactRow[]>(
      `SELECT * FROM efficiency_report_artifacts
       WHERE snapshot_id = ?
       ORDER BY created_at DESC`,
      snapshot.id
    );
    return { ...snapshot, artifacts: rows.map(mapArtifact) };
  }

  private async getDb(): Promise<Database> {
    if (!this.dbPromise) {
      this.dbPromise = this.openDatabase().catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  private async openDatabase(): Promise<Database> {
    const filename = this.dbFile === ":memory:" ? ":memory:" : path.resolve(this.dbFile);
    if (filename !== ":memory:") {
      await fs.mkdir(path.dirname(filename), { recursive: true });
    }
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(
      [
        "PRAGMA journal_mode=WAL;",
        "PRAGMA synchronous=NORMAL;",
        "PRAGMA foreign_keys=ON;",
        "PRAGMA busy_timeout=5000;",
        `CREATE TABLE IF NOT EXISTS efficiency_report_snapshots (
          id TEXT PRIMARY KEY,
          period_month TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('ready', 'finalized')),
          source_hash TEXT NOT NULL,
          source_row_count INTEGER NOT NULL,
          source_size_bytes INTEGER NOT NULL,
          csv_relative_path TEXT NOT NULL,
          generated_by TEXT,
          created_at TEXT NOT NULL,
          finalized_at TEXT,
          UNIQUE(period_month, version),
          UNIQUE(period_month, source_hash)
        );`,
        `CREATE TABLE IF NOT EXISTS efficiency_report_artifacts (
          id TEXT PRIMARY KEY,
          snapshot_id TEXT NOT NULL,
          attendance_days REAL,
          template_version TEXT NOT NULL,
          calculation_version TEXT NOT NULL,
          report_fingerprint TEXT NOT NULL UNIQUE,
          xlsx_relative_path TEXT NOT NULL,
          xlsx_size_bytes INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (snapshot_id) REFERENCES efficiency_report_snapshots(id) ON DELETE CASCADE
        );`,
        "CREATE INDEX IF NOT EXISTS idx_efficiency_snapshots_period ON efficiency_report_snapshots(period_month DESC, version DESC);",
        "CREATE INDEX IF NOT EXISTS idx_efficiency_artifacts_snapshot ON efficiency_report_artifacts(snapshot_id, created_at DESC);",
      ].join("\n")
    );
    return db;
  }
}

export const efficiencyReportArchiveRepository = new EfficiencyReportArchiveRepository();
