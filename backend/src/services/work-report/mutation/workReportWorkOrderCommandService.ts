import {
  env,
  resolveWorkReportDataPath,
  resolveWritePath,
} from "../../../config/env";
import { getFormConfig } from "../../../config/forms";
import { createLogger } from "../../../observability/logger";
import {
  ragicClient,
  type RagicReadRequestOptions,
  type RagicRecord,
  type RagicWriteRequestOptions,
} from "../../../ragic/client";
import type { RagicRequestAttemptTiming } from "../../../infra/ragicRequestScheduler";
import { HttpError, UpstreamError } from "../../../utils/httpError";
import { normalizeDateOnly, toRagicDateOnly } from "../../../utils/dateOnly";
import { parseSemanticBoolean } from "../../../utils/semanticBoolean";
import { normalizeMappedFieldValue, resolveCandidateFieldKeys } from "../queries/rowTransform";
import { getFirstFieldValue } from "../shared/subtableUtils";
import { buildMutationCommandReadOptions } from "../shared/refreshEntryOptions";
import { isWorkOrderClosedEntry } from "../shared/workOrderStatus";
import { writeToRagic } from "../shared/workReportWriteHelpers";
import { assertFieldOrEntryPrecondition, resolveFieldMutationPrecondition } from "../shared/fieldMutationPrecondition";
import { workReportMutationCacheService } from "./workReportMutationCacheService";

const PLANNED_QUANTITY_INPUT_FIELD = {
  fieldId: "9001054",
  names: ["預計產數量輸入", "待生產數量輸入"],
} as const;
const log = createLogger("work-report-work-order-command");

export interface WorkReportCommandLogger {
  info(payload: Record<string, unknown>): void;
  error(payload: Record<string, unknown>): void;
}

export interface WorkOrderCommandOptions {
  expectedSortOrder?: number | null;
  expectedMachineCode?: string | null;
  expectedPlannedEndDate?: string | null;
  expectedUrgent?: boolean;
  expectedStartSchedule?: boolean;
  expectedEntryLastUpdatedAt?: string;
  editSessionId?: string;
  editLockVersion?: number;
  onTiming?: (timing: WorkReportCommandTimingResult) => void;
  onConfirmedEntry?: (observation: WorkReportCommandEntryObservation) => void;
}

export interface WorkReportCommandEntryObservation {
  entryId: string;
  observedAt: string;
  entryLastUpdatedAt: string | null;
  rawEntry: RagicRecord;
}

export interface WorkReportCommandTimingResult {
  writeStartedAt: string | null;
  mutationTimings: {
    currentReadMs: number;
    currentReadLaneWaitMs: number;
    currentReadUpstreamMs: number;
    currentReadAttempts: number;
    writeMs: number;
    writeLaneWaitMs: number;
    writeUpstreamMs: number;
    writeAttempts: number;
    verifyMs: number;
    verifyLaneWaitMs: number;
    verifyUpstreamMs: number;
    verifyAttempts: number;
  };
}

function assertWorkOrderOpen(
  currentEntry: RagicRecord,
  config: ReturnType<typeof getFormConfig>,
  actionLabel: string
): void {
  if (!isWorkOrderClosedEntry(currentEntry, config)) {
    return;
  }
  throw new HttpError(
    409,
    `這筆工令已結案，不能修改${actionLabel}；請重新整理確認狀態。`,
    "ENTRY_CLOSED"
  );
}

type CommandTimingPhase = "current" | "write" | "verify";

