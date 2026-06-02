import { env } from "../../config/env";
import { getFormConfig } from "../../config/forms";
import type { RagicReadPriority } from "../../infra/ragicRequestScheduler";
import { ragicClient } from "../../ragic/client";
import type { LinkedFieldMapping } from "../../types/formConfig";
import { normalizeRows, type RagicRow, type SourceDataMap } from "./shared/ragicRowUtils";
import { prepareLinkedSourceMaps } from "./queries/linkedSources";

interface FormOptionItem {
  value: string;
  label: string;
  display: string;
  operatorGroupKey?: string;
  operatorGroupLabel?: string;
  processGroupKey?: string;
  processGroupLabel?: string;
  machineDefault?: {
    machineCode: string;
    processCategoryCode?: string;
    processCategoryName?: string;
    processCode?: string;
    mainOperatorId?: string;
    mainOperatorName?: string;
    machineSpec?: string;
    machineSpeed?: string;
    status?: string;
    sourceEntryId?: string;
  };
}

export type FormOptionMap = Record<string, FormOptionItem[]>;

export class WorkReportOptionsReadService {
  private readonly optionsCacheByKey = new Map<
    string,
    {
      expiresAt: number;
      value: FormOptionMap;
    }
  >();
  private readonly optionsPromiseByKey = new Map<string, Promise<FormOptionMap>>();

  /**
   * Priority default = "user"（多數 caller 是使用者開 picker / list 拉 options），
   * 但若有 prewarm / background cache rebuild 等場景應傳 "background" 或 "sync"
   * 避免 silent fallback 把背景流量塞回 user lane。
   */
  async getFormOptions(
    formId: string,
    fields?: string[],
    priority: RagicReadPriority = "user"
  ): Promise<FormOptionMap> {
    const config = getFormConfig(formId);
    const result: FormOptionMap = {};

    if (!config.linkedFields) {
      return result;
    }

    const requestedFields = fields?.length
      ? fields.filter((field) => Boolean(config.linkedFields?.[field]))
      : Object.keys(config.linkedFields);
    const cacheKey = this.buildOptionsCacheKey(formId, requestedFields);
    const now = Date.now();
    const cached = this.optionsCacheByKey.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const inflight = this.optionsPromiseByKey.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const loadPromise = this.buildFormOptions(config.linkedFields, requestedFields, priority)
      .then((nextResult) => {
        this.optionsCacheByKey.set(cacheKey, {
          expiresAt: Date.now() + env.CACHE_TTL * 1000,
          value: nextResult,
        });
        return nextResult;
      })
      .finally(() => {
        this.optionsPromiseByKey.delete(cacheKey);
      });
    this.optionsPromiseByKey.set(cacheKey, loadPromise);
    return loadPromise;
  }

  async getRawPreview(formId: string, limit: number): Promise<RagicRow[]> {
    const config = getFormConfig(formId);
    // Admin debug `/raw` endpoint，使用者觸發，default user lane
    const rawData = await ragicClient.getFormData(config.ragicPath);
    return normalizeRows(rawData).slice(0, limit);
  }

  /**
   * Priority 必填（跟底層 prepareLinkedSourceMaps 一致），避免 silent drop 回 user lane。
   */
  async prepareLinkedSourceMaps(
    linkedFields: LinkedFieldMapping | undefined,
    priority: RagicReadPriority
  ): Promise<Map<string, SourceDataMap>> {
    return prepareLinkedSourceMaps(linkedFields, priority);
  }

  private async buildFormOptions(
    linkedFields: LinkedFieldMapping | undefined,
    requestedFields: string[],
    priority: RagicReadPriority
  ): Promise<FormOptionMap> {
    const result: FormOptionMap = {};
    const sourceRowsPromiseByPath = new Map<string, Promise<RagicRow[]>>();
    const getSourceRows = (sourceFormPath: string): Promise<RagicRow[]> => {
      const existing = sourceRowsPromiseByPath.get(sourceFormPath);
      if (existing) {
        return existing;
      }
      // 跟著 caller 指定的 lane（default user，prewarm 場景該傳 background/sync）
      const next = ragicClient
        .getFormDataWithOptions(sourceFormPath, true, { priority })
        .then((sourceRawData) => normalizeRows(sourceRawData));
      sourceRowsPromiseByPath.set(sourceFormPath, next);
      return next;
    };

    const optionEntries = await Promise.all(
      requestedFields.map(async (fieldName) => {
        const linkedConfig = linkedFields?.[fieldName];
        if (!linkedConfig?.sourceFormPath) {
          return [fieldName, [] as FormOptionItem[]] as const;
        }

        const rows = await getSourceRows(linkedConfig.sourceFormPath);
        const dedup = new Map<string, FormOptionItem>();

        for (const row of rows) {
          const valueRaw = linkedConfig.lookupFieldId
            ? row.data[linkedConfig.lookupFieldId]
            : row.data._ragicId ?? row.entryId;
          const displayRaw = row.data[linkedConfig.displayFieldId];

          const value = this.pickFirstNonEmptyText(valueRaw);
          if (!value) {
            continue;
          }

          const display = this.pickFirstNonEmptyText(displayRaw) ?? "";
          const label = display ? `${value} - ${display}` : value;

          if (!dedup.has(value)) {
            const optionItem: FormOptionItem = { value, label, display };
            if (fieldName === "machineId") {
              optionItem.machineDefault = this.buildMachineDefault(row);
            }
            if (fieldName === "operatorId") {
              const operatorGroup = this.buildOperatorGroup(row);
              if (operatorGroup) {
                optionItem.operatorGroupKey = operatorGroup.key;
                optionItem.operatorGroupLabel = operatorGroup.label;
              }
            }
            if (fieldName === "processCode") {
              const processGroup = this.buildProcessGroup(row);
              if (processGroup) {
                optionItem.processGroupKey = processGroup.key;
                optionItem.processGroupLabel = processGroup.label;
              }
            }
            dedup.set(value, optionItem);
          }
        }

        return [
          fieldName,
          Array.from(dedup.values()).sort((a, b) => a.label.localeCompare(b.label, "zh-Hant")),
        ] as const;
      })
    );

    for (const [fieldName, options] of optionEntries) {
      result[fieldName] = options;
    }

    return result;
  }

