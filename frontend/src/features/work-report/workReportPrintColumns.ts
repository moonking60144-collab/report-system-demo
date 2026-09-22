import type { WorkReportRecord } from "../../api/workReport";
import type { UiLanguage, WorkReportFormId } from "./types";

export type WorkReportPrintColumnFormat = "number" | "urgent";

export interface WorkReportPrintColumn {
  key: string;
  zh: string;
  en: string;
  widthWeight: number;
  format?: WorkReportPrintColumnFormat;
  defaultVisible?: boolean;
}

interface WorkReportPrintColumnPreference {
  version: 1;
  visibleColumnKeys: string[];
  knownColumnKeys: string[];
}

interface PrintColumnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PRINT_COLUMN_PREFERENCE_VERSION = 1;
const PRINT_COLUMN_STORAGE_PREFIX = "work-report:print-columns";
const PRINT_COLUMN_HEADER_WIDTH_FACTOR = 0.55;
const PRINT_COLUMN_CELL_PADDING_UNITS = 1.5;
const PRINT_COLUMN_UNITS_PER_WEIGHT = 8;
const PRINT_COLUMN_MIN_WEIGHT_FACTOR = 0.55;
const PRINT_COLUMN_MAX_WEIGHT_FACTOR = 2.1;

const FORM_901_PRINT_COLUMNS: readonly WorkReportPrintColumn[] = [
  { key: "sortOrder", zh: "排序", en: "Sort", format: "number", widthWeight: 0.42 },
  { key: "workOrderNo", zh: "工令單號", en: "Work Order", widthWeight: 1.05 },
  { key: "forgingMother", zh: "前置母件", en: "Forging Base", widthWeight: 1.9 },
  { key: "size", zh: "尺寸", en: "Size", widthWeight: 0.72 },
  { key: "workOrderType", zh: "內製／委外", en: "In-house / Outsourced", widthWeight: 0.75 },
  { key: "previousMachine", zh: "上一站機台", en: "Previous Machine", widthWeight: 1.05 },
  {
    key: "currentMaterial",
    zh: "目前使用來料",
    en: "Current Material",
    widthWeight: 1.15,
    defaultVisible: false,
  },
  { key: "urgent", zh: "急件", en: "Urgent", format: "urgent", widthWeight: 0.42 },
  { key: "estimatedHours", zh: "預估工時", en: "Est. Hours", format: "number", widthWeight: 0.72 },
  { key: "prevPlanEndDate", zh: "上製程完成日", en: "Prev. End", widthWeight: 0.86 },
  { key: "plannedEndDate", zh: "指定結束日", en: "Planned End", widthWeight: 0.86 },
  { key: "targetQtyPc", zh: "目標數 pc", en: "Target pc", format: "number", widthWeight: 0.7 },
  { key: "pendingQty", zh: "待生產", en: "Pending", format: "number", widthWeight: 0.72 },
  { key: "producedQtyStat", zh: "已生產", en: "Produced", format: "number", widthWeight: 0.72 },
  { key: "prevReportQtyPc", zh: "上一站報工 pc", en: "Prev. Report", format: "number", widthWeight: 0.78 },
  { key: "prevCompleteContainer", zh: "上一站完工容器", en: "Prev. Containers", widthWeight: 0.9 },
];