function createCommandTimingTracker(options: WorkOrderCommandOptions): {
  run<T>(phase: CommandTimingPhase, worker: () => Promise<T>): Promise<T>;
  readOptions(phase: "current" | "verify"): RagicReadRequestOptions;
  writeRequestOptions(): RagicWriteRequestOptions;
  markWriteStarted(): number;
  snapshot(): WorkReportCommandTimingResult;
} {
  let writeStartedAt: number | null = null;
  const mutationTimings: WorkReportCommandTimingResult["mutationTimings"] = {
    currentReadMs: 0,
    currentReadLaneWaitMs: 0,
    currentReadUpstreamMs: 0,
    currentReadAttempts: 0,
    writeMs: 0,
    writeLaneWaitMs: 0,
    writeUpstreamMs: 0,
    writeAttempts: 0,
    verifyMs: 0,
    verifyLaneWaitMs: 0,
    verifyUpstreamMs: 0,
    verifyAttempts: 0,
  };
  const readDeadlineAt: Partial<Record<"current" | "verify", number>> = {};
  const snapshot = (): WorkReportCommandTimingResult => ({
    writeStartedAt:
      writeStartedAt === null ? null : new Date(writeStartedAt).toISOString(),
    mutationTimings: { ...mutationTimings },
  });
  const publish = () => {
    options.onTiming?.(snapshot());
  };
  const captureAttempt = (
    phase: CommandTimingPhase,
    timing: RagicRequestAttemptTiming
  ) => {
    const prefix = phase === "current" ? "currentRead" : phase;
    const laneWaitKey = `${prefix}LaneWaitMs` as
      | "currentReadLaneWaitMs"
      | "writeLaneWaitMs"
      | "verifyLaneWaitMs";
    const upstreamKey = `${prefix}UpstreamMs` as
      | "currentReadUpstreamMs"
      | "writeUpstreamMs"
      | "verifyUpstreamMs";
    const attemptsKey = `${prefix}Attempts` as
      | "currentReadAttempts"
      | "writeAttempts"
      | "verifyAttempts";
    mutationTimings[laneWaitKey] += timing.laneWaitMs;
    mutationTimings[upstreamKey] += timing.upstreamMs;
    mutationTimings[attemptsKey] += 1;
    publish();
  };
  publish();
  return {
    async run<T>(phase: CommandTimingPhase, worker: () => Promise<T>) {
      const startedAt = Date.now();
      try {
        return await worker();
      } finally {
        const durationMs = Math.max(0, Date.now() - startedAt);
        if (phase === "current") mutationTimings.currentReadMs += durationMs;
        else if (phase === "write") mutationTimings.writeMs += durationMs;
        else mutationTimings.verifyMs += durationMs;
        publish();
      }
    },
    readOptions: (phase) => {
      const baseOptions = buildMutationCommandReadOptions(phase);
      const now = Date.now();
      const deadlineAt =
        readDeadlineAt[phase] ?? now + baseOptions.totalBudgetMs;
      readDeadlineAt[phase] = deadlineAt;
      const remainingBudgetMs = Math.max(1, deadlineAt - now);
      return {
        ...baseOptions,
        timeoutMs: Math.min(baseOptions.timeoutMs, remainingBudgetMs),
        totalBudgetMs: remainingBudgetMs,
        includeSubtables: phase === "verify",
        onAttemptTiming: (timing: RagicRequestAttemptTiming) =>
          captureAttempt(phase, timing),
      };
    },
    writeRequestOptions: () => ({
      onAttemptTiming: (timing) => captureAttempt("write", timing),
    }),
    markWriteStarted: () => {
      writeStartedAt = Date.now();
      publish();
      return writeStartedAt;
    },
    snapshot,
  };
}

async function readFullEntryForNoopObservation(input: {
  writePath: string;
  entryId: string;
  readOptions: RagicReadRequestOptions;
  isStillNoop: (entry: RagicRecord) => boolean;
}): Promise<RagicRecord> {
  const entry = await ragicClient.getEntry(
    input.writePath,
    input.entryId,
    false,
    { ...input.readOptions, includeSubtables: true }
  );
  if (!entry) {
    throw new HttpError(404, `找不到工令：${input.entryId}`, "REPORT_NOT_FOUND");
  }
  if (!input.isStillNoop(entry)) {
    throw new HttpError(
      409,
      "這筆工令在確認更新結果時又被修改，請重新整理後再試。",
      "ENTRY_CONFLICT"
    );
  }
  return entry;
}

function publishConfirmedEntry(
  options: WorkOrderCommandOptions,
  entryId: string,
  rawEntry: RagicRecord,
  config: ReturnType<typeof getFormConfig>
): void {
  const entryLastUpdatedAt = String(
    getFirstFieldValue(
      rawEntry,
      resolveCandidateFieldKeys(
        config.mainFields.lastUpdatedAt ?? "",
        config.mainFieldFallbacks?.lastUpdatedAt
      )
    ) ?? ""
  ).trim();
  options.onConfirmedEntry?.({
    entryId,
    observedAt: new Date().toISOString(),
    entryLastUpdatedAt: entryLastUpdatedAt || null,
    rawEntry,
  });
}

