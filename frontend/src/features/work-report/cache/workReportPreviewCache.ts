import type {
  WorkReportReadMeta,
  WorkReportRecord,
  WorkReportResponse,
} from "../../../api/workReport";
import type { WorkReportFormId } from "../types";

export interface PreviewPageCacheEntry {
  key: string;
  formId: WorkReportFormId;
  page: number;
  pageSize: number;
  records: WorkReportRecord[];
  hasMore: boolean;
  totalCount: number;
  readMeta: WorkReportReadMeta;
  cachedAt: number;
}

export interface PreviewInFlightRequest {
  revision: number;
  promise: Promise<WorkReportResponse>;
  signal?: AbortSignal;
}

const PREVIEW_CACHE_MAX_ENTRIES = 24;
const PREVIEW_CACHE_MAX_AGE_MS = 2 * 60 * 1000;

export class PreviewPageCache {
  private readonly entries = new Map<string, PreviewPageCacheEntry>();
  private readonly formRevisions = new Map<WorkReportFormId, number>();
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;

  constructor(
    maxEntries = PREVIEW_CACHE_MAX_ENTRIES,
    maxAgeMs = PREVIEW_CACHE_MAX_AGE_MS
  ) {
    this.maxEntries = maxEntries;
    this.maxAgeMs = maxAgeMs;
  }

  get(key: string, now = Date.now()): PreviewPageCacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (now - entry.cachedAt > this.maxAgeMs) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  peek(key: string, now = Date.now()): PreviewPageCacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (now - entry.cachedAt > this.maxAgeMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  set(entry: PreviewPageCacheEntry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  updateFormRecords(
    formId: WorkReportFormId,
    update: (records: WorkReportRecord[]) => WorkReportRecord[]
  ): void {
    for (const [key, entry] of this.entries) {
      if (entry.formId !== formId) {
        continue;
      }
      const records = update(entry.records);
      if (records !== entry.records) {
        this.entries.set(key, { ...entry, records });
      }
    }
  }

  invalidateForm(formId: WorkReportFormId): void {
    for (const [key, entry] of this.entries) {
      if (entry.formId === formId) {
        this.entries.set(key, {
          ...entry,
          readMeta: {
            ...entry.readMeta,
            cacheState: "stale",
          },
        });
      }
    }
    this.formRevisions.set(formId, this.revision(formId) + 1);
  }

  revision(formId: WorkReportFormId): number {
    return this.formRevisions.get(formId) ?? 0;
  }
}
