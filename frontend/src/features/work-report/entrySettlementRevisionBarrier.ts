import type { WorkReportFormId } from "./types";
import {
  parseSemanticBoolean,
  toSortableDate,
  toSortableNumber,
} from "./utils/valueUtils";
import { normalizePlannedEndDate } from "./utils/plannedEndDateUtils";

function isExpectedPatchValueObserved(
  key: string,
  incomingValue: unknown,
  expectedValue: unknown
): boolean {
  if (key === "sortOrder") {
    return toSortableNumber(incomingValue) === toSortableNumber(expectedValue);
  }
  if (key === "urgent" || key === "startSchedule") {
    return parseSemanticBoolean(incomingValue) === parseSemanticBoolean(expectedValue);
  }
  if (key === "plannedEndDate") {
    return normalizePlannedEndDate(incomingValue) === normalizePlannedEndDate(expectedValue);
  }
  return Object.is(incomingValue, expectedValue);
}

export class WorkReportEntrySettlementRevisionBarrier<
  TRecord extends { id: unknown; lastUpdatedAt?: unknown }
> {
  private revision = 0;
  private readonly recordsByForm = new Map<
    WorkReportFormId,
    Map<
      string,
      { revision: number; record: TRecord; expectedPatch?: Partial<TRecord> }
    >
  >();

  captureRevision(): number {
    return this.revision;
  }

  record(
    formId: WorkReportFormId,
    record: TRecord,
    expectedPatch?: Partial<TRecord>
  ): void {
    this.revision += 1;
    const records = this.recordsByForm.get(formId) ?? new Map();
    records.set(String(record.id), {
      revision: this.revision,
      record,
      expectedPatch,
    });
    this.recordsByForm.set(formId, records);
  }

  mergeRecord(
    formId: WorkReportFormId,
    requestRevision: number,
    record: TRecord
  ): TRecord {
    const settlement = this.recordsByForm
      .get(formId)
      ?.get(String(record.id));
    if (!settlement) {
      return record;
    }
    if (settlement.revision > requestRevision) {
      return settlement.record;
    }

    const settlementVersion = toSortableDate(settlement.record.lastUpdatedAt);
    const incomingVersion = toSortableDate(record.lastUpdatedAt);
    if (
      settlementVersion !== null &&
      incomingVersion !== null &&
      incomingVersion > settlementVersion
    ) {
      this.clearSettlement(formId, String(record.id), settlement.revision);
      return record;
    }
    if (
      settlementVersion !== null &&
      incomingVersion !== null &&
      settlementVersion > incomingVersion
    ) {
      return settlement.record;
    }
    if (
      settlement.expectedPatch &&
      Object.entries(settlement.expectedPatch).every(
        ([key, value]) =>
          isExpectedPatchValueObserved(key, record[key as keyof TRecord], value)
      )
    ) {
      this.clearSettlement(formId, String(record.id), settlement.revision);
      return record;
    }
    if (
      settlement.expectedPatch &&
      Object.keys(settlement.expectedPatch).length > 0
    ) {
      return settlement.record;
    }
    return record;
  }

  private clearSettlement(
    formId: WorkReportFormId,
    entryId: string,
    revision: number
  ): void {
    const records = this.recordsByForm.get(formId);
    if (records?.get(entryId)?.revision !== revision) {
      return;
    }
    records.delete(entryId);
    if (records.size === 0) {
      this.recordsByForm.delete(formId);
    }
  }

  mergeRecords(
    formId: WorkReportFormId,
    requestRevision: number,
    records: TRecord[],
    options: { includeMissingSettlements?: boolean } = {}
  ): TRecord[] {
    const settlements = this.recordsByForm.get(formId);
    if (!settlements) {
      return records;
    }
    let changed = false;
    const seenEntryIds = new Set<string>();
    const merged = records.map((record) => {
      const entryId = String(record.id);
      seenEntryIds.add(entryId);
      const nextRecord = this.mergeRecord(formId, requestRevision, record);
      if (nextRecord !== record) {
        changed = true;
      }
      return nextRecord;
    });
    if (options.includeMissingSettlements !== false) {
      for (const [entryId, settlement] of settlements) {
        if (
          settlement.revision > requestRevision &&
          !seenEntryIds.has(entryId)
        ) {
          merged.push(settlement.record);
          changed = true;
        }
      }
    }
    return changed ? merged : records;
  }

  merge(
    formId: WorkReportFormId,
    requestRevision: number,
    records: TRecord[]
  ): TRecord[] {
    return this.mergeRecords(formId, requestRevision, records);
  }
}
