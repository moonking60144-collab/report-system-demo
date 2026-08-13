import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import JSZip from "jszip";
import { env } from "../../config/env";
import {
  efficiencyReportArchiveRepository,
  type EfficiencyReportArtifactRecord,
  type EfficiencyReportSnapshotRecord,
  EfficiencyReportArchiveRepository,
} from "../../storage/efficiency-report/efficiencyReportArchiveRepository";
import { HttpError } from "../../utils/httpError";
import {
  FORM16_PIVOT_CALCULATION_VERSION,
  form16PivotAnalysisExportService,
  type Form16PivotTemplateBundle,
} from "./form16PivotAnalysisExportService";
import {
  inspectForm16PublishedCsv,
  efficiencyReportRetentionCutoffMonth,
  previousCompleteTaipeiMonth,
} from "./form16PublishedCsv";

export interface EfficiencyReportArchiveListResult {
  records: EfficiencyReportSnapshotRecord[];
  totalCount: number;
}

export interface EfficiencyReportCsvResult {
  snapshot: EfficiencyReportSnapshotRecord;
  filePath: string;
  filename: string;
}

export interface EfficiencyReportXlsxResult {
  snapshot: EfficiencyReportSnapshotRecord;
  artifact: EfficiencyReportArtifactRecord;
  filePath: string;
  filename: string;
}

export interface EfficiencyReportCleanupResult {
  cutoffMonth: string;
  dryRun: boolean;
  expiredSnapshots: number;
  deletedSnapshots: number;
  failedSnapshots: number;
  fileCount: number;
  totalBytes: number;
  failures: Array<{ snapshotId: string; periodMonth: string; error: string }>;
}

interface Form16EfficiencyReportArchiveServiceDeps {
  repository?: EfficiencyReportArchiveRepository;
  archiveDir?: string;
  fetchSource?: () => Promise<Buffer>;
  loadTemplate?: () => Promise<Form16PivotTemplateBundle>;
  buildWorkbook?: (
    csvText: string,
    templateBody: Buffer,
    attendanceDays?: number
  ) => Promise<Buffer>;
  now?: () => Date;
  idFactory?: () => string;
  maxSourceBytes?: number;
  maxSourceRows?: number;
  validateWorkbook?: (body: Buffer) => Promise<boolean>;
}

type BuildWorkbook = (
  csvText: string,
  templateBody: Buffer,
  attendanceDays?: number
) => Promise<Buffer>;

export class Form16EfficiencyReportArchiveService {
  private readonly repository: EfficiencyReportArchiveRepository;
  private readonly archiveDir: string;
  private readonly fetchSource: () => Promise<Buffer>;
  private readonly loadTemplate: () => Promise<Form16PivotTemplateBundle>;
  private readonly buildWorkbook: BuildWorkbook;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly maxSourceBytes: number;
  private readonly maxSourceRows: number;
  private readonly validateWorkbook: (body: Buffer) => Promise<boolean>;
  private readonly sourcePromiseByPeriod = new Map<string, Promise<EfficiencyReportCsvResult>>();
  private readonly artifactPromiseByFingerprint = new Map<
    string,
    Promise<EfficiencyReportXlsxResult>
  >();
  private initializedPromise: Promise<void> | null = null;

  constructor(deps: Form16EfficiencyReportArchiveServiceDeps = {}) {
    this.repository = deps.repository ?? efficiencyReportArchiveRepository;
    this.archiveDir = path.resolve(deps.archiveDir ?? env.EFFICIENCY_REPORT_ARCHIVE_DIR);
    this.fetchSource = deps.fetchSource ?? (() => this.fetchPublishedSource());
    this.loadTemplate =
      deps.loadTemplate ?? (() => form16PivotAnalysisExportService.loadTemplateBundle());
    this.buildWorkbook =
      deps.buildWorkbook ??
      ((csvText, templateBody, attendanceDays) =>
        form16PivotAnalysisExportService.buildWorkbook(csvText, templateBody, attendanceDays));
    this.now = deps.now ?? (() => new Date());
    this.idFactory = deps.idFactory ?? randomUUID;
    this.maxSourceBytes = deps.maxSourceBytes ?? env.EFFICIENCY_REPORT_MAX_SOURCE_BYTES;
    this.maxSourceRows = deps.maxSourceRows ?? env.EFFICIENCY_REPORT_MAX_SOURCE_ROWS;
    this.validateWorkbook = deps.validateWorkbook ?? ((body) => this.validateXlsxBody(body));
  }

