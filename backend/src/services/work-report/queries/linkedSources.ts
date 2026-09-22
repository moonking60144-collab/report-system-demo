import { ragicClient } from "../../../ragic/client";
import type { RagicReadPriority } from "../../../infra/ragicRequestScheduler";
import { env } from "../../../config/env";
import { LinkedFieldMapping } from "../../../types/formConfig";
import { mapSourceDataById, SourceDataMap } from "../shared/ragicRowUtils";

interface SourceMapCacheEntry {
  expiresAt: number;
  value: SourceDataMap;
}

const sourceMapCacheByKey = new Map<string, SourceMapCacheEntry>();
const sourceMapPromiseByKey = new Map<string, Promise<SourceDataMap>>();
let sourceMapCacheGeneration = 0;

function buildSourceMapCacheKey(sourceFormPath: string, lookupFieldId?: string): string {
  return `${sourceFormPath}\0${lookupFieldId ?? ""}`;
}

function buildSourceMapInFlightKey(
  sourceFormPath: string,
  lookupFieldId: string | undefined,
  priority: RagicReadPriority
): string {
  return `${buildSourceMapCacheKey(sourceFormPath, lookupFieldId)}\0${priority}`;
}

function cloneSourceDataMap(sourceMap: SourceDataMap): SourceDataMap {
  return new Map(sourceMap);
}

async function loadSourceDataMap(
  sourceFormPath: string,
  lookupFieldId: string | undefined,
  priority: RagicReadPriority
): Promise<SourceDataMap> {
  const cacheKey = buildSourceMapCacheKey(sourceFormPath, lookupFieldId);
  const inFlightKey = buildSourceMapInFlightKey(sourceFormPath, lookupFieldId, priority);
  const now = Date.now();
  const cached = sourceMapCacheByKey.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cloneSourceDataMap(cached.value);
  }

  const inflight = sourceMapPromiseByKey.get(inFlightKey);
  if (inflight) {
    return inflight.then(cloneSourceDataMap);
  }

  const generation = sourceMapCacheGeneration;
  const loadPromise = ragicClient
    .getFormDataWithOptions(sourceFormPath, true, { priority })
    .then((sourceRawData) => {
      const sourceMap = mapSourceDataById(sourceRawData, lookupFieldId);
      if (sourceMapCacheGeneration === generation) {
        sourceMapCacheByKey.set(cacheKey, {
          expiresAt: Date.now() + env.CACHE_TTL * 1000,
          value: sourceMap,
        });
      }
      return sourceMap;
    })
    .finally(() => {
      if (sourceMapPromiseByKey.get(inFlightKey) === loadPromise) {
        sourceMapPromiseByKey.delete(inFlightKey);
      }
    });
  sourceMapPromiseByKey.set(inFlightKey, loadPromise);
  return loadPromise.then(cloneSourceDataMap);
}

export function clearPreparedLinkedSourceMapCache(sourceFormPath?: string): void {
  sourceMapCacheGeneration += 1;
  if (!sourceFormPath) {
    sourceMapCacheByKey.clear();
    sourceMapPromiseByKey.clear();
    return;
  }

  const prefix = `${sourceFormPath}\0`;
  for (const key of sourceMapCacheByKey.keys()) {
    if (key.startsWith(prefix)) {
      sourceMapCacheByKey.delete(key);
    }
  }
  for (const key of sourceMapPromiseByKey.keys()) {
    if (key.startsWith(prefix)) {
      sourceMapPromiseByKey.delete(key);
    }
  }
}

ragicClient.onFormCacheCleared(clearPreparedLinkedSourceMapCache);

/**
 * Priority **必填**，不提供 default。
 * 理由：default="user" 會讓背景路徑 caller 忘記傳時 silently drop 回 user lane
 * （就是我們修過的 silent-priority-drop 類型 bug），型別層直接強制 caller 選。
 */
export async function prepareLinkedSourceMaps(
  linkedFields: LinkedFieldMapping | undefined,
  priority: RagicReadPriority
): Promise<Map<string, SourceDataMap>> {
  const sourceMaps = new Map<string, SourceDataMap>();
  if (!linkedFields) {
    return sourceMaps;
  }

  const cacheBySourcePath = new Map<string, SourceDataMap>();
  for (const [fieldName, linkedConfig] of Object.entries(linkedFields)) {
    if (!linkedConfig.sourceFormPath) {
      continue;
    }

    const sourceCacheKey = buildSourceMapCacheKey(
      linkedConfig.sourceFormPath,
      linkedConfig.lookupFieldId
    );
    let sourceMap = cacheBySourcePath.get(sourceCacheKey);
    if (!sourceMap) {
      // 背景 / sync 流程透過 priority 參數隔離 lane；
      // getFormData 預設 user lane，這裡讓 caller 明確指定。
      sourceMap = await loadSourceDataMap(
        linkedConfig.sourceFormPath,
        linkedConfig.lookupFieldId,
        priority
      );
      cacheBySourcePath.set(sourceCacheKey, sourceMap);
    }
    sourceMaps.set(fieldName, sourceMap);
  }

  return sourceMaps;
}
