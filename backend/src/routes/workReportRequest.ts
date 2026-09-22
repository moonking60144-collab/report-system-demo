import type {
  ReportColumnKey,
  ReportColumnFilterState,
  ReportColumnFilterType,
  ReportSortRule,
} from "../types/workReport";
import type {
  WorkReportFilterCondition,
  WorkReportFilterField,
  WorkReportFilterGroup,
  WorkReportFilterOperator,
} from "@shared-types/workReportFilter";
import {
  isReportColumnKey,
  REPORT_COLUMN_TYPE_BY_KEY,
} from "../types/workReport";
import { HttpError } from "../utils/httpError";
import { normalizeDateOnly } from "../utils/dateOnly";
import { env } from "../config/env";
import { createHash, timingSafeEqual } from "node:crypto";

const RAGIC_CALLBACK_ENTRY_ID_KEYS = [
  "entryId",
  "entry_id",
  "id",
  "_ragicId",
  "_ragic_id",
  "ragicId",
  "nodeId",
] as const;

const RAGIC_CALLBACK_EVENT_TYPE_KEYS = [
  "eventType",
  "event_type",
  "event",
  "action",
] as const;

const RAGIC_CALLBACK_ROW_ID_KEYS = ["rowId", "row_id"] as const;
const RAGIC_CALLBACK_SOURCE_KEYS = ["source", "path", "apname"] as const;

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `無效的數字參數：${input}`, "INVALID_QUERY_PARAM");
  }
  return parsed;
}

function parseBooleanFlag(
  input: string | undefined,
  options: { trueValues: string[]; falseValues: string[]; fieldName: string }
): boolean {
  if (!input) {
    return false;
  }

  const normalized = input.trim().toLowerCase();
  if (options.trueValues.includes(normalized)) {
    return true;
  }
  if (options.falseValues.includes(normalized)) {
    return false;
  }
  throw new HttpError(400, `無效的 ${options.fieldName} 參數：${input}`, "INVALID_QUERY_PARAM");
}

function parseTriStateFlag(
  input: string | undefined,
  fieldName: string
): "all" | "yes" | "no" {
  if (!input) {
    return "all";
  }

  const normalized = input.trim().toLowerCase();
  if (normalized === "all") {
    return "all";
  }
  if (normalized === "yes" || normalized === "true" || normalized === "1") {
    return "yes";
  }
  if (normalized === "no" || normalized === "false" || normalized === "0") {
    return "no";
  }
  throw new HttpError(400, `無效的 ${fieldName} 參數：${input}`, "INVALID_QUERY_PARAM");
}

const UPDATED_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseUpdatedDateParam(input: string | undefined, fieldName: string): string | undefined {
  const normalized = input?.trim();
  if (!normalized) {
    return undefined;
  }

  const matched = UPDATED_DATE_PATTERN.exec(normalized);
  if (matched) {
    const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = matched;
    const year = Number(rawYear);
    const month = Number(rawMonth);
    const day = Number(rawDay);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    const validCalendarDate =
      calendarDate.getUTCFullYear() === year &&
      calendarDate.getUTCMonth() === month - 1 &&
      calendarDate.getUTCDate() === day;
    const validTime =
      Number(rawHour) <= 23 && Number(rawMinute) <= 59 && Number(rawSecond) <= 59;

    if (validCalendarDate && validTime && Number.isFinite(Date.parse(normalized))) {
      return normalized;
    }
  }

  throw new HttpError(400, `無效的 ${fieldName} 參數：${input}`, "INVALID_QUERY_PARAM");
}

function parseSortRules(
  input: string | undefined
): ReportSortRule[] {
  if (!input) {
    return [];
  }

  const rules = input
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [rawKey, rawDirection] = segment.split(":").map((part) => part.trim());
      if (!rawKey || !isReportColumnKey(rawKey)) {
        throw new HttpError(400, `無效的 sort 欄位：${segment}`, "INVALID_QUERY_PARAM");
      }
      const direction = (rawDirection || "asc").toLowerCase();
      if (direction !== "asc" && direction !== "desc") {
        throw new HttpError(400, `無效的 sort 方向：${segment}`, "INVALID_QUERY_PARAM");
      }
      return {
        key: rawKey,
        direction,
      } as const;
    });

  return rules;
}