  initialize(): Promise<void> {
    if (!this.initializedPromise) {
      this.initializedPromise = Promise.all([
        this.repository.initialize(),
        mkdir(this.archiveDir, { recursive: true }),
      ])
        .then(() => undefined)
        .catch((error) => {
          this.initializedPromise = null;
          throw error;
        });
    }
    return this.initializedPromise;
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      ...this.sourcePromiseByPeriod.values(),
      ...this.artifactPromiseByFingerprint.values(),
    ]);
    this.initializedPromise = null;
    await this.repository.close();
  }

  currentPeriodMonth(): string {
    return previousCompleteTaipeiMonth(this.now());
  }

  async getOrCreateCurrentCsv(generatedBy?: string | null): Promise<EfficiencyReportCsvResult> {
    return this.getOrCreateCsv(this.currentPeriodMonth(), generatedBy);
  }

  async getOrCreateCsv(
    periodMonth: string,
    generatedBy?: string | null
  ): Promise<EfficiencyReportCsvResult> {
    this.assertPeriodMonth(periodMonth);
    await this.initialize();
    const existingPromise = this.sourcePromiseByPeriod.get(periodMonth);
    if (existingPromise) return existingPromise;

    const promise = this.createOrReuseSource(periodMonth, generatedBy ?? null).finally(() => {
      if (this.sourcePromiseByPeriod.get(periodMonth) === promise) {
        this.sourcePromiseByPeriod.delete(periodMonth);
      }
    });
    this.sourcePromiseByPeriod.set(periodMonth, promise);
    return promise;
  }

  async getOrCreateCurrentAnalysis(
    attendanceDays?: number,
    generatedBy?: string | null
  ): Promise<EfficiencyReportXlsxResult> {
    return this.getOrCreateAnalysis(this.currentPeriodMonth(), attendanceDays, generatedBy);
  }

  async getOrCreateAnalysis(
    periodMonth: string,
    attendanceDays?: number,
    generatedBy?: string | null
  ): Promise<EfficiencyReportXlsxResult> {
    const csv = await this.getOrCreateCsv(periodMonth, generatedBy);
    const template = await this.loadTemplate();
    const reportFingerprint = this.reportFingerprint(csv.snapshot, template, attendanceDays);

    return this.runArtifactSingleflight(reportFingerprint, async () => {
      const stored = await this.repository.findArtifactByFingerprint(reportFingerprint);
      if (stored) {
        this.assertArtifactRebuildCompatible(csv.snapshot, stored, template);
        const filePath = await this.reusableArtifactFilePath(stored);
        if (filePath) {
          return {
            snapshot: csv.snapshot,
            artifact: stored,
            filePath,
            filename: this.xlsxFilename(csv.snapshot, attendanceDays),
          };
        }
        return this.rebuildArtifact(csv, stored, template);
      }
      return this.createArtifact(csv, template, attendanceDays, reportFingerprint);
    });
  }

  async listSnapshots(limit: number, offset: number): Promise<EfficiencyReportArchiveListResult> {
    await this.initialize();
    return this.repository.listSnapshots(limit, offset);
  }

  async cleanupExpiredSnapshots(options: {
    now?: Date;
    retentionMonths?: number;
    dryRun?: boolean;
  } = {}): Promise<EfficiencyReportCleanupResult> {
    await this.initialize();
    const dryRun = options.dryRun ?? env.EFFICIENCY_REPORT_CLEANUP_DRY_RUN;
    if (!dryRun) {
      await this.reconcileCleanupTrash();
    }
    const cutoffMonth = efficiencyReportRetentionCutoffMonth(
      options.now ?? this.now(),
      options.retentionMonths ?? env.EFFICIENCY_REPORT_RETENTION_MONTHS
    );
    const expired = await this.repository.listSnapshotsBefore(cutoffMonth);
    const result: EfficiencyReportCleanupResult = {
      cutoffMonth,
      dryRun,
      expiredSnapshots: expired.length,
      deletedSnapshots: 0,
      failedSnapshots: 0,
      fileCount: expired.reduce((count, snapshot) => count + 1 + snapshot.artifacts.length, 0),
      totalBytes: expired.reduce(
        (sum, snapshot) =>
          sum +
          snapshot.sourceSizeBytes +
          snapshot.artifacts.reduce((artifactSum, artifact) => artifactSum + artifact.xlsxSizeBytes, 0),
        0
      ),
      failures: [],
    };
    if (result.dryRun) return result;

    for (const snapshot of expired) {
      const snapshotDir = this.resolveArchivePath(path.dirname(snapshot.csvRelativePath));
      const trashDir = this.resolveArchivePath(path.join(".trash", snapshot.id));
      let movedToTrash = false;
      let metadataDeleted = false;
      try {
        await mkdir(path.dirname(trashDir), { recursive: true });
        try {
          await rename(snapshotDir, trashDir);
          movedToTrash = true;
        } catch (error) {
          if (!this.isMissingPathError(error)) throw error;
        }
        await this.repository.deleteSnapshot(snapshot.id);
        metadataDeleted = true;
        result.deletedSnapshots += 1;
        if (movedToTrash) {
          await rm(trashDir, { recursive: true, force: true });
        }
      } catch (error) {
        if (movedToTrash && !metadataDeleted) {
          try {
            await rename(trashDir, snapshotDir);
          } catch (rollbackError) {
            const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            result.failures.push({
              snapshotId: snapshot.id,
              periodMonth: snapshot.periodMonth,
              error: `封存清理失敗且檔案還原失敗：${detail}`,
            });
          }
        }
        result.failedSnapshots += 1;
        result.failures.push({
          snapshotId: snapshot.id,
          periodMonth: snapshot.periodMonth,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  private async reconcileCleanupTrash(): Promise<void> {
    const trashRoot = this.resolveArchivePath(".trash");
    await mkdir(trashRoot, { recursive: true });
    const entries = await readdir(trashRoot, { withFileTypes: true });
    for (const entry of entries) {
      const trashPath = this.resolveArchivePath(path.join(".trash", entry.name));
      if (!entry.isDirectory()) {
        await rm(trashPath, { recursive: true, force: true });
        continue;
      }
      const snapshot = await this.repository.getSnapshot(entry.name);
      if (!snapshot) {
        await rm(trashPath, { recursive: true, force: true });
        continue;
      }
      const snapshotDir = this.resolveArchivePath(path.dirname(snapshot.csvRelativePath));
      try {
        await stat(snapshotDir);
        await rm(trashPath, { recursive: true, force: true });
      } catch (error) {
        if (!this.isMissingPathError(error)) throw error;
        await mkdir(path.dirname(snapshotDir), { recursive: true });
        await rename(trashPath, snapshotDir);
      }
    }
  }

  private isMissingPathError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    );
  }

  async getStoredCsv(snapshotId: string): Promise<EfficiencyReportCsvResult> {
    await this.initialize();
    const snapshot = await this.repository.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new HttpError(404, "找不到效率報表歷史版本。", "EFFICIENCY_REPORT_NOT_FOUND");
    }
    return {
      snapshot,
      filePath: await this.assertStoredSourceFile(snapshot),
      filename: this.csvFilename(snapshot),
    };
  }

  async getStoredXlsx(snapshotId: string, artifactId: string): Promise<EfficiencyReportXlsxResult> {
    await this.initialize();
    const [snapshot, artifact] = await Promise.all([
      this.repository.getSnapshot(snapshotId),
      this.repository.getArtifact(artifactId),
    ]);
    if (!snapshot || !artifact || artifact.snapshotId !== snapshot.id) {
      throw new HttpError(404, "找不到效率報表分析檔。", "EFFICIENCY_REPORT_ARTIFACT_NOT_FOUND");
    }
    const filePath = await this.reusableArtifactFilePath(artifact);
    if (filePath) {
      return {
        snapshot,
        artifact,
        filePath,
        filename: this.xlsxFilename(snapshot, artifact.attendanceDays ?? undefined),
      };
    }

    return this.runArtifactSingleflight(artifact.reportFingerprint, async () => {
      const recheckedFilePath = await this.reusableArtifactFilePath(artifact);
      if (recheckedFilePath) {
        return {
          snapshot,
          artifact,
          filePath: recheckedFilePath,
          filename: this.xlsxFilename(snapshot, artifact.attendanceDays ?? undefined),
        };
      }
      const template = await this.loadTemplate();
      this.assertArtifactRebuildCompatible(snapshot, artifact, template);
      const csv: EfficiencyReportCsvResult = {
        snapshot,
        filePath: await this.assertStoredSourceFile(snapshot),
        filename: this.csvFilename(snapshot),
      };
      return this.rebuildArtifact(csv, artifact, template);
    });
  }

  private async createOrReuseSource(
    periodMonth: string,
    generatedBy: string | null
  ): Promise<EfficiencyReportCsvResult> {
    const sourceBody = await this.fetchSource();
    if (sourceBody.byteLength > this.maxSourceBytes) {
      throw new HttpError(
        413,
        `Ragic 發佈 CSV 大小 ${sourceBody.byteLength} bytes，超過上限 ${this.maxSourceBytes} bytes。`,
        "EFFICIENCY_REPORT_SOURCE_SIZE_LIMIT_EXCEEDED"
      );
    }
    const inspection = inspectForm16PublishedCsv(
      sourceBody.toString("utf8"),
      periodMonth,
      this.maxSourceRows
    );
    const existing = await this.repository.findSnapshotBySourceHash(
      periodMonth,
      inspection.sourceHash
    );
    if (existing) {
      const filePath = this.resolveArchivePath(existing.csvRelativePath);
      try {
        return {
          snapshot: existing,
          filePath: await this.assertStoredSourceFile(existing),
          filename: this.csvFilename(existing),
        };
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          error.code !== "EFFICIENCY_REPORT_SOURCE_CORRUPT"
        ) {
          throw error;
        }
      }

      await this.writeAtomic(filePath, sourceBody);
      if (!(await this.repository.updateSnapshotSourceSize(existing.id, sourceBody.byteLength))) {
        await rm(filePath, { force: true });
        throw new HttpError(
          409,
          "效率報表來源已修復，但 metadata 已不存在，請重新整理歷史紀錄。",
          "EFFICIENCY_REPORT_SOURCE_METADATA_STALE"
        );
      }
      const repairedSnapshot = { ...existing, sourceSizeBytes: sourceBody.byteLength };
      return {
        snapshot: repairedSnapshot,
        filePath,
        filename: this.csvFilename(repairedSnapshot),
      };
    }

    const version = await this.repository.getNextVersion(periodMonth);
    const snapshotId = this.idFactory();
    const relativeDir = path.join(periodMonth, `v${version}-${snapshotId.slice(0, 8)}`);
    const csvRelativePath = path.join(relativeDir, "source.csv");
    const filePath = this.resolveArchivePath(csvRelativePath);
    await this.writeAtomic(filePath, sourceBody);

    const snapshot: EfficiencyReportSnapshotRecord = {
      id: snapshotId,
      periodMonth,
      version,
      status: "ready",
      sourceHash: inspection.sourceHash,
      sourceRowCount: inspection.rowCount,
      sourceSizeBytes: sourceBody.byteLength,
      csvRelativePath,
      generatedBy,
      createdAt: this.now().toISOString(),
      finalizedAt: null,
      artifacts: [],
    };
    try {
      await this.repository.createSnapshot(snapshot);
    } catch (error) {
      const raced = await this.repository.findSnapshotBySourceHash(
        periodMonth,
        inspection.sourceHash
      );
      if (!raced) {
        try {
          await rm(path.dirname(filePath), { recursive: true, force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "效率報表來源 metadata 寫入失敗，且暫存來源目錄清理失敗。"
          );
        }
        throw error;
      }
      await rm(path.dirname(filePath), { recursive: true, force: true });
      return {
        snapshot: raced,
        filePath: await this.assertStoredFile(raced.csvRelativePath),
        filename: this.csvFilename(raced),
      };
    }
    return { snapshot, filePath, filename: this.csvFilename(snapshot) };
  }

  private async createArtifact(
    csv: EfficiencyReportCsvResult,
    template: Form16PivotTemplateBundle,
    attendanceDays: number | undefined,
    reportFingerprint: string
  ): Promise<EfficiencyReportXlsxResult> {
    const csvText = await readFile(csv.filePath, "utf8");
    const body = await this.buildWorkbook(csvText, template.body, attendanceDays);
    if (!(await this.validateWorkbook(body))) {
      throw new HttpError(
        500,
        "分析檔產物不是完整可讀的 XLSX，停止保存。",
        "EFFICIENCY_REPORT_ARTIFACT_INVALID"
      );
    }
    const artifactId = this.idFactory();
    const relativeDir = path.dirname(csv.snapshot.csvRelativePath);
    const xlsxRelativePath = path.join(
      relativeDir,
      `machine-analysis-${reportFingerprint.slice(0, 12)}.xlsx`
    );
    const filePath = this.resolveArchivePath(xlsxRelativePath);
    await this.writeAtomic(filePath, body);

    const artifact: EfficiencyReportArtifactRecord = {
      id: artifactId,
      snapshotId: csv.snapshot.id,
      attendanceDays: attendanceDays ?? null,
      templateVersion: template.version,
      calculationVersion: FORM16_PIVOT_CALCULATION_VERSION,
      reportFingerprint,
      xlsxRelativePath,
      xlsxSizeBytes: body.byteLength,
      createdAt: this.now().toISOString(),
    };
    try {
      await this.repository.createArtifact(artifact);
    } catch (error) {
      const raced = await this.repository.findArtifactByFingerprint(reportFingerprint);
      if (!raced) {
        try {
          await rm(filePath, { force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "效率報表分析檔 metadata 寫入失敗，且暫存分析檔清理失敗。"
          );
        }
        throw error;
      }
      this.assertArtifactRebuildCompatible(csv.snapshot, raced, template);
      const racedFilePath = await this.reusableArtifactFilePath(raced);
      return racedFilePath
        ? {
            snapshot: csv.snapshot,
            artifact: raced,
            filePath: racedFilePath,
            filename: this.xlsxFilename(csv.snapshot, attendanceDays),
          }
        : this.rebuildArtifact(csv, raced, template);
    }
    return {
      snapshot: { ...csv.snapshot, artifacts: [artifact, ...csv.snapshot.artifacts] },
      artifact,
      filePath,
      filename: this.xlsxFilename(csv.snapshot, attendanceDays),
    };
  }

  private reportFingerprint(
    snapshot: EfficiencyReportSnapshotRecord,
    template: Form16PivotTemplateBundle,
    attendanceDays?: number
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          sourceHash: snapshot.sourceHash,
          attendanceDays: attendanceDays ?? null,
          templateVersion: template.version,
          calculationVersion: FORM16_PIVOT_CALCULATION_VERSION,
        })
      )
      .digest("hex");
  }

  private runArtifactSingleflight(
    reportFingerprint: string,
    operation: () => Promise<EfficiencyReportXlsxResult>
  ): Promise<EfficiencyReportXlsxResult> {
    const existingPromise = this.artifactPromiseByFingerprint.get(reportFingerprint);
    if (existingPromise) return existingPromise;

    const promise = operation().finally(() => {
      if (this.artifactPromiseByFingerprint.get(reportFingerprint) === promise) {
        this.artifactPromiseByFingerprint.delete(reportFingerprint);
      }
    });
    this.artifactPromiseByFingerprint.set(reportFingerprint, promise);
    return promise;
  }

  private async reusableArtifactFilePath(
    artifact: EfficiencyReportArtifactRecord
  ): Promise<string | null> {
    const filePath = this.resolveArchivePath(artifact.xlsxRelativePath);
    try {
      const fileStat = await stat(filePath);
      if (
        !fileStat.isFile() ||
        fileStat.size <= 0 ||
        fileStat.size !== artifact.xlsxSizeBytes
      ) {
        return null;
      }
      return (await this.validateWorkbook(await readFile(filePath))) ? filePath : null;
    } catch (error) {
      if (this.isMissingPathError(error)) return null;
      throw error;
    }
  }

  private assertArtifactRebuildCompatible(
    snapshot: EfficiencyReportSnapshotRecord,
    artifact: EfficiencyReportArtifactRecord,
    template: Form16PivotTemplateBundle
  ): void {
    const attendanceDays = artifact.attendanceDays ?? undefined;
    if (
      artifact.snapshotId !== snapshot.id ||
      artifact.templateVersion !== template.version ||
      artifact.calculationVersion !== FORM16_PIVOT_CALCULATION_VERSION ||
      artifact.reportFingerprint !== this.reportFingerprint(snapshot, template, attendanceDays)
    ) {
      throw new HttpError(
        410,
        "歷史分析檔已不存在或大小不符，且建立時使用的範本或計算版本與目前版本不同，停止重建。",
        "EFFICIENCY_REPORT_ARTIFACT_VERSION_MISMATCH"
      );
    }
  }

  private async rebuildArtifact(
    csv: EfficiencyReportCsvResult,
    artifact: EfficiencyReportArtifactRecord,
    template: Form16PivotTemplateBundle
  ): Promise<EfficiencyReportXlsxResult> {
    const attendanceDays = artifact.attendanceDays ?? undefined;
    const csvText = await readFile(csv.filePath, "utf8");
    const body = await this.buildWorkbook(csvText, template.body, attendanceDays);
    if (!(await this.validateWorkbook(body))) {
      throw new HttpError(
        500,
        "分析檔重建結果不是完整可讀的 XLSX，停止覆寫。",
        "EFFICIENCY_REPORT_ARTIFACT_INVALID"
      );
    }
    const filePath = this.resolveArchivePath(artifact.xlsxRelativePath);
    await this.writeAtomic(filePath, body);
    if (!(await this.repository.updateArtifactSize(artifact.id, body.byteLength))) {
      await rm(filePath, { force: true });
      throw new HttpError(
        409,
        "分析檔已重建，但 metadata 已不存在，請重新整理歷史紀錄。",
        "EFFICIENCY_REPORT_ARTIFACT_METADATA_STALE"
      );
    }
    const rebuiltArtifact = { ...artifact, xlsxSizeBytes: body.byteLength };
    return {
      snapshot: csv.snapshot,
      artifact: rebuiltArtifact,
      filePath,
      filename: this.xlsxFilename(csv.snapshot, attendanceDays),
    };
  }

  private async fetchPublishedSource(): Promise<Buffer> {
    const url = env.REPORT_EXCEL_CSV.trim();
    if (!url) {
      throw new HttpError(
        503,
        "尚未設定 REPORT_EXCEL_CSV，無法建立效率報表歷史版本。",
        "REPORT_EXCEL_CSV_NOT_CONFIGURED"
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new HttpError(500, "REPORT_EXCEL_CSV 需為完整網址。", "REPORT_EXCEL_CSV_NOT_A_URL");
    }
    try {
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: env.REPORT_EXCEL_CSV_TIMEOUT_MS,
        maxContentLength: this.maxSourceBytes,
        maxBodyLength: this.maxSourceBytes,
      });
      return Buffer.from(response.data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/maxContentLength|larger than|max size/i.test(detail)) {
        throw new HttpError(
          413,
          `Ragic 發佈 CSV 超過上限 ${this.maxSourceBytes} bytes。`,
          "EFFICIENCY_REPORT_SOURCE_SIZE_LIMIT_EXCEEDED"
        );
      }
      throw new HttpError(502, `抓取 Ragic 發佈網址失敗：${detail}`, "RAGIC_PUBLISHED_FETCH_FAILED");
    }
  }

  private async writeAtomic(filePath: string, body: Buffer): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${this.idFactory()}.tmp`;
    try {
      await writeFile(tempPath, body, { flag: "wx" });
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  private resolveArchivePath(relativePath: string): string {
    const resolved = path.resolve(this.archiveDir, relativePath);
    if (resolved !== this.archiveDir && !resolved.startsWith(`${this.archiveDir}${path.sep}`)) {
      throw new HttpError(500, "效率報表檔案路徑不合法。", "EFFICIENCY_REPORT_PATH_INVALID");
    }
    return resolved;
  }

  private async validateXlsxBody(body: Buffer): Promise<boolean> {
    if (body.byteLength === 0) return false;
    try {
      const zip = await JSZip.loadAsync(body, { checkCRC32: true });
      return [
        "[Content_Types].xml",
        "xl/workbook.xml",
        "xl/worksheets/sheet1.xml",
        "xl/tables/table1.xml",
      ].every((entry) => zip.file(entry) !== null);
    } catch {
      return false;
    }
  }

  private async assertStoredSourceFile(
    snapshot: EfficiencyReportSnapshotRecord
  ): Promise<string> {
    const filePath = await this.assertStoredFile(snapshot.csvRelativePath);
    try {
      const body = await readFile(filePath);
      if (body.byteLength !== snapshot.sourceSizeBytes) {
        throw new Error("source size mismatch");
      }
      const inspection = inspectForm16PublishedCsv(
        body.toString("utf8"),
        snapshot.periodMonth,
        Math.max(this.maxSourceRows, snapshot.sourceRowCount)
      );
      if (
        inspection.sourceHash !== snapshot.sourceHash ||
        inspection.rowCount !== snapshot.sourceRowCount
      ) {
        throw new Error("source fingerprint mismatch");
      }
      return filePath;
    } catch {
      throw new HttpError(
        410,
        "效率報表歷史來源檔已毀損或與 metadata 不一致。",
        "EFFICIENCY_REPORT_SOURCE_CORRUPT"
      );
    }
  }

  private async assertStoredFile(relativePath: string): Promise<string> {
    const filePath = this.resolveArchivePath(relativePath);
    try {
      await stat(filePath);
      return filePath;
    } catch {
      throw new HttpError(410, "效率報表歷史檔案已不存在。", "EFFICIENCY_REPORT_FILE_MISSING");
    }
  }

  private assertPeriodMonth(periodMonth: string): void {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodMonth)) {
      throw new HttpError(400, "periodMonth 格式需為 YYYY-MM。", "INVALID_QUERY_PARAM");
    }
  }

  private csvFilename(snapshot: EfficiencyReportSnapshotRecord): string {
    return `c1-6-${snapshot.periodMonth}-v${snapshot.version}.csv`;
  }

  private xlsxFilename(
    snapshot: EfficiencyReportSnapshotRecord,
    attendanceDays?: number
  ): string {
    const days = attendanceDays === undefined ? "default" : String(attendanceDays).replace(".", "_");
    return `c1-6-analysis-${snapshot.periodMonth}-v${snapshot.version}-days-${days}.xlsx`;
  }
}

export const form16EfficiencyReportArchiveService = new Form16EfficiencyReportArchiveService();
