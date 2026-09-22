import {
  fetchRagicFormulaSiblings,
  type RagicDefinitionFormula,
  type RagicFormulaSiblingInfo,
} from "../../../api/devRagicDefinitions";

export interface FormulaSiblingsCacheQuery {
  formPath: string;
  fieldId: string;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  newFormula?: string;
  includeFreshness?: boolean;
  includeCurrent?: boolean;
}

export interface FormulaSiblingsCacheOptions {
  signal?: AbortSignal;
  shareInFlight?: boolean;
}

const MAX_CACHE_ENTRIES = 120;
const siblingsCache = new Map<string, RagicFormulaSiblingInfo[]>();
const siblingsInFlight = new Map<string, Promise<RagicFormulaSiblingInfo[]>>();
let cacheEpoch = 0;

function cacheKey(query: FormulaSiblingsCacheQuery): string {
  return JSON.stringify([
    query.formPath,
    query.fieldId,
    query.formulaKind,
    query.includeFreshness !== false,
    query.includeCurrent === true,
    query.newFormula ?? "",
  ]);
}

export function readCachedFormulaSiblings(
  query: FormulaSiblingsCacheQuery
): RagicFormulaSiblingInfo[] | null {
  return siblingsCache.get(cacheKey(query)) ?? null;
}

export function writeCachedFormulaSiblings(
  query: FormulaSiblingsCacheQuery,
  siblings: RagicFormulaSiblingInfo[]
): void {
  const key = cacheKey(query);
  siblingsCache.delete(key);
  siblingsCache.set(key, siblings);
  while (siblingsCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = siblingsCache.keys().next().value;
    if (!oldestKey) break;
    siblingsCache.delete(oldestKey);
  }
}

export async function loadCachedFormulaSiblings(
  token: string,
  query: FormulaSiblingsCacheQuery,
  options: FormulaSiblingsCacheOptions = {}
): Promise<RagicFormulaSiblingInfo[]> {
  throwIfAborted(options.signal);
  const cached = readCachedFormulaSiblings(query);
  if (cached) return cached;

  const key = cacheKey(query);
  const shareInFlight = options.signal
    ? options.shareInFlight === true
    : options.shareInFlight !== false;
  if (!shareInFlight) {
    return fetchAndCacheFormulaSiblings(token, query, options.signal);
  }

  const existing = siblingsInFlight.get(key);
  if (existing) return existing;

  const promise = fetchAndCacheFormulaSiblings(token, query)
    .finally(() => {
      if (siblingsInFlight.get(key) === promise) {
        siblingsInFlight.delete(key);
      }
    });
  siblingsInFlight.set(key, promise);
  return promise;
}

async function fetchAndCacheFormulaSiblings(
  token: string,
  query: FormulaSiblingsCacheQuery,
  signal?: AbortSignal
): Promise<RagicFormulaSiblingInfo[]> {
  const requestEpoch = cacheEpoch;
  const result = await fetchRagicFormulaSiblings(token, query, { signal });
  throwIfAborted(signal);
  if (requestEpoch === cacheEpoch) {
    writeCachedFormulaSiblings(query, result.siblings);
  }
  return result.siblings;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("formula siblings query aborted", "AbortError");
  }
}

export function clearCachedFormulaSiblings(): void {
  cacheEpoch += 1;
  siblingsCache.clear();
  siblingsInFlight.clear();
}
