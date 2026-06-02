import { RagicRecord } from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { WorkReportItem, WorkReportRecord } from "../../../types/workReport";
import { isObject, RagicRow, SourceDataMap } from "../shared/ragicRowUtils";

export function resolveCandidateFieldKeys(
  primaryFieldKey: string,
  fallbackFieldKeys?: string
): string[] {
  return [
    primaryFieldKey,
    ...(fallbackFieldKeys
      ? fallbackFieldKeys
          .split("|")
          .map((key) => key.trim())
          .filter(Boolean)
      : []),
  ]
    .map((key) => key.trim())
    .filter(Boolean);
}

export function normalizeMappedFieldValue(fieldName: string, value: unknown): unknown {
  if (fieldName === "modificationStatus") {
    if (Array.isArray(value)) {
      const normalizedItems = value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
      return normalizedItems.length > 0 ? normalizedItems.join("、") : null;
    }
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized || null;
    }
    return value;
  }

  if (fieldName !== "machineCode" || typeof value !== "string") {
    return value;
  }
  const normalized = value.trim();
  if (!normalized) {
    return normalized;
  }
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex >= 0 && atIndex < normalized.length - 1) {
    return normalized.slice(atIndex + 1).trim();
  }
  if (normalized.includes("-")) {
    const lastToken = normalized.split("-").pop()?.trim() ?? "";
    if (/^[A-Z]{1,3}\d{0,2}$/i.test(lastToken)) {
      return lastToken.toUpperCase();
    }
  }
  return normalized;
}

export function mapFields(
  data: RagicRecord,
  fieldMapping: Record<string, string>,
  fallbackMapping?: Record<string, string>
): RagicRecord {
  const mapped: RagicRecord = {};
  const hasMeaningfulValue = (value: unknown): boolean => {
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim() !== "";
    }
    return true;
  };

  for (const [fieldName, fieldId] of Object.entries(fieldMapping)) {
    const candidateKeys = resolveCandidateFieldKeys(fieldId, fallbackMapping?.[fieldName]);
    let firstSeenValue: unknown = null;
    let hasFirstSeen = false;

    for (const key of candidateKeys) {
      if (!(key in data)) {
        continue;
      }
      const value = data[key];
      if (!hasFirstSeen) {
        firstSeenValue = value;
        hasFirstSeen = true;
      }
      if (hasMeaningfulValue(value)) {
        mapped[fieldName] = normalizeMappedFieldValue(fieldName, value);
        break;
      }
    }

    if (mapped[fieldName] !== undefined) {
      continue;
    }
    mapped[fieldName] = hasFirstSeen ? normalizeMappedFieldValue(fieldName, firstSeenValue) : null;
  }

  return mapped;
}

export function mapSubtable(subtableRaw: unknown, config: FormConfig): WorkReportItem[] {
  if (!isObject(subtableRaw)) {
    return [];
  }

  const mappedSourceFieldNames = new Set(Object.values(config.subtableFields));
  const isScalarLike = (value: unknown): value is string | number | boolean | null =>
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";

  const normalizeScalarValue = (
    value: string | number | boolean | null
  ): string | number | boolean | null => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  const pickNestedScalarValue = (value: unknown): string | number | boolean | null | undefined => {
    if (!isObject(value)) {
      return undefined;
    }
    const scalarKeys = ["value", "_value", "label", "_label"] as const;
    for (const key of scalarKeys) {
      const candidate = value[key];
      if (!isScalarLike(candidate)) {
        continue;
      }
      return normalizeScalarValue(candidate);
    }
    return undefined;
  };

  return Object.entries(subtableRaw)
    .filter(([rowId, row]) => /^\d+$/.test(rowId) && isObject(row))
    .map(([rowId, row]) => {
      const mapped = mapFields(row as RagicRecord, config.subtableFields);
      const extras: RagicRecord = {};
      for (const [rawKey, rawValue] of Object.entries(row as RagicRecord)) {
        if (mappedSourceFieldNames.has(rawKey)) {
          continue;
        }
        if (rawKey.startsWith("_")) {
          continue;
        }
        if (isScalarLike(rawValue)) {
          extras[rawKey] = normalizeScalarValue(rawValue);
          continue;
        }
        const nestedScalar = pickNestedScalarValue(rawValue);
        if (nestedScalar !== undefined) {
          extras[rawKey] = nestedScalar;
        }
      }
      const remarkValue = mapped.remark;
      const remarkText = remarkValue === undefined || remarkValue === null ? null : String(remarkValue);

      return {
        ...(extras as WorkReportItem),
        ...(mapped as WorkReportItem),
        rowId,
        remark: remarkText,
      };
    });
}

export function enrichLinkedFields(
  reports: WorkReportItem[],
  config: FormConfig,
  linkedSources: Map<string, SourceDataMap>
): void {
  if (!config.linkedFields || reports.length === 0) {
    return;
  }

  for (const reportItem of reports) {
    for (const [fieldName, linkedConfig] of Object.entries(config.linkedFields)) {
      const sourceMap = linkedSources.get(fieldName);
      if (!sourceMap) {
        continue;
      }

      const linkedId = reportItem[fieldName];
      if (linkedId === null || linkedId === undefined || linkedId === "") {
        reportItem[`${fieldName}Display`] = null;
        continue;
      }

      const sourceRecord = sourceMap.get(String(linkedId));
      reportItem[`${fieldName}Display`] = sourceRecord?.[linkedConfig.displayFieldId] ?? null;
    }
  }
}

export function transformRow(
  row: RagicRow,
  config: FormConfig,
  linkedSources: Map<string, SourceDataMap>
): WorkReportRecord {
  const mainData = mapFields(row.data, config.mainFields, config.mainFieldFallbacks);
  const filterData = config.filterFields
    ? mapFields(row.data, config.filterFields, config.filterFieldFallbacks)
    : {};
  const subtableRaw = row.data[config.subtableId];
  const reports = mapSubtable(subtableRaw, config);
  enrichLinkedFields(reports, config, linkedSources);

  return {
    id: String(row.data._ragicId ?? row.data._ragic_id ?? row.entryId),
    ...mainData,
    ...Object.fromEntries(
      Object.entries(filterData).map(([key, value]) => [
        `filter${key[0].toUpperCase()}${key.slice(1)}`,
        value,
      ])
    ),
    reports,
  };
}