function parseColumnFilters(input: string | undefined): ReportColumnFilterState | undefined {
  if (!input) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new HttpError(400, "無效的 columnFilters JSON", "INVALID_QUERY_PARAM");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "columnFilters 必須是物件", "INVALID_QUERY_PARAM");
  }

  const result: ReportColumnFilterState = {};

  for (const [columnKey, rawRule] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isReportColumnKey(columnKey)) {
      throw new HttpError(
        400,
        `無效的 columnFilters 欄位：${columnKey}`,
        "INVALID_QUERY_PARAM"
      );
    }
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      continue;
    }

    const candidate = rawRule as Record<string, unknown>;
    const type = String(candidate.type ?? "").trim().toLowerCase() as ReportColumnFilterType;
    if (
      type !== "text" &&
      type !== "number" &&
      type !== "date" &&
      type !== "boolean"
    ) {
      throw new HttpError(
        400,
        `無效的 columnFilters.type：${columnKey}`,
        "INVALID_QUERY_PARAM"
      );
    }
    if (REPORT_COLUMN_TYPE_BY_KEY[columnKey] !== type) {
      throw new HttpError(
        400,
        `columnFilters 欄位型別不符：${columnKey}`,
        "INVALID_QUERY_PARAM"
      );
    }

    const selectedTokens = Array.isArray(candidate.selectedTokens)
      ? candidate.selectedTokens
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    const textQuery = typeof candidate.textQuery === "string" ? candidate.textQuery.trim() : "";

    if (selectedTokens.length === 0 && !textQuery) {
      continue;
    }

    result[columnKey] = {
      type,
      ...(selectedTokens.length > 0 ? { selectedTokens } : {}),
      ...(textQuery ? { textQuery } : {}),
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

const WORK_REPORT_FILTER_OPERATORS_BY_FIELD: Record<
  WorkReportFilterField,
  readonly WorkReportFilterOperator[]
> = {
  workOrderNo: ["contains", "notContains", "equals", "startsWith", "isEmpty", "isNotEmpty"],
  customerPartNo: ["contains", "notContains", "equals", "startsWith", "isEmpty", "isNotEmpty"],
  machineCode: ["isAnyOf", "isNotAnyOf", "isEmpty", "isNotEmpty"],
  status: ["isAnyOf", "isNotAnyOf", "isEmpty", "isNotEmpty"],
  siteRunning: ["isAnyOf", "isNotAnyOf", "isEmpty", "isNotEmpty"],
  startSchedule: ["isAnyOf", "isNotAnyOf", "isEmpty", "isNotEmpty"],
  lastUpdatedAt: ["before", "after", "between", "isEmpty", "isNotEmpty"],
};

const WORK_REPORT_FILTER_MAX_CONDITIONS = 12;
const WORK_REPORT_FILTER_MAX_VALUES = 30;
const WORK_REPORT_FILTER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidFilterDateOnly(value: string): boolean {
  if (!WORK_REPORT_FILTER_DATE_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseFilterGroup(input: string | undefined): WorkReportFilterGroup | undefined {
  if (!input) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new HttpError(400, "無效的 filterGroup JSON", "INVALID_QUERY_PARAM");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "filterGroup 必須是物件", "INVALID_QUERY_PARAM");
  }
  const rawGroup = parsed as Record<string, unknown>;
  if (rawGroup.joinMode !== "all" && rawGroup.joinMode !== "any") {
    throw new HttpError(400, "filterGroup.joinMode 必須是 all 或 any", "INVALID_QUERY_PARAM");
  }
  if (!Array.isArray(rawGroup.conditions)) {
    throw new HttpError(400, "filterGroup.conditions 必須是陣列", "INVALID_QUERY_PARAM");
  }
  if (rawGroup.conditions.length > WORK_REPORT_FILTER_MAX_CONDITIONS) {
    throw new HttpError(400, "filterGroup 最多 12 條條件", "INVALID_QUERY_PARAM");
  }

  const conditions = rawGroup.conditions.map((rawCondition, index): WorkReportFilterCondition => {
    if (!rawCondition || typeof rawCondition !== "object" || Array.isArray(rawCondition)) {
      throw new HttpError(400, `filterGroup.conditions[${index}] 格式錯誤`, "INVALID_QUERY_PARAM");
    }
    const raw = rawCondition as Record<string, unknown>;
    const field = String(raw.field ?? "") as WorkReportFilterField;
    const operator = String(raw.operator ?? "") as WorkReportFilterOperator;
    const allowedOperators = Object.prototype.hasOwnProperty.call(
      WORK_REPORT_FILTER_OPERATORS_BY_FIELD,
      field
    )
      ? WORK_REPORT_FILTER_OPERATORS_BY_FIELD[field]
      : undefined;
    if (!Array.isArray(allowedOperators) || !allowedOperators.includes(operator)) {
      throw new HttpError(
        400,
        `filterGroup.conditions[${index}] 欄位或運算子無效`,
        "INVALID_QUERY_PARAM"
      );
    }
    if (!Array.isArray(raw.values) || raw.values.length > WORK_REPORT_FILTER_MAX_VALUES) {
      throw new HttpError(
        400,
        `filterGroup.conditions[${index}].values 格式或數量無效`,
        "INVALID_QUERY_PARAM"
      );
    }
    const values = Array.from(
      new Set(
        raw.values
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      )
    );
    if (values.some((value) => value.length > 120)) {
      throw new HttpError(
        400,
        `filterGroup.conditions[${index}] 條件值過長`,
        "INVALID_QUERY_PARAM"
      );
    }
    const isValueless = operator === "isEmpty" || operator === "isNotEmpty";
    const requiredValueCount = operator === "between" ? 2 : 1;
    if (!isValueless && values.length < requiredValueCount) {
      throw new HttpError(
        400,
        `filterGroup.conditions[${index}] 缺少條件值`,
        "INVALID_QUERY_PARAM"
      );
    }
    if (
      field === "lastUpdatedAt" &&
      !isValueless &&
      values.slice(0, requiredValueCount).some((value) => !isValidFilterDateOnly(value))
    ) {
      throw new HttpError(
        400,
        `filterGroup.conditions[${index}] 日期格式無效`,
        "INVALID_QUERY_PARAM"
      );
    }
    if (operator === "between" && values[0] > values[1]) {
      throw new HttpError(
        400,
        `filterGroup.conditions[${index}] 日期起日不可晚於迄日`,
        "INVALID_QUERY_PARAM"
      );
    }
    if (
      (field === "siteRunning" || field === "startSchedule") &&
      !isValueless &&
      values.some((value) => value !== "yes" && value !== "no")
    ) {
      throw new HttpError(
        400,
        `filterGroup.conditions[${index}] 布林條件值無效`,
        "INVALID_QUERY_PARAM"
      );
    }
    return {
      id:
        typeof raw.id === "string" && raw.id.trim()
          ? raw.id.trim().slice(0, 80)
          : `condition-${index + 1}`,
      field,
      operator,
      values: isValueless ? [] : values,
    };
  });

  return conditions.length > 0
    ? { joinMode: rawGroup.joinMode, conditions }
    : undefined;
}

export function assertReadableFormId(formId: string): asserts formId is "901" | "902" {
  if (formId === "901" || formId === "902") {
    return;
  }
  throw new HttpError(400, `目前讀取端點僅支援 901/902，收到 ${formId}`, "FORM_NOT_SUPPORTED");
}

export function assertWritableFormId(formId: string): void {
  if (formId !== "901" && formId !== "902") {
    throw new HttpError(400, `目前寫入端點僅支援 901/902，收到 ${formId}`, "FORM_NOT_SUPPORTED");
  }
}

export function assertRequiredPathValue(value: string | undefined, fieldName: string): void {
  if (!value || !value.trim()) {
    throw new HttpError(400, `缺少必要參數：${fieldName}`, "INVALID_PAYLOAD");
  }
}

export function parseReportsQuery(query: Record<string, unknown>, formId?: "901" | "902"): {
  formId?: "901" | "902";
  limit: number;
  offset: number;
  entryId?: string;
  keyword?: string;
  workOrderKeyword?: string;
  customerPartKeyword?: string;
  prodType?: string;
  excludeTestCustomerPart: boolean;
  excludeSortOrder99: boolean;
  refresh: boolean;
  status?: string;
  ragicUnfinishedStatus?: string;
  machineCode?: string;
  filterMachineCode?: string;
  siteRunning?: "all" | "yes" | "no";
  startSchedule?: "all" | "yes" | "no";
  updatedDateFrom?: string;
  updatedDateTo?: string;
  columnFilters?: ReportColumnFilterState;
  filterGroup?: WorkReportFilterGroup;
  sortRules?: ReportSortRule[];
} {
  const updatedDateFrom = parseUpdatedDateParam(
    query.updatedDateFrom as string | undefined,
    "updatedDateFrom"
  );
  const updatedDateTo = parseUpdatedDateParam(
    query.updatedDateTo as string | undefined,
    "updatedDateTo"
  );
  if (
    updatedDateFrom &&
    updatedDateTo &&
    Date.parse(updatedDateFrom) > Date.parse(updatedDateTo)
  ) {
    throw new HttpError(
      400,
      "updatedDateFrom 不得晚於 updatedDateTo",
      "INVALID_QUERY_PARAM"
    );
  }

  return {
    formId,
    limit: parsePositiveInt(query.limit as string | undefined, 50),
    offset: parsePositiveInt(query.offset as string | undefined, 0),
    entryId: (query.entryId as string | undefined)?.trim() || undefined,
    keyword: (query.keyword as string | undefined)?.trim() || undefined,
    workOrderKeyword: (query.workOrderKeyword as string | undefined)?.trim() || undefined,
    customerPartKeyword:
      (query.customerPartKeyword as string | undefined)?.trim() || undefined,
    prodType: (query.prodType as string | undefined)?.trim() || undefined,
    excludeTestCustomerPart: parseBooleanFlag(
      query.excludeTestCustomerPart as string | undefined,
      {
        trueValues: ["1", "true"],
        falseValues: ["0", "false"],
        fieldName: "excludeTestCustomerPart",
      }
    ),
    excludeSortOrder99: parseBooleanFlag(
      query.excludeSortOrder99 as string | undefined,
      {
        trueValues: ["1", "true"],
        falseValues: ["0", "false"],
        fieldName: "excludeSortOrder99",
      }
    ),
    status: (query.status as string | undefined)?.trim() || undefined,
    ragicUnfinishedStatus:
      (query.ragicUnfinishedStatus as string | undefined)?.trim() || undefined,
    machineCode: (query.machineCode as string | undefined)?.trim() || undefined,
    filterMachineCode: (query.filterMachineCode as string | undefined)?.trim() || undefined,
    siteRunning: parseTriStateFlag(query.siteRunning as string | undefined, "siteRunning"),
    startSchedule: parseTriStateFlag(query.startSchedule as string | undefined, "startSchedule"),
    updatedDateFrom,
    updatedDateTo,
    columnFilters: parseColumnFilters(query.columnFilters as string | undefined),
    filterGroup: parseFilterGroup(query.filterGroup as string | undefined),
    sortRules: parseSortRules(query.sort as string | undefined),
    refresh: parseBooleanFlag(query.refresh as string | undefined, {
      trueValues: ["1", "true"],
      falseValues: ["0", "false"],
      fieldName: "refresh",
    }),
  };
}

export function parseRefreshFlag(query: Record<string, unknown>): boolean {
  return parseBooleanFlag(query.refresh as string | undefined, {
    trueValues: ["1", "true"],
    falseValues: ["0", "false"],
    fieldName: "refresh",
  });
}

export function parseStrictRefreshFlag(query: Record<string, unknown>): boolean {
  return parseBooleanFlag(query.strictRefresh as string | undefined, {
    trueValues: ["1", "true"],
    falseValues: ["0", "false"],
    fieldName: "strictRefresh",
  });
}

export function parseAsyncFlag(query: Record<string, unknown>): boolean {
  return parseBooleanFlag(query.async as string | undefined, {
    trueValues: ["1", "true", "yes"],
    falseValues: ["0", "false", "no"],
    fieldName: "async",
  });
}

export function parseRawLimit(query: Record<string, unknown>): number {
  return parsePositiveInt(query.limit as string | undefined, 1);
}

export function parseRequestedFields(query: Record<string, unknown>): string[] | undefined {
  if (typeof query.fields !== "string") {
    return undefined;
  }

  return query.fields
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
}

export type RagicCallbackEventType =
  | "entry-created"
  | "entry-updated"
  | "entry-deleted"
  | "row-created"
  | "row-updated"
  | "row-deleted";

export interface RagicCallbackPayload {
  entryId: string;
  eventType: RagicCallbackEventType;
  rowId?: string;
  source?: string;
}

export function parseMainMachineUpdatePayload(body: unknown): { machineCode: string; expectedMachineCode?: string | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "payload 必須是物件", "INVALID_PAYLOAD");
  }

  const machineCode = String((body as Record<string, unknown>).machineCode ?? "").trim();
  if (!machineCode) {
    throw new HttpError(400, "缺少必要欄位：machineCode", "INVALID_PAYLOAD");
  }

  const expectedMachineCode = (body as Record<string, unknown>).expectedMachineCode;
  if (expectedMachineCode !== undefined && (expectedMachineCode !== null && (typeof expectedMachineCode !== "string" || !expectedMachineCode.trim()))) {
    throw new HttpError(400, "expectedMachineCode 必須是機台代碼或 null", "INVALID_PAYLOAD");
  }
  return { machineCode, ...(expectedMachineCode !== undefined ? { expectedMachineCode: typeof expectedMachineCode === "string" ? expectedMachineCode.trim() : null } : {}) };
}

