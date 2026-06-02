import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import {
  ReportFullCacheMeta,
  ReportFullCacheSource,
  ReportFullCacheState,
  ReportFullSnapshotPayload,
  WorkReportRecord,
} from "../types/workReport";

const SNAPSHOT_VERSION = "v3";

interface SnapshotCacheEntry {
  payload: ReportFullSnapshotPayload;
  source: "file-cache" | "memory-cache";
  dirty: boolean;
}

interface NormalizedRecordsResult {
  records: WorkReportRecord[];
  truncated: boolean;
  truncatedCount: number;
}

interface GetOrBuildOptions {
  forceRefresh: boolean;
  builder: () => Promise<WorkReportRecord[]>;
}

interface GetOrBuildResult {
  data: WorkReportRecord[];
  meta: ReportFullCacheMeta;
}

class ReportFullSnapshotService {
  private readonly cacheByFormId = new Map<string, SnapshotCacheEntry>();
  private readonly loadedForms = new Set<string>();
  private readonly rebuildTasks = new Map<string, Promise<void>>();
  private readonly inflightBlockingBuilds = new Map<
    string,
    Promise<ReportFullSnapshotPayload>
  >();

  async getOrBuild(formId: string, options: GetOrBuildOptions): Promise<GetOrBuildResult> {
    if (!env.REPORT_FULL_CACHE_ENABLED) {
      const payload = await this.buildSnapshotDeduped(
        formId,
        options.builder,
        "disabled-cache"
      );
      return this.toResult(payload.records, this.buildMeta(payload, {
        formId,
        cacheSource: "ragic-live",
        cacheState: "fresh",
        snapshotAt: payload.snapshotAt,
        expiresAt: payload.expiresAt,
        refreshTriggered: false,
      }));
    }

    await this.ensureLoadedFromFile(formId);

    if (options.forceRefresh) {
      const payload = await this.buildSnapshotDeduped(
        formId,
        options.builder,
        "force-refresh"
      );
      return this.toResult(payload.records, this.buildMeta(payload, {
        formId,
        cacheSource: "ragic-live",
        cacheState: "fresh",
        snapshotAt: payload.snapshotAt,
        expiresAt: payload.expiresAt,
        refreshTriggered: true,
      }));
    }

    const cached = this.cacheByFormId.get(formId);
    if (!cached) {
      const payload = await this.buildSnapshotDeduped(
        formId,
        options.builder,
        "cold-start"
      );
      return this.toResult(payload.records, this.buildMeta(payload, {
        formId,
        cacheSource: "ragic-live",
        cacheState: "fresh",
        snapshotAt: payload.snapshotAt,
        expiresAt: payload.expiresAt,
        refreshTriggered: false,
      }));
    }

    const cacheState = this.resolveCacheState(cached, formId);
    if (cacheState === "fresh") {
      console.info("[full-cache-hit]", {
        formId,
        source: cached.source,
        count: cached.payload.records.length,
        snapshotAt: cached.payload.snapshotAt,
        expiresAt: cached.payload.expiresAt,
      });
      return this.toResult(cached.payload.records, this.buildMeta(cached.payload, {
        formId,
        cacheSource: cached.source,
        cacheState,
        snapshotAt: cached.payload.snapshotAt,
        expiresAt: cached.payload.expiresAt,
        refreshTriggered: false,
      }));
    }

    if (!env.REPORT_FULL_CACHE_STALE_WHILE_REVALIDATE || cached.payload.records.length === 0) {
      const payload = await this.buildSnapshotDeduped(
        formId,
        options.builder,
        "stale-blocking"
      );
      return this.toResult(payload.records, this.buildMeta(payload, {
        formId,
        cacheSource: "ragic-live",
        cacheState: "fresh",
        snapshotAt: payload.snapshotAt,
        expiresAt: payload.expiresAt,
        refreshTriggered: true,
      }));
    }

    const refreshTriggered = this.triggerRebuildInBackground(
      formId,
      options.builder,
      "stale-swr"
    );
    const staleState = this.rebuildTasks.has(formId) ? "building" : "stale";

    console.info("[full-cache-stale-return]", {
      formId,
      source: cached.source,
      count: cached.payload.records.length,
      snapshotAt: cached.payload.snapshotAt,
      expiresAt: cached.payload.expiresAt,
      refreshTriggered,
      staleState,
    });

    return this.toResult(cached.payload.records, this.buildMeta(cached.payload, {
      formId,
      cacheSource: cached.source,
      cacheState: staleState,
      snapshotAt: cached.payload.snapshotAt,
      expiresAt: cached.payload.expiresAt,
      refreshTriggered,
    }));
  }