  private buildOptionsCacheKey(formId: string, requestedFields: string[]): string {
    const normalizedFields = [...requestedFields].sort().join(",");
    return `${formId}:${normalizedFields}`;
  }

  private pickFirstNonEmptyText(value: unknown): string | undefined {
    const picked = this.pickScalarLikeValue(value);
    if (picked === undefined || picked === null) {
      return undefined;
    }
    const text = String(picked).trim();
    return text || undefined;
  }

  private pickScalarLikeValue(
    value: unknown
  ): string | number | boolean | null | undefined {
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const picked = this.pickScalarLikeValue(item);
        if (picked === undefined || picked === null) {
          continue;
        }
        if (typeof picked === "string" && picked.trim() === "") {
          continue;
        }
        return picked;
      }
      return undefined;
    }

    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const scalarKeys = ["value", "_value", "label", "_label"] as const;
      for (const key of scalarKeys) {
        if (!(key in record)) {
          continue;
        }
        const picked = this.pickScalarLikeValue(record[key]);
        if (picked === undefined || picked === null) {
          continue;
        }
        if (typeof picked === "string" && picked.trim() === "") {
          continue;
        }
        return picked;
      }
    }

    return undefined;
  }

  private parseProcessCode(value: unknown): string | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const parsed = this.parseProcessCode(item);
        if (parsed) {
          return parsed;
        }
      }
      return undefined;
    }

    const text = this.pickFirstNonEmptyText(value);
    if (!text) {
      return undefined;
    }
    const firstToken = text.split(",")[0]?.trim() ?? "";
    const code = firstToken.split(":")[0]?.trim() ?? "";
    return code || undefined;
  }

  private buildMachineDefault(
    row?: RagicRow
  ): FormOptionItem["machineDefault"] | undefined {
    if (!row) {
      return undefined;
    }

    const machineCode = this.pickFirstNonEmptyText(row.data["機台代碼"]);
    if (!machineCode) {
      return undefined;
    }

    const processCategoryCode = this.pickFirstNonEmptyText(row.data["製程類別代碼"]);
    const processCategoryName =
      this.pickFirstNonEmptyText(row.data["製程簡稱"]) ??
      this.pickFirstNonEmptyText(row.data["製程類別名稱"]);
    const processCode =
      this.parseProcessCode(row.data["子製程代碼"]) ??
      this.parseProcessCode(row.data["1004970"]);
    const mainOperatorId = this.pickFirstNonEmptyText(row.data["主要操作者工號"]);
    const mainOperatorName = this.pickFirstNonEmptyText(row.data["主要操作者姓名"]);
    const machineSpec = this.pickFirstNonEmptyText(row.data["機台規格說明"]);
    const machineSpeed = this.pickFirstNonEmptyText(row.data["機台分速"]);
    const status = this.pickFirstNonEmptyText(row.data["狀態"]);
    const sourceEntryId = this.pickFirstNonEmptyText(
      row.data._ragicId ?? row.data._ragic_id ?? row.entryId
    );

    return {
      machineCode,
      processCategoryCode,
      processCategoryName,
      processCode,
      mainOperatorId,
      mainOperatorName,
      machineSpec,
      machineSpeed,
      status,
      sourceEntryId,
    };
  }

  private buildOperatorGroup(
    row?: RagicRow
  ): { key: string; label: string } | undefined {
    if (!row) {
      return undefined;
    }

    const label =
      this.pickFirstNonEmptyText(row.data["部門群組"]) ??
      this.pickFirstNonEmptyText(row.data["共同瀏覽部門群組"]);
    if (!label) {
      return undefined;
    }

    return { key: label, label };
  }

  private buildProcessGroup(
    row?: RagicRow
  ): { key: string; label: string } | undefined {
    if (!row) {
      return undefined;
    }

    const label =
      this.pickFirstNonEmptyText(row.data["製程簡稱Proc. Category Name"]) ??
      this.pickFirstNonEmptyText(row.data["製程大分類名稱"]) ??
      this.pickFirstNonEmptyText(row.data["製程簡稱"]) ??
      this.pickFirstNonEmptyText(row.data["Proc. Category Name"]);
    if (!label) {
      return undefined;
    }

    const key =
      this.pickFirstNonEmptyText(row.data["製程大分類代碼Proc. Category Code"]) ??
      this.pickFirstNonEmptyText(row.data["製程簡稱代碼"]) ??
      this.pickFirstNonEmptyText(row.data["Proc. Category Code"]) ??
      label;

    return { key, label };
  }
}