export function parseSortOrderUpdatePayload(body: unknown): { sortOrder: number; expectedSortOrder?: number | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "payload 必須是物件", "INVALID_PAYLOAD");
  }

  const rawSortOrder = (body as Record<string, unknown>).sortOrder;
  const sortOrder = rawSortOrder;
  if (
    typeof sortOrder !== "number" ||
    !Number.isInteger(sortOrder) ||
    sortOrder < 0
  ) {
    throw new HttpError(
      400,
      "sortOrder 必須是大於或等於 0 的整數",
      "INVALID_PAYLOAD"
    );
  }

  const expectedSortOrder = (body as Record<string, unknown>).expectedSortOrder;
  if (expectedSortOrder !== undefined && expectedSortOrder !== null &&
    (typeof expectedSortOrder !== "number" || !Number.isInteger(expectedSortOrder) || expectedSortOrder < 0)) {
    throw new HttpError(400, "expectedSortOrder 必須是非負整數或 null", "INVALID_PAYLOAD");
  }
  return { sortOrder, ...(expectedSortOrder !== undefined ? { expectedSortOrder: expectedSortOrder as number | null } : {}) };
}

export function parsePlannedEndDateUpdatePayload(body: unknown): { plannedEndDate: string; expectedPlannedEndDate?: string | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "payload 必須是物件", "INVALID_PAYLOAD");
  }

  const rawValue = (body as Record<string, unknown>).plannedEndDate;
  const plannedEndDate = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedEndDate) || normalizeDateOnly(plannedEndDate) !== plannedEndDate) {
    throw new HttpError(
      400,
      "plannedEndDate 格式錯誤，需為有效的 YYYY-MM-DD 日期",
      "INVALID_PAYLOAD"
    );
  }

  const expectedPlannedEndDate = (body as Record<string, unknown>).expectedPlannedEndDate;
  if (expectedPlannedEndDate !== undefined && (expectedPlannedEndDate !== null && (typeof expectedPlannedEndDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expectedPlannedEndDate) || normalizeDateOnly(expectedPlannedEndDate) !== expectedPlannedEndDate))) {
    throw new HttpError(400, "expectedPlannedEndDate 必須是有效的 YYYY-MM-DD 日期或 null", "INVALID_PAYLOAD");
  }
  return { plannedEndDate, ...(expectedPlannedEndDate !== undefined ? { expectedPlannedEndDate: expectedPlannedEndDate as string | null } : {}) };
}