  markDirty(formId: string): void {
    const cached = this.cacheByFormId.get(formId);
    if (!cached) {
      return;
    }
    cached.dirty = true;
    console.info("[full-cache-dirty-marked]", {
      formId,
      snapshotAt: cached.payload.snapshotAt,
      expiresAt: cached.payload.expiresAt,
    });
  }

  triggerRebuildInBackground(
    formId: string,
    builder: () => Promise<WorkReportRecord[]>,
    reason = "manual-background"
  ): boolean {
    if (!env.REPORT_FULL_CACHE_ENABLED) {
      return false;
    }
    if (this.rebuildTasks.has(formId)) {
      return false;
    }

    const task = this.buildSnapshot(formId, builder, reason)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (this.rebuildTasks.get(formId) === task) {
          this.rebuildTasks.delete(formId);
        }
      });
    this.rebuildTasks.set(formId, task);
    return true;
  }

  private toResult(
    records: WorkReportRecord[],
    meta: Omit<ReportFullCacheMeta, "count">
  ): GetOrBuildResult {
    return {
      data: records,
      meta: {
        ...meta,
        count: records.length,
      },
    };
  }

  private buildMeta(
    payload: ReportFullSnapshotPayload,
    meta: Omit<ReportFullCacheMeta, "count" | "truncated" | "truncatedCount">
  ): Omit<ReportFullCacheMeta, "count"> {
    return {
      ...meta,
      truncated: Boolean(payload.truncated),
      ...(payload.truncated ? { truncatedCount: payload.truncatedCount ?? 0 } : {}),
    };
  }

  private resolveCacheState(
    cached: SnapshotCacheEntry,
    formId: string
  ): ReportFullCacheState {
    if (cached.dirty || this.isExpired(cached.payload.expiresAt)) {
      if (this.rebuildTasks.has(formId)) {
        return "building";
      }
      return "stale";
    }
    return "fresh";
  }

  private isExpired(expiresAt: string): boolean {
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      return true;
    }
    return Date.now() > expiresAtMs;
  }

  private async ensureLoadedFromFile(formId: string): Promise<void> {
    if (this.loadedForms.has(formId)) {
      return;
    }
    this.loadedForms.add(formId);

    const filePath = this.resolveSnapshotFilePath(formId);
    if (!filePath) {
      return;
    }

    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ReportFullSnapshotPayload>;
      if (!this.isSnapshotPayloadValid(parsed, formId)) {
        console.warn("[full-cache-file-invalid]", { formId, filePath });
        return;
      }
      const payload = parsed as ReportFullSnapshotPayload;
      const normalized = this.normalizeRecords(payload.records);
      this.cacheByFormId.set(formId, {
        payload: {
          ...payload,
          records: normalized.records,
          truncated: payload.truncated ?? normalized.truncated,
          truncatedCount: payload.truncatedCount ?? normalized.truncatedCount,
        },
        source: "file-cache",
        dirty: false,
      });
      console.info("[full-cache-file-loaded]", {
        formId,
        filePath,
        count: payload.records.length,
        snapshotAt: payload.snapshotAt,
        expiresAt: payload.expiresAt,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      console.warn("[full-cache-file-read-failed]", {
        formId,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private normalizeRecords(records: WorkReportRecord[]): NormalizedRecordsResult {
    const dedupe = new Map<string, WorkReportRecord>();
    for (const record of records) {
      const id = String(record.id ?? "");
      if (!id) {
        continue;
      }
      dedupe.set(id, {
        ...record,
        id,
        reports: Array.isArray(record.reports) ? record.reports : [],
      });
    }
    const normalizedRecords = Array.from(dedupe.values());
    const truncatedCount = Math.max(0, normalizedRecords.length - env.REPORT_FULL_CACHE_MAX_RECORDS);
    return {
      records: normalizedRecords.slice(0, env.REPORT_FULL_CACHE_MAX_RECORDS),
      truncated: truncatedCount > 0,
      truncatedCount,
    };
  }

  private isSnapshotPayloadValid(
    payload: Partial<ReportFullSnapshotPayload>,
    formId: string
  ): payload is ReportFullSnapshotPayload {
    return (
      payload.version === SNAPSHOT_VERSION &&
      payload.formId === formId &&
      typeof payload.snapshotAt === "string" &&
      typeof payload.expiresAt === "string" &&
      Array.isArray(payload.records)
    );
  }

  private async buildSnapshotDeduped(
    formId: string,
    builder: () => Promise<WorkReportRecord[]>,
    reason: string
  ): Promise<ReportFullSnapshotPayload> {
    const existing = this.inflightBlockingBuilds.get(formId);
    if (existing) {
      console.info("[full-cache-rebuild-dedup]", { formId, reason });
      return existing;
    }
    const task = this.buildSnapshot(formId, builder, reason).finally(() => {
      if (this.inflightBlockingBuilds.get(formId) === task) {
        this.inflightBlockingBuilds.delete(formId);
      }
    });
    this.inflightBlockingBuilds.set(formId, task);
    return task;
  }

  private async buildSnapshot(
    formId: string,
    builder: () => Promise<WorkReportRecord[]>,
    reason: string
  ): Promise<ReportFullSnapshotPayload> {
    console.info("[full-cache-rebuild-start]", { formId, reason });
    try {
      const normalized = this.normalizeRecords(await builder());
      const now = Date.now();
      const payload: ReportFullSnapshotPayload = {
        version: SNAPSHOT_VERSION,
        formId,
        snapshotAt: new Date(now).toISOString(),
        expiresAt: new Date(now + env.REPORT_FULL_CACHE_TTL_MS).toISOString(),
        records: normalized.records,
        truncated: normalized.truncated,
        truncatedCount: normalized.truncatedCount,
      };

      await this.writeSnapshotFile(formId, payload);
      this.cacheByFormId.set(formId, {
        payload,
        source: "memory-cache",
        dirty: false,
      });
      console.info("[full-cache-rebuild-end]", {
        formId,
        reason,
        count: normalized.records.length,
        truncated: normalized.truncated,
        truncatedCount: normalized.truncatedCount,
        snapshotAt: payload.snapshotAt,
        expiresAt: payload.expiresAt,
      });
      return payload;
    } catch (error) {
      console.warn("[full-cache-rebuild-fail]", {
        formId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private resolveSnapshotFilePath(formId: string): string | null {
    if (!env.REPORT_FULL_CACHE_FILE) {
      return null;
    }
    if (formId === "104") {
      return path.resolve(env.REPORT_FULL_CACHE_FILE);
    }
    return path.resolve(env.REPORT_FULL_CACHE_FILE.replace(/\.json$/i, `.${formId}.json`));
  }

  private async writeSnapshotFile(
    formId: string,
    payload: ReportFullSnapshotPayload
  ): Promise<void> {
    const filePath = this.resolveSnapshotFilePath(formId);
    if (!filePath) {
      return;
    }
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true });
    const tempFilePath = `${filePath}.tmp`;
    await fs.writeFile(tempFilePath, JSON.stringify(payload), "utf-8");
    await fs.rename(tempFilePath, filePath);
  }
}

export const reportFullSnapshotService = new ReportFullSnapshotService();