const FORM_902_PRINT_COLUMNS: readonly WorkReportPrintColumn[] = [
  { key: "sortOrder", zh: "排序", en: "Sort", format: "number", widthWeight: 0.42 },
  { key: "workOrderNo", zh: "工令單號", en: "Work Order", widthWeight: 1.05 },
  { key: "forgingMother", zh: "前置母件", en: "Forging Base", widthWeight: 1.9 },
  { key: "size", zh: "尺寸", en: "Size", widthWeight: 0.72 },
  { key: "workOrderType", zh: "內製／委外", en: "In-house / Outsourced", widthWeight: 0.75 },
  { key: "previousMachine", zh: "上一站機台", en: "Previous Machine", widthWeight: 1.05 },
  {
    key: "currentMaterial",
    zh: "目前使用來料",
    en: "Current Material",
    widthWeight: 1.15,
    defaultVisible: false,
  },
  { key: "urgent", zh: "急件", en: "Urgent", format: "urgent", widthWeight: 0.42 },
  { key: "plannedStartDate", zh: "指定開始日", en: "Planned Start", widthWeight: 0.86 },
  { key: "plannedEndDate", zh: "指定結束日", en: "Planned End", widthWeight: 0.86 },
  { key: "estimatedHours", zh: "預估工時", en: "Est. Hours", format: "number", widthWeight: 0.72 },
  { key: "targetQtyPc", zh: "目標數 pc", en: "Target pc", format: "number", widthWeight: 0.7 },
  { key: "pendingQty", zh: "待生產", en: "Pending", format: "number", widthWeight: 0.72 },
  { key: "producedQtyStat", zh: "已生產", en: "Produced", format: "number", widthWeight: 0.72 },
  { key: "prevReportQtyPc", zh: "上一站報工 pc", en: "Prev. Report", format: "number", widthWeight: 0.78 },
  { key: "status", zh: "工令狀態", en: "Status", widthWeight: 0.75 },
];

export function getWorkReportPrintColumns(
  formId: WorkReportFormId
): readonly WorkReportPrintColumn[] {
  return formId === "901" ? FORM_901_PRINT_COLUMNS : FORM_902_PRINT_COLUMNS;
}

export function getWorkReportPrintColumnLabel(
  column: WorkReportPrintColumn,
  language: UiLanguage
): string {
  return language === "en" ? column.en : column.zh;
}

function estimatePrintTextUnits(value: unknown): number {
  const text = String(value ?? "").trim();
  let units = 0;
  for (const character of text) {
    if (/\s/u.test(character)) {
      units += 0.5;
    } else {
      units += (character.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
    }
  }
  return units;
}

function resolveColumnValueUnits(
  column: WorkReportPrintColumn,
  value: unknown
): number {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (column.format === "urgent") return 1;
  return estimatePrintTextUnits(text);
}

function resolvePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentile) - 1)
  );
  return sorted[index];
}

export function getWorkReportPrintColumnWidthWeights(
  formId: WorkReportFormId,
  records: readonly WorkReportRecord[],
  language: UiLanguage
): Map<string, number> {
  return new Map(
    getWorkReportPrintColumns(formId).map((column) => {
      const headerUnits = estimatePrintTextUnits(
        getWorkReportPrintColumnLabel(column, language)
      );
      const contentUnits = resolvePercentile(
        records
          .map((record) => resolveColumnValueUnits(column, record[column.key]))
          .filter((units) => units > 0),
        0.9
      );
      const naturalWeight =
        (Math.max(headerUnits * PRINT_COLUMN_HEADER_WIDTH_FACTOR, contentUnits) +
          PRINT_COLUMN_CELL_PADDING_UNITS) /
        PRINT_COLUMN_UNITS_PER_WEIGHT;
      const minimumWeight = column.widthWeight * PRINT_COLUMN_MIN_WEIGHT_FACTOR;
      const maximumWeight = column.widthWeight * PRINT_COLUMN_MAX_WEIGHT_FACTOR;
      return [
        column.key,
        Math.min(maximumWeight, Math.max(minimumWeight, naturalWeight)),
      ];
    })
  );
}

export function getDefaultWorkReportPrintColumnKeys(formId: WorkReportFormId): string[] {
  return getWorkReportPrintColumns(formId)
    .filter((column) => column.defaultVisible !== false)
    .map((column) => column.key);
}

export function getWorkReportPrintColumnStorageKey(formId: WorkReportFormId): string {
  return `${PRINT_COLUMN_STORAGE_PREFIX}:${formId}`;
}