export function parseUrgentUpdatePayload(body: unknown): { urgent: boolean; expectedUrgent?: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "payload 必須是物件", "INVALID_PAYLOAD");
  }

  const urgent = (body as Record<string, unknown>).urgent;
  if (typeof urgent !== "boolean") {
    throw new HttpError(400, "urgent 必須是 boolean", "INVALID_PAYLOAD");
  }

  const expectedUrgent = (body as Record<string, unknown>).expectedUrgent;
  if (expectedUrgent !== undefined && (typeof expectedUrgent !== "boolean")) {
    throw new HttpError(400, "expectedUrgent 必須是 boolean", "INVALID_PAYLOAD");
  }
  return { urgent, ...(expectedUrgent !== undefined ? { expectedUrgent: expectedUrgent as boolean } : {}) };
}

export function parseStartScheduleUpdatePayload(body: unknown): { startSchedule: boolean; expectedStartSchedule?: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "payload 必須是物件", "INVALID_PAYLOAD");
  }

  const startSchedule = (body as Record<string, unknown>).startSchedule;
  if (typeof startSchedule !== "boolean") {
    throw new HttpError(400, "startSchedule 必須是 boolean", "INVALID_PAYLOAD");
  }

  const expectedStartSchedule = (body as Record<string, unknown>).expectedStartSchedule;
  if (expectedStartSchedule !== undefined && (typeof expectedStartSchedule !== "boolean")) {
    throw new HttpError(400, "expectedStartSchedule 必須是 boolean", "INVALID_PAYLOAD");
  }
  return { startSchedule, ...(expectedStartSchedule !== undefined ? { expectedStartSchedule: expectedStartSchedule as boolean } : {}) };
}