async function readConfirmedEntryAfterWrite(input: {
  formId: string;
  entryId: string;
  writePath: string;
  label: string;
  readOptions: RagicReadRequestOptions;
}): Promise<RagicRecord | null> {
  try {
    return await ragicClient.getEntry(
      input.writePath,
      input.entryId,
      false,
      input.readOptions
    );
  } catch (error) {
    const causeCode =
      typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code?: unknown }).code)
        : null;
    throw new UpstreamError(
      `Ragic 已回應${input.label}更新，但驗證回讀失敗；請重新整理確認。`,
      "RAGIC_WRITE_VERIFY_FAILED",
      {
        formId: input.formId,
        entryId: input.entryId,
        causeCode,
        causeMessage: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

interface RagicWriteFailureDetail {
  httpStatus: number | null;
  ragicStatus: string | null;
  ragicCode: number | string | null;
  message: string;
}

function parseRagicCheckbox(value: unknown): boolean | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return false;
  }
  return parseSemanticBoolean(value);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveRagicWriteFailure(error: unknown): RagicWriteFailureDetail | null {
  if (!(error instanceof UpstreamError) || error.code !== "RAGIC_WRITE_FAILED") {
    return null;
  }
  const detail = readRecord(error.upstreamDetail);
  return {
    httpStatus: typeof detail?.status === "number" ? detail.status : null,
    ragicStatus:
      typeof detail?.ragicStatus === "string" ? detail.ragicStatus : null,
    ragicCode:
      typeof detail?.ragicCode === "number" || typeof detail?.ragicCode === "string"
        ? detail.ragicCode
        : null,
    message:
      typeof detail?.message === "string" && detail.message.trim()
        ? detail.message.trim()
        : error.message,
  };
}

function parseRagicEmptyRequiredField(message: string): string | null {
  const match = message.match(/^Field\s+(.+?)\s+contains empty value$/i);
  return match?.[1]?.trim() || null;
}

function inspectRequiredField(
  entry: RagicRecord,
  requiredFieldName: string | null
): {
  fieldId: string | null;
  fieldName: string | null;
  matchedKey: string | null;
  valueState: "missing" | "null" | "blank" | "present" | "unknown";
  observedValue: unknown;
} {
  if (
    !requiredFieldName ||
    !PLANNED_QUANTITY_INPUT_FIELD.names.includes(
      requiredFieldName as (typeof PLANNED_QUANTITY_INPUT_FIELD.names)[number]
    )
  ) {
    return {
      fieldId: null,
      fieldName: requiredFieldName,
      matchedKey: null,
      valueState: "unknown",
      observedValue: null,
    };
  }

  const candidates = [
    PLANNED_QUANTITY_INPUT_FIELD.fieldId,
    ...PLANNED_QUANTITY_INPUT_FIELD.names,
  ];
  for (const key of candidates) {
    if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
    const value = entry[key];
    return {
      fieldId: PLANNED_QUANTITY_INPUT_FIELD.fieldId,
      fieldName: requiredFieldName,
      matchedKey: key,
      valueState:
        value === null || value === undefined
          ? "null"
          : String(value).trim() === ""
            ? "blank"
            : "present",
      observedValue: value ?? null,
    };
  }

  return {
    fieldId: PLANNED_QUANTITY_INPUT_FIELD.fieldId,
    fieldName: requiredFieldName,
    matchedKey: null,
    valueState: "missing",
    observedValue: null,
  };
}

function parseStoredSortOrder(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class WorkReportWorkOrderCommandService {
  constructor(private readonly commandLog: WorkReportCommandLogger = log) {}

  async updateMainMachine(
    formId: string,
    entryId: string,
    machineCode: string,
    options: WorkOrderCommandOptions = {}
  ): Promise<{
    machineCode: string;
    previousMachineCode: string | null;
    changed: boolean;
  }> {
    const totalStartedAt = Date.now();
    const timing = createCommandTimingTracker(options);
    const config = getFormConfig(formId);
    const machineFieldId = config.writeConfig.mainWriteFields?.machineCode?.trim() ?? "";
    if (!machineFieldId) {
      throw new HttpError(503, "主表機台欄位尚未設定", "FORM_NOT_CONFIGURED");
    }

    const normalizedMachineCode = machineCode.trim();
    if (!normalizedMachineCode) {
      throw new HttpError(400, "缺少必要欄位：machineCode", "INVALID_PAYLOAD");
    }

    const writePath = resolveWritePath(formId, config.ragicPath);
    if (!writePath) {
      throw new HttpError(
        503,
        "寫入路徑未設定（請確認 RAGIC_WRITE_TARGET 與 TEST_PATH）",
        "FORM_NOT_CONFIGURED"
      );
    }
    const fieldCandidates = Array.from(
      new Set([
        machineFieldId,
        ...resolveCandidateFieldKeys(
          config.filterFields?.machineCode ?? config.mainFields.machineCode ?? "",
          config.filterFields?.machineCode
            ? config.filterFieldFallbacks?.machineCode
            : config.mainFieldFallbacks?.machineCode
        ),
      ])
    ).filter(Boolean);
    const currentEntry = await timing.run("current", () =>
      ragicClient.getEntry(
        writePath,
        entryId,
        false,
        timing.readOptions("current")
      )
    );
    if (!currentEntry) {
      throw new HttpError(404, `找不到工令：${entryId}`, "REPORT_NOT_FOUND");
    }
    const expectedLastUpdatedAt = String(options.expectedEntryLastUpdatedAt ?? "").trim();
    const currentLastUpdatedAt = String(
      getFirstFieldValue(
        currentEntry,
        resolveCandidateFieldKeys(
          config.mainFields.lastUpdatedAt ?? "",
          config.mainFieldFallbacks?.lastUpdatedAt
        )
      ) ?? ""
    ).trim();
    assertWorkOrderOpen(currentEntry, config, "本站機台");
    const previousMachineText = String(
      normalizeMappedFieldValue("machineCode", getFirstFieldValue(currentEntry, fieldCandidates)) ?? ""
    ).trim();
    assertFieldOrEntryPrecondition({
      current: previousMachineText || null, expected: options.expectedMachineCode, intended: normalizedMachineCode,
      label: "本站機台", expectedEntryLastUpdatedAt: expectedLastUpdatedAt,
      currentEntryLastUpdatedAt: currentLastUpdatedAt,
    });
    if (previousMachineText === normalizedMachineCode) {
      const confirmedCurrentEntry = await timing.run("current", () =>
        readFullEntryForNoopObservation({
          writePath,
          entryId,
          readOptions: timing.readOptions("current"),
          isStillNoop: (entry) =>
            String(normalizeMappedFieldValue("machineCode", getFirstFieldValue(entry, fieldCandidates)) ?? "").trim() ===
            normalizedMachineCode,
        })
      );
      publishConfirmedEntry(options, entryId, confirmedCurrentEntry, config);
      const commandTiming = timing.snapshot();
      this.commandLog.info({
        event: "main-machine.timing",
        formId,
        entryId,
        changed: false,
        ...commandTiming.mutationTimings,
        totalMs: Date.now() - totalStartedAt,
      });
      return {
        machineCode: normalizedMachineCode,
        previousMachineCode: previousMachineText || null,
        changed: false,
      };
    }

    timing.markWriteStarted();
    await timing.run("write", () =>
      writeToRagic(
        formId,
        config,
        entryId,
        { [machineFieldId]: normalizedMachineCode },
        true,
        "PATCH",
        {
          doFormula: true,
          doLinkLoad: "all",
        },
        timing.writeRequestOptions()
      )
    );

    workReportMutationCacheService.markReportFullCacheDirty(formId);
    const confirmedEntry = await timing.run("verify", () =>
      readConfirmedEntryAfterWrite({
        formId,
        entryId,
        writePath,
        label: "本站機台",
        readOptions: timing.readOptions("verify"),
      })
    );
    if (!confirmedEntry) {
      throw new UpstreamError(
        "Ragic 已回應本站機台更新，但無法回讀工令；請重新整理確認。",
        "RAGIC_WRITE_VERIFY_FAILED",
        { formId, entryId, expectedMachineCode: normalizedMachineCode }
      );
    }
    const confirmedMachineCode = String(
      normalizeMappedFieldValue("machineCode", getFirstFieldValue(confirmedEntry, fieldCandidates)) ?? ""
    ).trim();
    if (confirmedMachineCode !== normalizedMachineCode) {
      throw new UpstreamError(
        "Ragic 已回應本站機台更新，但回讀值不一致；請重新整理確認。",
        "RAGIC_WRITE_VERIFY_FAILED",
        {
          formId,
          entryId,
          expectedMachineCode: normalizedMachineCode,
          confirmedMachineCode,
        }
      );
    }
    publishConfirmedEntry(options, entryId, confirmedEntry, config);
    const commandTiming = timing.snapshot();
    this.commandLog.info({
      event: "main-machine.timing",
      formId,
      entryId,
      changed: true,
      ...commandTiming.mutationTimings,
      totalMs: Date.now() - totalStartedAt,
    });
    return {
      machineCode: normalizedMachineCode,
      previousMachineCode: previousMachineText || null,
      changed: true,
    };
  }

  async updateSortOrder(
    formId: string,
    entryId: string,
    sortOrder: number,
    options: WorkOrderCommandOptions = {}
  ): Promise<{
    sortOrder: number;
    previousSortOrder: number | null;
    changed: boolean;
  }> {
    const totalStartedAt = Date.now();
    const timing = createCommandTimingTracker(options);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      throw new HttpError(
        400,
        "sortOrder 必須是大於或等於 0 的整數",
        "INVALID_PAYLOAD"
      );
    }

    const config = getFormConfig(formId);
    const sortOrderFieldId = config.writeConfig.mainWriteFields?.sortOrder?.trim() ?? "";
    if (!sortOrderFieldId) {
      throw new HttpError(503, "主表排序欄位尚未設定", "FORM_NOT_CONFIGURED");
    }

    const writePath = resolveWritePath(formId, config.ragicPath);
    if (!writePath) {
      throw new HttpError(
        503,
        "寫入路徑未設定（請確認 RAGIC_WRITE_TARGET 與 TEST_PATH）",
        "FORM_NOT_CONFIGURED"
      );
    }

    const fieldCandidates = Array.from(
      new Set([
        sortOrderFieldId,
        ...resolveCandidateFieldKeys(
          config.mainFields.sortOrder ?? "",
          config.mainFieldFallbacks?.sortOrder
        ),
      ])
    ).filter(Boolean);
    const lastUpdatedAtFieldCandidates = resolveCandidateFieldKeys(
      config.mainFields.lastUpdatedAt ?? "",
      config.mainFieldFallbacks?.lastUpdatedAt
    );
    const expectedLastUpdatedAt = String(
      options.expectedEntryLastUpdatedAt ?? ""
    ).trim();
    const currentEntry = await timing.run("current", () =>
      ragicClient.getEntry(
        writePath,
        entryId,
        false,
        timing.readOptions("current")
      )
    );
    if (!currentEntry) {
      throw new HttpError(404, `找不到工令：${entryId}`, "REPORT_NOT_FOUND");
    }
    assertWorkOrderOpen(currentEntry, config, "排序");
    const previousSortOrder = parseStoredSortOrder(
      getFirstFieldValue(currentEntry, fieldCandidates)
    );
    const currentLastUpdatedAt = String(
      getFirstFieldValue(currentEntry, lastUpdatedAtFieldCandidates) ?? ""
    ).trim();
    if (options.expectedSortOrder !== undefined) {
      resolveFieldMutationPrecondition({
        current: previousSortOrder,
        expected: options.expectedSortOrder,
        intended: sortOrder,
        label: "排序",
      });
    } else if (
      previousSortOrder !== sortOrder &&
      (!expectedLastUpdatedAt || currentLastUpdatedAt !== expectedLastUpdatedAt)
    ) {
      throw new HttpError(409, "排序資料版本已變更或缺少修改前的值，請重新整理後再試。", "ENTRY_FIELD_CONFLICT");
    }
    if (previousSortOrder === sortOrder) {
      const confirmedCurrentEntry = await timing.run("current", () =>
        readFullEntryForNoopObservation({
          writePath,
          entryId,
          readOptions: timing.readOptions("current"),
          isStillNoop: (entry) =>
            parseStoredSortOrder(getFirstFieldValue(entry, fieldCandidates)) ===
            sortOrder,
        })
      );
      publishConfirmedEntry(options, entryId, confirmedCurrentEntry, config);
      const commandTiming = timing.snapshot();
      this.commandLog.info({
        event: "sort-order.timing",
        formId,
        entryId,
        changed: false,
        ...commandTiming.mutationTimings,
        totalMs: Date.now() - totalStartedAt,
      });
      return {
        sortOrder,
        previousSortOrder,
        changed: false,
      };
    }

    timing.markWriteStarted();
    try {
      await timing.run("write", () =>
        writeToRagic(
          formId,
          config,
          entryId,
          { [sortOrderFieldId]: sortOrder },
          false,
          "PATCH",
          { doFormula: false },
          timing.writeRequestOptions()
        )
      );
    } catch (error) {
      const ragicFailure = resolveRagicWriteFailure(error);
      const requiredFieldName = ragicFailure
        ? parseRagicEmptyRequiredField(ragicFailure.message)
        : null;
      const requiredField = inspectRequiredField(currentEntry, requiredFieldName);
      const workOrderNo = String(
        getFirstFieldValue(
          currentEntry,
          resolveCandidateFieldKeys(
            config.mainFields.workOrderNo ?? "",
            config.mainFieldFallbacks?.workOrderNo
          )
        ) ?? ""
      ).trim();

      this.commandLog.error({
        event: "sort-order.write-failed",
        operation: "update-sort-order",
        formId,
        formName: config.formName,
        writePath,
        entryId,
        workOrderNo: workOrderNo || null,
        sortOrder: {
          previous: previousSortOrder,
          requested: sortOrder,
          fieldId: sortOrderFieldId,
        },
        requiredField,
        ragic: ragicFailure,
        errorCode:
          typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code
            : null,
        errorMessage: error instanceof Error ? error.message : String(error),
        timing: {
          ...timing.snapshot().mutationTimings,
          totalMs: Date.now() - totalStartedAt,
        },
      });

      if (
        ragicFailure !== null &&
        String(ragicFailure.ragicCode ?? "") === "202" &&
        requiredFieldName
      ) {
        const targetLabel = workOrderNo || entryId;
        throw new UpstreamError(
          `Ragic 拒絕修改工令排序：工令 ${targetLabel} 的必填欄位「${requiredFieldName}」目前為空，請先至 Ragic 補齊後再重試。原始錯誤：${ragicFailure.message} (code: 202)`,
          "RAGIC_WRITE_FAILED",
          {
            ...ragicFailure,
            operation: "update-sort-order",
            formId,
            entryId,
            workOrderNo: workOrderNo || null,
            requestedSortOrder: sortOrder,
            previousSortOrder,
            requiredField,
          }
        );
      }
      throw error;
    }
    workReportMutationCacheService.markReportFullCacheDirty(formId);

    const confirmedEntry = await timing.run("verify", () =>
      readConfirmedEntryAfterWrite({
        formId,
        entryId,
        writePath,
        label: "排序碼",
        readOptions: timing.readOptions("verify"),
      })
    );
    if (!confirmedEntry) {
      throw new UpstreamError(
        "Ragic 已回應排序碼更新，但無法回讀工令；請重新整理確認。",
        "RAGIC_WRITE_VERIFY_FAILED",
        { formId, entryId, expectedSortOrder: sortOrder }
      );
    }
    const confirmedSortOrder = parseStoredSortOrder(
      getFirstFieldValue(confirmedEntry, fieldCandidates)
    );
    if (confirmedSortOrder !== sortOrder) {
      throw new UpstreamError(
        "Ragic 已回應排序碼更新，但回讀值不一致；請重新整理確認。",
        "RAGIC_WRITE_VERIFY_FAILED",
        {
          formId,
          entryId,
          expectedSortOrder: sortOrder,
          confirmedSortOrder,
        }
      );
    }
    publishConfirmedEntry(options, entryId, confirmedEntry, config);
    const commandTiming = timing.snapshot();
    this.commandLog.info({
      event: "sort-order.timing",
      formId,
      entryId,
      changed: true,
      ...commandTiming.mutationTimings,
      totalMs: Date.now() - totalStartedAt,
    });
    return {
      sortOrder,
      previousSortOrder,
      changed: true,
    };
  }

  async updatePlannedEndDate(
    formId: string,
    entryId: string,
    plannedEndDate: string,
    options: WorkOrderCommandOptions = {}
  ): Promise<{
    plannedEndDate: string;
    previousPlannedEndDate: string | null;
    changed: boolean;
  }> {
    const totalStartedAt = Date.now();
    const timing = createCommandTimingTracker(options);
    const normalizedDate = normalizeDateOnly(plannedEndDate);
    if (!normalizedDate || normalizedDate !== plannedEndDate) {
      throw new HttpError(
        400,
        "plannedEndDate 格式錯誤，需為有效的 YYYY-MM-DD 日期",
        "INVALID_PAYLOAD"
      );
    }

    const config = getFormConfig(formId);
    const plannedEndDateFieldId =
      config.writeConfig.mainWriteFields?.plannedEndDate?.trim() ?? "";
    if (!plannedEndDateFieldId) {
      throw new HttpError(503, "主表指定結束日期欄位尚未設定", "FORM_NOT_CONFIGURED");
    }

    const writePath = resolveWritePath(formId, config.ragicPath);
    if (!writePath) {
      throw new HttpError(
        503,
        "寫入路徑未設定（請確認 RAGIC_WRITE_TARGET 與 TEST_PATH）",
        "FORM_NOT_CONFIGURED"
      );
    }
    const fieldCandidates = Array.from(
      new Set([
        plannedEndDateFieldId,
        ...resolveCandidateFieldKeys(
          config.mainFields.plannedEndDate ?? "",
          config.mainFieldFallbacks?.plannedEndDate
        ),
      ])
    ).filter(Boolean);
    const currentEntry = await timing.run("current", () =>
      ragicClient.getEntry(
        writePath,
        entryId,
        false,
        timing.readOptions("current")
      )
    );
    if (!currentEntry) {
      throw new HttpError(404, `找不到工令：${entryId}`, "REPORT_NOT_FOUND");
    }
    const expectedLastUpdatedAt = String(options.expectedEntryLastUpdatedAt ?? "").trim();
    const currentLastUpdatedAt = String(
      getFirstFieldValue(
        currentEntry,
        resolveCandidateFieldKeys(
          config.mainFields.lastUpdatedAt ?? "",
          config.mainFieldFallbacks?.lastUpdatedAt
        )
      ) ?? ""
    ).trim();
    assertWorkOrderOpen(currentEntry, config, "指定結束日期");
    const previousRawValue = getFirstFieldValue(currentEntry, fieldCandidates);
    const previousText = String(previousRawValue ?? "").trim();
    const previousPlannedEndDate = previousText ? normalizeDateOnly(previousText) : null;
    if (previousText && !previousPlannedEndDate) {
      throw new UpstreamError(
        "Ragic 目前的指定結束日期格式無法辨識，未執行寫入。",
        "RAGIC_PLANNED_END_DATE_UNPARSEABLE",
        { formId, entryId, observedValue: previousText }
      );
    }
    assertFieldOrEntryPrecondition({
      current: previousPlannedEndDate, expected: options.expectedPlannedEndDate, intended: normalizedDate,
      label: "指定結束日期", expectedEntryLastUpdatedAt: expectedLastUpdatedAt,
      currentEntryLastUpdatedAt: currentLastUpdatedAt,
    });
    if (previousPlannedEndDate === normalizedDate) {
      const confirmedCurrentEntry = await timing.run("current", () =>
        readFullEntryForNoopObservation({
          writePath,
          entryId,
          readOptions: timing.readOptions("current"),
          isStillNoop: (entry) =>
            normalizeDateOnly(getFirstFieldValue(entry, fieldCandidates)) ===
            normalizedDate,
        })
      );
      publishConfirmedEntry(options, entryId, confirmedCurrentEntry, config);
      const commandTiming = timing.snapshot();
      this.commandLog.info({
        event: "planned-end-date.timing",
        formId,
        entryId,
        changed: false,
        ...commandTiming.mutationTimings,
        totalMs: Date.now() - totalStartedAt,
      });
      return {
        plannedEndDate: normalizedDate,
        previousPlannedEndDate,
        changed: false,
      };
    }

    timing.markWriteStarted();
    await timing.run("write", () =>
      writeToRagic(
        formId,
        config,
        entryId,
        { [plannedEndDateFieldId]: toRagicDateOnly(normalizedDate) },
        true,
        "PATCH",
        {
          doFormula: false,
          doLinkLoad: "first",
        },
        timing.writeRequestOptions()
      )
    );
    workReportMutationCacheService.markReportFullCacheDirty(formId);

    const confirmedEntry = await timing.run("verify", () =>
      readConfirmedEntryAfterWrite({
        formId,
        entryId,
        writePath,
        label: "指定結束日期",
        readOptions: timing.readOptions("verify"),
      })
    );
    if (!confirmedEntry) {
      throw new UpstreamError(
        "Ragic 已回應指定結束日期更新，但無法回讀工令；請重新整理確認。",
        "RAGIC_WRITE_VERIFY_FAILED",
        { formId, entryId, expectedPlannedEndDate: normalizedDate }
      );
    }
    const confirmedPlannedEndDate = normalizeDateOnly(
      getFirstFieldValue(confirmedEntry, fieldCandidates)
    );
    if (confirmedPlannedEndDate !== normalizedDate) {
      throw new UpstreamError(
        "Ragic 已回應指定結束日期更新，但回讀值不一致；請重新整理確認。",
        "RAGIC_WRITE_VERIFY_FAILED",
        {
          formId,
          entryId,
          expectedPlannedEndDate: normalizedDate,
          confirmedPlannedEndDate,
        }
      );
    }
    publishConfirmedEntry(options, entryId, confirmedEntry, config);
    const commandTiming = timing.snapshot();

    this.commandLog.info({
      event: "planned-end-date.timing",
      formId,
      entryId,
      changed: true,
      ...commandTiming.mutationTimings,
      totalMs: Date.now() - totalStartedAt,
    });
    return {
      plannedEndDate: normalizedDate,
      previousPlannedEndDate,
      changed: true,
    };
  }

  async updateUrgent(
    formId: string,
    entryId: string,
    urgent: boolean,
    options: WorkOrderCommandOptions = {}
  ): Promise<{
    urgent: boolean;
    previousUrgent: boolean;
    changed: boolean;
  }> {
    const result = await this.updateCheckboxMainField({
      formId,
      entryId,
      value: urgent,
      options,
      fieldKey: "urgent",
      label: "急件狀態",
      timingEvent: "urgent.timing",
      unparseableCode: "RAGIC_URGENT_UNPARSEABLE",
    });
    return {
      urgent: result.value,
      previousUrgent: result.previousValue,
      changed: result.changed,
    };
  }

  async updateStartSchedule(
    formId: string,
    entryId: string,
    startSchedule: boolean,
    options: WorkOrderCommandOptions = {}
  ): Promise<{
    startSchedule: boolean;
    previousStartSchedule: boolean;
    changed: boolean;
  }> {
    const result = await this.updateCheckboxMainField({
      formId,
      entryId,
      value: startSchedule,
      options,
      fieldKey: "startSchedule",
      label: "開始排程狀態",
      timingEvent: "start-schedule.timing",
      unparseableCode: "RAGIC_START_SCHEDULE_UNPARSEABLE",
    });
    return {
      startSchedule: result.value,
      previousStartSchedule: result.previousValue,
      changed: result.changed,
    };
  }

  private async updateCheckboxMainField(input: {
    formId: string;
    entryId: string;
    value: boolean;
    options: WorkOrderCommandOptions;
    fieldKey: "urgent" | "startSchedule";
    label: string;
    timingEvent: string;
    unparseableCode: string;
  }): Promise<{ value: boolean; previousValue: boolean; changed: boolean }> {
    const totalStartedAt = Date.now();
    const timing = createCommandTimingTracker(input.options);
    const config = getFormConfig(input.formId);
    const fieldId = config.writeConfig.mainWriteFields?.[input.fieldKey]?.trim() ?? "";
    if (!fieldId) {
      throw new HttpError(
        503,
        `主表${input.label}欄位尚未設定`,
        "FORM_NOT_CONFIGURED"
      );
    }

    const writePath = resolveWritePath(input.formId, config.ragicPath);
    if (!writePath) {
      throw new HttpError(
        503,
        "寫入路徑未設定（請確認 RAGIC_WRITE_TARGET 與 TEST_PATH）",
        "FORM_NOT_CONFIGURED"
      );
    }
    const fieldCandidates = Array.from(
      new Set([
        fieldId,
        ...resolveCandidateFieldKeys(
          config.mainFields[input.fieldKey] ?? "",
          config.mainFieldFallbacks?.[input.fieldKey]
        ),
      ])
    ).filter(Boolean);
    const currentEntry = await timing.run("current", () =>
      ragicClient.getEntry(
        writePath,
        input.entryId,
        false,
        timing.readOptions("current")
      )
    );
    if (!currentEntry) {
      throw new HttpError(404, `找不到工令：${input.entryId}`, "REPORT_NOT_FOUND");
    }

    const expectedLastUpdatedAt = String(
      input.options.expectedEntryLastUpdatedAt ?? ""
    ).trim();
    const currentLastUpdatedAt = String(
      getFirstFieldValue(
        currentEntry,
        resolveCandidateFieldKeys(
          config.mainFields.lastUpdatedAt ?? "",
          config.mainFieldFallbacks?.lastUpdatedAt
        )
      ) ?? ""
    ).trim();
    assertWorkOrderOpen(currentEntry, config, input.label);

    const previousRawValue = getFirstFieldValue(currentEntry, fieldCandidates);
    const previousValue = parseRagicCheckbox(previousRawValue);
    if (previousValue === null) {
      throw new UpstreamError(
        `Ragic 目前的${input.label}欄位值無法辨識，未執行寫入。`,
        input.unparseableCode,
        {
          formId: input.formId,
          entryId: input.entryId,
          observedValue: String(previousRawValue),
        }
      );
    }
    assertFieldOrEntryPrecondition({
      current: previousValue,
      expected: input.fieldKey === "urgent" ? input.options.expectedUrgent : input.options.expectedStartSchedule,
      intended: input.value, label: input.label,
      expectedEntryLastUpdatedAt: expectedLastUpdatedAt,
      currentEntryLastUpdatedAt: currentLastUpdatedAt,
    });
    if (previousValue === input.value) {
      const confirmedCurrentEntry = await timing.run("current", () =>
        readFullEntryForNoopObservation({
          writePath,
          entryId: input.entryId,
          readOptions: timing.readOptions("current"),
          isStillNoop: (entry) =>
            parseRagicCheckbox(getFirstFieldValue(entry, fieldCandidates)) ===
            input.value,
        })
      );
      publishConfirmedEntry(
        input.options,
        input.entryId,
        confirmedCurrentEntry,
        config
      );
      const commandTiming = timing.snapshot();
      this.commandLog.info({
        event: input.timingEvent,
        formId: input.formId,
        entryId: input.entryId,
        changed: false,
        ...commandTiming.mutationTimings,
        totalMs: Date.now() - totalStartedAt,
      });
      return { value: input.value, previousValue, changed: false };
    }

    timing.markWriteStarted();
    await timing.run("write", () =>
      writeToRagic(
        input.formId,
        config,
        input.entryId,
        { [fieldId]: input.value ? "Yes" : "No" },
        false,
        "PATCH",
        { doFormula: false },
        timing.writeRequestOptions()
      )
    );
    workReportMutationCacheService.markReportFullCacheDirty(input.formId);

    const confirmedEntry = await timing.run("verify", () =>
      readConfirmedEntryAfterWrite({
        formId: input.formId,
        entryId: input.entryId,
        writePath,
        label: input.label,
        readOptions: timing.readOptions("verify"),
      })
    );
    if (!confirmedEntry) {
      throw new UpstreamError(
        `Ragic 已回應${input.label}更新，但無法回讀工令；請重新整理確認。`,
        "RAGIC_WRITE_VERIFY_FAILED",
        {
          formId: input.formId,
          entryId: input.entryId,
          expectedValue: input.value,
        }
      );
    }
    const confirmedValue = parseRagicCheckbox(
      getFirstFieldValue(confirmedEntry, fieldCandidates)
    );
    if (confirmedValue !== input.value) {
      throw new UpstreamError(
        `Ragic 已回應${input.label}更新，但回讀值不一致；請重新整理確認。`,
        "RAGIC_WRITE_VERIFY_FAILED",
        {
          formId: input.formId,
          entryId: input.entryId,
          expectedValue: input.value,
          confirmedValue,
        }
      );
    }
    publishConfirmedEntry(input.options, input.entryId, confirmedEntry, config);
    const commandTiming = timing.snapshot();

    this.commandLog.info({
      event: input.timingEvent,
      formId: input.formId,
      entryId: input.entryId,
      changed: true,
      ...commandTiming.mutationTimings,
      totalMs: Date.now() - totalStartedAt,
    });
    return { value: input.value, previousValue, changed: true };
  }

  async manualCloseWorkOrder(
    formId: string,
    entryId: string,
    action: "close" | "reopen",
    options: WorkOrderCommandOptions = {}
  ): Promise<{ action: "close" | "reopen"; previousStatus: string | null }> {
    const totalStartedAt = Date.now();
    const timing = createCommandTimingTracker(options);
    const config = getFormConfig(formId);
    const buttonId = (
      action === "close"
        ? formId === "901"
          ? env.RAGIC_FORM_901_CLOSE_ACTION_BUTTON_ID
          : env.RAGIC_FORM_902_CLOSE_ACTION_BUTTON_ID
        : formId === "901"
          ? env.RAGIC_FORM_901_REOPEN_ACTION_BUTTON_ID
          : env.RAGIC_FORM_902_REOPEN_ACTION_BUTTON_ID
    ).trim();

    if (!buttonId) {
      throw new HttpError(503, `${action} 按鈕 ID 尚未設定`, "FORM_NOT_CONFIGURED");
    }

    const writePath = resolveWritePath(formId, config.ragicPath);
    if (!writePath) {
      throw new HttpError(
        503,
        "寫入路徑未設定（請確認 RAGIC_WRITE_TARGET 與 TEST_PATH）",
        "FORM_NOT_CONFIGURED"
      );
    }

    const currentEntry = await timing.run("current", () =>
      ragicClient.getEntry(
        writePath,
        entryId,
        false,
        timing.readOptions("current")
      )
    );
    if (!currentEntry) {
      throw new HttpError(404, `找不到工令：${entryId}`, "REPORT_NOT_FOUND");
    }
    const previousStatusText = String(
      getFirstFieldValue(
        currentEntry,
        resolveCandidateFieldKeys(
          config.mainFields.status ?? "",
          config.mainFieldFallbacks?.status
        )
      ) ?? ""
    ).trim();

    timing.markWriteStarted();
    const result = await timing.run("write", () =>
      ragicClient.executeActionButton(
        writePath,
        entryId,
        buttonId,
        timing.writeRequestOptions().onAttemptTiming
      )
    );
    ragicClient.clearFormCache(resolveWorkReportDataPath(formId, config.ragicPath));

    this.commandLog.info({
      event: "work-order.action-button.completed",
      formId,
      entryId,
      action,
      buttonId,
      status: result.status,
      msg: result.msg,
      ...timing.snapshot().mutationTimings,
      totalMs: Date.now() - totalStartedAt,
    });

    if (result.status !== "SUCCESS" && result.status !== "WARN") {
      throw new HttpError(
        502,
        result.msg || `人工${action === "close" ? "結案" : "取消結案"}失敗`,
        "RAGIC_ACTION_BUTTON_FAILED"
      );
    }

    workReportMutationCacheService.markReportFullCacheDirty(formId);
    return { action, previousStatus: previousStatusText || null };
  }
}

export const workReportWorkOrderCommandService =
  new WorkReportWorkOrderCommandService();