export function normalizeWorkReportPrintColumnPreference(
  formId: WorkReportFormId,
  value: unknown
): string[] {
  const columns = getWorkReportPrintColumns(formId);
  const availableKeys = new Set(columns.map((column) => column.key));
  const defaults = getDefaultWorkReportPrintColumnKeys(formId);
  if (!value || typeof value !== "object") return defaults;

  const candidate = value as Partial<WorkReportPrintColumnPreference>;
  if (
    candidate.version !== PRINT_COLUMN_PREFERENCE_VERSION ||
    !Array.isArray(candidate.visibleColumnKeys) ||
    !Array.isArray(candidate.knownColumnKeys)
  ) {
    return defaults;
  }

  const visibleKeys = new Set(
    candidate.visibleColumnKeys.filter(
      (key): key is string => typeof key === "string" && availableKeys.has(key)
    )
  );
  const knownKeys = new Set(
    candidate.knownColumnKeys.filter((key): key is string => typeof key === "string")
  );
  for (const column of columns) {
    if (!knownKeys.has(column.key) && column.defaultVisible !== false) {
      visibleKeys.add(column.key);
    }
  }

  const normalized = columns
    .map((column) => column.key)
    .filter((key) => visibleKeys.has(key));
  return normalized.length > 0 ? normalized : defaults;
}

export function loadWorkReportPrintColumnKeys(
  formId: WorkReportFormId,
  storage: PrintColumnStorage
): string[] {
  try {
    const raw = storage.getItem(getWorkReportPrintColumnStorageKey(formId));
    return raw
      ? normalizeWorkReportPrintColumnPreference(formId, JSON.parse(raw))
      : getDefaultWorkReportPrintColumnKeys(formId);
  } catch {
    return getDefaultWorkReportPrintColumnKeys(formId);
  }
}

export function saveWorkReportPrintColumnKeys(
  formId: WorkReportFormId,
  visibleColumnKeys: readonly string[],
  storage: PrintColumnStorage
): string[] {
  const columns = getWorkReportPrintColumns(formId);
  const normalized = normalizeWorkReportPrintColumnPreference(formId, {
    version: PRINT_COLUMN_PREFERENCE_VERSION,
    visibleColumnKeys: [...visibleColumnKeys],
    knownColumnKeys: columns.map((column) => column.key),
  });
  try {
    storage.setItem(
      getWorkReportPrintColumnStorageKey(formId),
      JSON.stringify({
        version: PRINT_COLUMN_PREFERENCE_VERSION,
        visibleColumnKeys: normalized,
        knownColumnKeys: columns.map((column) => column.key),
      } satisfies WorkReportPrintColumnPreference)
    );
  } catch {
    return normalized;
  }
  return normalized;
}

export function resetWorkReportPrintColumnKeys(
  formId: WorkReportFormId,
  storage: PrintColumnStorage
): string[] {
  try {
    storage.removeItem(getWorkReportPrintColumnStorageKey(formId));
  } catch {
    // 瀏覽器阻擋 storage 時仍可在本次預覽回到預設欄位。
  }
  return getDefaultWorkReportPrintColumnKeys(formId);
}

export function getWorkReportPrintColumnWidths(
  formId: WorkReportFormId,
  visibleColumnKeys: readonly string[],
  widthWeights?: ReadonlyMap<string, number>
): Map<string, number> {
  const visibleKeys = new Set(visibleColumnKeys);
  const visibleColumns = getWorkReportPrintColumns(formId).filter((column) =>
    visibleKeys.has(column.key)
  );
  const resolveWeight = (column: WorkReportPrintColumn): number => {
    const weight = widthWeights?.get(column.key);
    return typeof weight === "number" && Number.isFinite(weight) && weight > 0
      ? weight
      : column.widthWeight;
  };
  const totalWeight = visibleColumns.reduce(
    (total, column) => total + resolveWeight(column),
    0
  );
  return new Map(
    visibleColumns.map((column) => [
      column.key,
      totalWeight > 0 ? (resolveWeight(column) / totalWeight) * 100 : 0,
    ])
  );
}