export function parseExpectedEntryLastUpdatedAt(headerValue: string | undefined): string | undefined {
  const normalized = String(headerValue ?? "").trim();
  return normalized || undefined;
}

export function parseEditSessionId(headerValue: string | undefined): string | undefined {
  const normalized = String(headerValue ?? "").trim();
  return normalized || undefined;
}

export function parseEditLockVersion(headerValue: string | undefined): number | undefined {
  const normalized = String(headerValue ?? "").trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, `無效的編輯鎖版本：${headerValue}`, "INVALID_PAYLOAD");
  }
  return parsed;
}

export function parseEditingPresencePayload(
  body: unknown
): { sessionId: string; active: boolean; state?: string; rowId?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "presence payload 必須是物件", "INVALID_PAYLOAD");
  }

  const payload = body as Record<string, unknown>;
  const sessionId = String(payload.sessionId ?? "").trim();
  if (!sessionId) {
    throw new HttpError(400, "缺少必要欄位：sessionId", "INVALID_PAYLOAD");
  }

  const active = Boolean(payload.active);
  const state = String(payload.state ?? "").trim();
  const rowId = String(payload.rowId ?? "").trim();
  return {
    sessionId,
    active,
    ...(state ? { state } : {}),
    ...(rowId ? { rowId } : {}),
  };
}

