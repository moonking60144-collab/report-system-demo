import type { ProjectionReason } from "./workReportMutationProjectionServiceFactory";

export interface RecentMutationProjectionRecord {
  formId: string;
  entryId: string;
  reason: ProjectionReason;
  projectedAt: string;
}

const DEFAULT_WINDOW_MS = 5_000;

export class RecentMutationProjectionWindow {
  private readonly records = new Map<
    string,
    RecentMutationProjectionRecord & { projectedAtMs: number }
  >();

  mark(record: RecentMutationProjectionRecord): void {
    const normalizedFormId = String(record.formId ?? "").trim();
    const normalizedEntryId = String(record.entryId ?? "").trim();
    if (!normalizedFormId || !normalizedEntryId) {
      return;
    }

    const projectedAtMs = Date.parse(record.projectedAt);
    const effectiveProjectedAtMs = Number.isNaN(projectedAtMs) ? Date.now() : projectedAtMs;
    this.records.set(this.buildKey(normalizedFormId, normalizedEntryId), {
      ...record,
      formId: normalizedFormId,
      entryId: normalizedEntryId,
      projectedAt: Number.isNaN(projectedAtMs)
        ? new Date(effectiveProjectedAtMs).toISOString()
        : record.projectedAt,
      projectedAtMs: effectiveProjectedAtMs,
    });
    this.prune(DEFAULT_WINDOW_MS);
  }

  getRecent(
    formId: string,
    entryId: string,
    windowMs: number = DEFAULT_WINDOW_MS
  ): RecentMutationProjectionRecord | null {
    const normalizedFormId = String(formId ?? "").trim();
    const normalizedEntryId = String(entryId ?? "").trim();
    if (!normalizedFormId || !normalizedEntryId) {
      return null;
    }

    this.prune(windowMs);
    const record = this.records.get(this.buildKey(normalizedFormId, normalizedEntryId));
    if (!record) {
      return null;
    }
    if (Date.now() - record.projectedAtMs > Math.max(0, windowMs)) {
      this.records.delete(this.buildKey(normalizedFormId, normalizedEntryId));
      return null;
    }
    return {
      formId: record.formId,
      entryId: record.entryId,
      reason: record.reason,
      projectedAt: record.projectedAt,
    };
  }

  private buildKey(formId: string, entryId: string): string {
    return `${formId}:${entryId}`;
  }

  private prune(windowMs: number): void {
    const effectiveWindowMs = Math.max(0, windowMs);
    const now = Date.now();
    for (const [key, record] of this.records.entries()) {
      if (now - record.projectedAtMs > effectiveWindowMs) {
        this.records.delete(key);
      }
    }
  }
}

export const recentMutationProjectionWindow = new RecentMutationProjectionWindow();
