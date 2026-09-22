import { env } from "../../../config/env";
import { ragicClient } from "../../../ragic/client";
import { FormConfig } from "../../../types/formConfig";
import { workReportReadService } from "../workReportReadService";

const CACHE_TTL_MS = env.OPERATOR_OPTION_CACHE_TTL_MS;

const operatorOptionMapCache = new Map<
  string,
  { cachedAt: number; map: Map<string, string> }
>();

const operatorOptionMapRefreshTasks = new Map<string, Promise<void>>();
let operatorOptionMapGeneration = 0;

async function refreshOperatorOptionMap(
  formId: string,
  cacheKey: string
): Promise<Map<string, string>> {
  const generation = operatorOptionMapGeneration;
  const options = await workReportReadService.getFormOptions(formId, ["operatorId"]);
  const operatorOptions = options.operatorId ?? [];
  const operatorMap = new Map<string, string>();

  for (const item of operatorOptions) {
    operatorMap.set(item.value, item.display || item.label || item.value);
  }

  if (operatorOptionMapGeneration === generation) {
    operatorOptionMapCache.set(cacheKey, {
      cachedAt: Date.now(),
      map: operatorMap,
    });
  }
  return operatorMap;
}

function triggerOperatorOptionMapRefresh(formId: string, cacheKey: string): void {
  if (operatorOptionMapRefreshTasks.has(cacheKey)) {
    return;
  }

  const task = refreshOperatorOptionMap(formId, cacheKey)
    .then(() => undefined)
    .catch((error) => {
      console.warn("[operator-option-cache-refresh-failed]", {
        formId,
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      if (operatorOptionMapRefreshTasks.get(cacheKey) === task) {
        operatorOptionMapRefreshTasks.delete(cacheKey);
      }
    });
  operatorOptionMapRefreshTasks.set(cacheKey, task);
}

export async function getOperatorOptionMap(
  formId: string,
  config: FormConfig,
  options: { forceRefresh?: boolean } = {}
): Promise<Map<string, string>> {
  const operatorLinkedSource = config.linkedFields?.operatorId?.sourceFormPath ?? "";
  const cacheKey = `${formId}:${operatorLinkedSource}`;
  if (options.forceRefresh) {
    return refreshOperatorOptionMap(formId, cacheKey);
  }
  const cached = operatorOptionMapCache.get(cacheKey);
  if (cached) {
    const cacheAgeMs = Date.now() - cached.cachedAt;
    if (cacheAgeMs <= CACHE_TTL_MS) {
      return cached.map;
    }
    triggerOperatorOptionMapRefresh(formId, cacheKey);
    return cached.map;
  }

  const inFlightTask = operatorOptionMapRefreshTasks.get(cacheKey);
  if (inFlightTask) {
    await inFlightTask;
    const warmed = operatorOptionMapCache.get(cacheKey);
    if (warmed) {
      return warmed.map;
    }
  }

  return refreshOperatorOptionMap(formId, cacheKey);
}

export function clearOperatorOptionMapCache(sourceFormPath?: string): void {
  if (!sourceFormPath) {
    operatorOptionMapGeneration += 1;
    operatorOptionMapCache.clear();
    operatorOptionMapRefreshTasks.clear();
    return;
  }

  const normalizedSourcePath = normalizeFormPath(sourceFormPath);
  const cacheKeys = Array.from(operatorOptionMapCache.keys()).filter((key) =>
    isOperatorSourceCacheKey(key, normalizedSourcePath)
  );
  const refreshKeys = Array.from(operatorOptionMapRefreshTasks.keys()).filter((key) =>
    isOperatorSourceCacheKey(key, normalizedSourcePath)
  );
  if (cacheKeys.length === 0 && refreshKeys.length === 0) {
    return;
  }

  operatorOptionMapGeneration += 1;
  for (const key of cacheKeys) {
    operatorOptionMapCache.delete(key);
  }
  for (const key of refreshKeys) {
    operatorOptionMapRefreshTasks.delete(key);
  }
}

function isOperatorSourceCacheKey(cacheKey: string, normalizedSourcePath: string): boolean {
  return normalizeFormPath(cacheKey.split(":").slice(1).join(":")) === normalizedSourcePath;
}

function normalizeFormPath(formPath: string): string {
  return formPath.trim().replace(/\/+$/, "");
}

ragicClient.onFormCacheCleared(clearOperatorOptionMapCache);