function assertRagicCallbackTokenValue(receivedToken: string | undefined): void {
  const expected = String(process.env.RAGIC_CALLBACK_TOKEN ?? env.RAGIC_CALLBACK_TOKEN ?? "").trim();
  if (!expected) {
    throw new HttpError(503, "尚未設定 Ragic callback token", "CALLBACK_TOKEN_NOT_CONFIGURED");
  }
  const received = String(receivedToken ?? "").trim();
  if (!received || !isTimingSafeTokenMatch(received, expected)) {
    throw new HttpError(403, "Ragic callback token 驗證失敗", "CALLBACK_TOKEN_INVALID");
  }
}

export function assertRagicCallbackToken(reqToken: string | undefined): void {
  assertRagicCallbackTokenValue(reqToken);
}

function isTimingSafeTokenMatch(received: string, expected: string): boolean {
  const receivedDigest = createHash("sha256").update(received, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

function pickFirstCallbackValue(
  payload: Record<string, unknown>,
  keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      return payload[key];
    }
  }
  return undefined;
}

function pickFirstNonEmptyText(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = pickFirstNonEmptyText(item);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }
  if (typeof value === "object") {
    const payload = value as Record<string, unknown>;
    return (
      pickFirstNonEmptyText(payload.value) ??
      pickFirstNonEmptyText(payload._value) ??
      pickFirstNonEmptyText(payload.label) ??
      pickFirstNonEmptyText(payload._label) ??
      pickFirstNonEmptyText(payload.id) ??
      pickFirstNonEmptyText(payload.entryId) ??
      pickFirstNonEmptyText(payload.entry_id) ??
      pickFirstNonEmptyText(payload._ragicId) ??
      pickFirstNonEmptyText(payload._ragic_id)
    );
  }
  return undefined;
}

