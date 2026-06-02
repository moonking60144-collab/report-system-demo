import { env } from "../../../config/env";
import { FormConfig } from "../../../types/formConfig";
import { workReportReadService } from "../workReportReadService";

const CACHE_TTL_MS = env.OPERATOR_OPTION_CACHE_TTL_MS;

const operatorOptionMapCache = new Map<
  string,
  { cachedAt: number; map: Map<string, string> }
>();

const operatorOptionMapRefreshTasks = new Map<string, Promise<void>>();

async function refreshOperatorOptionMap(
  formId: string,
  cacheKey: string
): Promise<Map<string, string>> {
  const options = await workReportReadService.getFormOptions(formId, ["operatorId"]);
  const operatorOptions = options.operatorId ?? [];
  const operatorMap = new Map<string, string>();

  for (const item of operatorOptions) {
    operatorMap.set(item.value, item.display || item.label || item.value);
  }

  operatorOptionMapCache.set(cacheKey, {
    cachedAt: Date.now(),
    map: operatorMap,
  });
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