function normalizeRagicCallbackEventType(rawValue: unknown): RagicCallbackEventType | undefined {
  const normalized = pickFirstNonEmptyText(rawValue)?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (
    normalized === "entry-created" ||
    normalized === "entry_create" ||
    normalized === "entry-create"
  ) {
    return "entry-created";
  }
  if (
    normalized === "entry-updated" ||
    normalized === "entry_update" ||
    normalized === "entry-update"
  ) {
    return "entry-updated";
  }
  if (
    normalized === "entry-deleted" ||
    normalized === "entry_delete" ||
    normalized === "entry-delete"
  ) {
    return "entry-deleted";
  }
  if (
    normalized === "row-created" ||
    normalized === "row_create" ||
    normalized === "row-create"
  ) {
    return "row-created";
  }
  if (
    normalized === "row-updated" ||
    normalized === "row_update" ||
    normalized === "row-update"
  ) {
    return "row-updated";
  }
  if (
    normalized === "row-deleted" ||
    normalized === "row_delete" ||
    normalized === "row-delete"
  ) {
    return "row-deleted";
  }

  if (normalized.includes("row")) {
    if (
      normalized.includes("create") ||
      normalized.includes("created") ||
      normalized.includes("new")
    ) {
      return "row-created";
    }
    if (
      normalized.includes("delete") ||
      normalized.includes("deleted") ||
      normalized.includes("remove") ||
      normalized.includes("removed")
    ) {
      return "row-deleted";
    }
    if (
      normalized.includes("update") ||
      normalized.includes("updated") ||
      normalized.includes("edit") ||
      normalized.includes("edited") ||
      normalized.includes("modify") ||
      normalized.includes("modified")
    ) {
      return "row-updated";
    }
  }

  if (
    normalized === "create" ||
    normalized === "created" ||
    normalized === "new" ||
    normalized === "insert" ||
    normalized === "inserted"
  ) {
    return "entry-created";
  }
  if (
    normalized === "update" ||
    normalized === "updated" ||
    normalized === "edit" ||
    normalized === "edited" ||
    normalized === "modify" ||
    normalized === "modified"
  ) {
    return "entry-updated";
  }
  if (
    normalized === "delete" ||
    normalized === "deleted" ||
    normalized === "remove" ||
    normalized === "removed"
  ) {
    return "entry-deleted";
  }

  return undefined;
}

function toRagicCallbackPayload(
  value: unknown,
  options?: {
    defaultEventType?: RagicCallbackEventType;
    defaultSource?: string;
  }
): RagicCallbackPayload | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const entryId = pickFirstNonEmptyText(value);
    if (!entryId) {
      return null;
    }
    return {
      entryId,
      eventType: options?.defaultEventType ?? "entry-updated",
      ...(options?.defaultSource ? { source: options.defaultSource } : {}),
    };
  }

  if (Array.isArray(value)) {
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const entryId = pickFirstNonEmptyText(
    pickFirstCallbackValue(payload, RAGIC_CALLBACK_ENTRY_ID_KEYS)
  );
  if (!entryId) {
    return null;
  }

  const eventType =
    normalizeRagicCallbackEventType(
      pickFirstCallbackValue(payload, RAGIC_CALLBACK_EVENT_TYPE_KEYS)
    ) ??
    options?.defaultEventType ??
    "entry-updated";
  const rowId = pickFirstNonEmptyText(pickFirstCallbackValue(payload, RAGIC_CALLBACK_ROW_ID_KEYS));
  const source =
    pickFirstNonEmptyText(pickFirstCallbackValue(payload, RAGIC_CALLBACK_SOURCE_KEYS)) ??
    options?.defaultSource;

  return {
    entryId,
    eventType,
    ...(rowId ? { rowId } : {}),
    ...(source ? { source } : {}),
  };
}

export function parseRagicCallbackPayload(body: unknown): RagicCallbackPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "callback payload 必須是物件", "INVALID_PAYLOAD");
  }

  const payload = body as Record<string, unknown>;
  const entryId = String(payload.entryId ?? "").trim();
  if (!entryId) {
    throw new HttpError(400, "缺少必要參數：entryId", "INVALID_PAYLOAD");
  }

  const eventType = String(payload.eventType ?? "").trim() as RagicCallbackEventType;
  if (
    eventType !== "entry-created" &&
    eventType !== "entry-updated" &&
    eventType !== "entry-deleted" &&
    eventType !== "row-created" &&
    eventType !== "row-updated" &&
    eventType !== "row-deleted"
  ) {
    throw new HttpError(400, "無效的 eventType", "INVALID_PAYLOAD");
  }

  const rowId = String(payload.rowId ?? "").trim();
  const source = String(payload.source ?? "").trim();
  return {
    entryId,
    eventType,
    ...(rowId ? { rowId } : {}),
    ...(source ? { source } : {}),
  };
}

export function parseAnalysisQuery(query: Record<string, unknown>): {
  field: ReportColumnKey;
  columnType: "text" | "number" | "date" | "boolean";
} {
  const field = String(query.field ?? "").trim();
  if (!field) {
    throw new HttpError(400, "缺少必要參數：field", "INVALID_QUERY_PARAM");
  }
  if (!isReportColumnKey(field)) {
    throw new HttpError(400, `無效的 analysis 欄位：${field}`, "INVALID_QUERY_PARAM");
  }

  const columnType = String(query.columnType ?? "text").trim().toLowerCase();
  if (
    columnType !== "text" &&
    columnType !== "number" &&
    columnType !== "date" &&
    columnType !== "boolean"
  ) {
    throw new HttpError(400, `無效的 columnType 參數：${columnType}`, "INVALID_QUERY_PARAM");
  }
  if (REPORT_COLUMN_TYPE_BY_KEY[field] !== columnType) {
    throw new HttpError(
      400,
      `analysis 欄位型別不符：${field}`,
      "INVALID_QUERY_PARAM"
    );
  }

  return {
    field,
    columnType,
  };
}
