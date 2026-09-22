import axios, { AxiosInstance } from "axios";
import NodeCache from "node-cache";
import { env } from "../config/env";
import { runWithReadRetry } from "../infra/ragicReadRetry";
import { runWithWriteRetry } from "../infra/ragicWriteRetry";
import {
  ragicRequestScheduler,
  RagicRequestSchedulerStats,
  type RagicReadPriority,
  type RagicRequestAttemptTiming,
} from "../infra/ragicRequestScheduler";
import { HttpError, UpstreamError } from "../utils/httpError";
import { buildDemoFixture } from "./demoFixture";
import { MockRagicClient } from "./mockClient";

export type RagicRecord = Record<string, unknown>;
export type RagicFormData = Record<string, RagicRecord>;
export type RagicWriteMethod = "POST" | "PUT" | "PATCH";
export interface RagicActionButtonExecutionResult {
  status: string;
  msg: string;
  code?: number | string;
  raw: RagicRecord;
}
export interface RagicWriteOptions {
  doWorkflow?: boolean;
  doFormula?: boolean;
  doDefaultValue?: boolean;
  /** 跳過回傳 status 驗證（Ragic POST 回傳整張表，大表可能超過 30MB 限制） */
  skipResponseValidation?: boolean;
  doLinkLoad?: "all" | "first";
}

export interface RagicWriteRequestOptions {
  onAttemptTiming?: (timing: RagicRequestAttemptTiming) => void;
}

export interface RagicEntryInspection {
  record: RagicRecord | null;
  history: {
    requested: true;
    available: boolean;
    reason: "returned" | "record-not-observed" | "upstream-did-not-return-history";
    sourcePath: string | null;
    entries: RagicRecord[];
  };
}

export type RagicEntryObservationRead =
  | { kind: "found"; record: RagicRecord }
  | { kind: "gone" };

const RAGIC_PAGE_SIZE = 1000;

interface RagicWriteResponse extends RagicRecord {
  status?: string;
  msg?: string;
  code?: number | string;
}

function buildRagicWriteBodyError(data: RagicWriteResponse): UpstreamError {
  const ragicStatus = String(data.status ?? "").trim();
  const ragicCode = data.code;
  const code = ragicCode ? ` (code: ${ragicCode})` : "";
  const message = data.msg ? String(data.msg) : "Ragic 回傳寫入錯誤";
  return new UpstreamError(`${message}${code}`, "RAGIC_WRITE_FAILED", {
    // HTTP request succeeded; Ragic rejected the payload at application level.
    status: 400,
    ragicStatus: ragicStatus || null,
    ragicCode: ragicCode ?? null,
    message,
  });
}

interface RagicPageQuery {
  limit: number;
  offset: number;
  /** 單條件字串或多條件陣列（axios 會串成多個 where= 參數，Ragic 視為 AND） */
  where?: string | string[];
  fts?: string;
}

export interface RagicReadRequestOptions {
  timeoutMs?: number;
  priority?: RagicReadPriority;
  maxRetries?: number;
  totalBudgetMs?: number;
  includeSubtables?: boolean;
  strictResponse?: boolean;
  onAttemptTiming?: (timing: RagicRequestAttemptTiming) => void;
}

interface RagicActionButtonItem {
  id?: string | number;
  name?: string;
}

interface RagicActionButtonMetadata extends RagicRecord {
  actionButtons?: RagicActionButtonItem[];
}

type RagicFormCacheClearListener = (formPath?: string) => void;

function isRagicRecord(value: unknown): value is RagicRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractEntry(payload: unknown, entryId: string): RagicRecord | null {
  if (!isRagicRecord(payload)) return null;
  const nested = isRagicRecord(payload.data) ? payload.data : payload;
  if ("_ragicId" in nested || "_ragic_id" in nested) return nested;
  const direct = nested[entryId];
  if (isRagicRecord(direct)) return direct;
  const keys = Object.keys(nested).filter((key) => !key.startsWith("_"));
  return keys.length === 1 && isRagicRecord(nested[keys[0]])
    ? nested[keys[0]] as RagicRecord
    : null;
}

function isHistoryEntry(value: unknown): value is RagicRecord {
  return isRagicRecord(value) && ["Time", "Type", "Sheet", "User", "Detail"].every(
    (key) => key in value
  );
}

function findHistoryArray(
  value: unknown,
  path = "$",
  depth = 0
): { sourcePath: string; entries: RagicRecord[] } | null {
  if (!isRagicRecord(value) || depth > 4) return null;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const entries = Array.isArray(child)
      ? child
      : isRagicRecord(child)
        ? Object.values(child)
        : null;
    if (
      entries &&
      ((/history/i.test(key) && entries.every(isRagicRecord)) ||
        (entries.length > 0 && entries.every(isHistoryEntry)))
    ) {
      return {
        sourcePath: childPath,
        entries: entries.filter(isRagicRecord),
      };
    }
    if (Array.isArray(child)) continue;
    const nested = findHistoryArray(child, childPath, depth + 1);
    if (nested) return nested;
  }
  return null;
}

class RagicClient {
  private readonly axiosInstance: AxiosInstance;
  private readonly cache: NodeCache;
  private readonly inFlightReads = new Map<string, Promise<{ value: unknown }>>();
  private readonly inFlightReadCacheKeys = new Map<string, string>();
  private readonly formCacheClearListeners = new Set<RagicFormCacheClearListener>();
  private readonly cacheGenerationByKey = new Map<string, number>();
  private globalCacheGeneration = 0;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`,
      timeout: 15000,
      headers: {
        Authorization: `Basic ${env.RAGIC_API_KEY}`,
      },
    });

    // useClones: true 避免呼叫端不小心 mutate cache 內容污染其他人
    // 代價是每次取用會 deep clone 一份，但 Ragic 回應體通常是純 JSON，clone 成本可接受
    this.cache = new NodeCache({
      stdTTL: env.CACHE_TTL,
      checkperiod: env.CACHE_CHECK_PERIOD,
      useClones: true,
    });
  }

  async getFormData(formPath: string, useCache = true): Promise<RagicFormData> {
    return this.getFormDataWithOptions(formPath, useCache);
  }

  async getFormDataWithOptions(
    formPath: string,
    useCache = true,
    requestOptions: RagicReadRequestOptions = {}
  ): Promise<RagicFormData> {
    const cacheKey = `form:${formPath}`;
    const priority = requestOptions.priority ?? "user";
    const timeoutMs = this.resolveReadTimeoutMs(requestOptions.timeoutMs);
    const inFlightKey = this.buildReadInFlightKey(
      cacheKey,
      useCache,
      priority,
      timeoutMs,
      requestOptions.maxRetries,
      requestOptions.totalBudgetMs
    );
    return this.runCacheableRead(cacheKey, inFlightKey, useCache, async () => {
      const merged: RagicFormData = {};
      let offset = 0;

      while (true) {
        const response = await this.runReadRequest(
          `getFormData:${formPath}`,
          () =>
            this.axiosInstance.get<RagicFormData>(formPath, {
              timeout: timeoutMs,
              params: { api: "true", offset },
            }),
          priority,
          { maxRetries: requestOptions.maxRetries, timeoutMs }
        );

        const pageEntries = Object.entries(response.data).filter(
          ([key]) => !key.startsWith("_")
        );

        for (const [entryId, record] of pageEntries) {
          merged[entryId] = record;
        }

        if (pageEntries.length < RAGIC_PAGE_SIZE) {
          break;
        }

        offset += RAGIC_PAGE_SIZE;
      }

      return merged;
    });
  }

  async getFormPage(
    formPath: string,
    query: RagicPageQuery,
    useCache = true,
    requestOptions: RagicReadRequestOptions = {}
  ): Promise<RagicFormData> {
    const whereKey = JSON.stringify(query.where ?? null);
    const cacheKey = `form-page:${formPath}:${query.limit}:${query.offset}:${whereKey}:${query.fts ?? ""}`;
    const priority = requestOptions.priority ?? "user";
    const timeoutMs = this.resolveReadTimeoutMs(requestOptions.timeoutMs);
    const inFlightKey = this.buildReadInFlightKey(
      cacheKey,
      useCache,
      priority,
      timeoutMs,
      requestOptions.maxRetries,
      requestOptions.totalBudgetMs
    );
    return this.runCacheableRead(cacheKey, inFlightKey, useCache, async () => {
      const response = await this.runReadRequest(
        `getFormPage:${formPath}`,
        () =>
          this.axiosInstance.get<RagicFormData>(formPath, {
            timeout: timeoutMs,
            params: {
              api: "true",
              limit: query.limit,
              offset: query.offset,
              ...(query.where ? { where: query.where } : {}),
              ...(query.fts ? { fts: query.fts } : {}),
            },
            // Ragic 多 where 條件要序列化成 `where=a&where=b`（不是預設的 `where[]=a&where[]=b`）
            paramsSerializer: { indexes: null },
          }),
        priority,
        { maxRetries: requestOptions.maxRetries, timeoutMs }
      );

      const container = response.data as RagicRecord;
      const nested = container?.data;
      return isRagicRecord(nested) ? nested as RagicFormData : response.data;
    });
  }

  async getEntry(
    formPath: string,
    entryId: string,
    useCache = true,
    requestOptions: RagicReadRequestOptions = {}
  ): Promise<RagicRecord | null> {
    const strictResponse = requestOptions.strictResponse === true;
    const readFromCache = useCache && !strictResponse;
    const includeSubtables = requestOptions.includeSubtables !== false;
    const cacheKey = includeSubtables
      ? `entry:${formPath}:${entryId}`
      : `entry:${formPath}:${entryId}:subtables=0`;
    const priority = requestOptions.priority ?? "user";
    const timeoutMs = this.resolveReadTimeoutMs(requestOptions.timeoutMs);
    const inFlightKey = this.buildReadInFlightKey(
      cacheKey,
      readFromCache,
      priority,
      timeoutMs,
      requestOptions.maxRetries,
      requestOptions.totalBudgetMs
    ) + (strictResponse ? "\0strict-response" : "");
    return this.runCacheableRead(cacheKey, inFlightKey, readFromCache, async () => {
      const normalizedPath = formPath.endsWith("/")
        ? `${formPath}${entryId}`
        : `${formPath}/${entryId}`;

      const response = await this.runReadRequest(
        `getEntry:${normalizedPath}`,
        (requestTimeoutMs) =>
          this.axiosInstance.get<RagicRecord>(normalizedPath, {
            timeout: Math.max(
              1,
              Math.min(timeoutMs, requestTimeoutMs ?? timeoutMs)
            ),
            params: {
              api: "true",
              ...(includeSubtables ? {} : { subtables: "0" }),
            },
          }),
        priority,
        {
          maxRetries: requestOptions.maxRetries,
          timeoutMs,
          totalBudgetMs: requestOptions.totalBudgetMs,
          onAttemptTiming: requestOptions.onAttemptTiming,
        }
      );

      if (strictResponse && isRagicRecord(response.data) && String(response.data.status ?? "").trim().toUpperCase() === "ERROR") {
        throw new UpstreamError(String(response.data.msg ?? "Ragic 資料讀取回傳 application error"), "RAGIC_READ_FAILED");
      }
      const record = extractEntry(response.data, entryId);
      if (strictResponse && !record) {
        throw new UpstreamError(`Ragic 資料讀取回傳無法辨識的 entry payload（entry ${entryId}）`, "RAGIC_READ_INVALID_RESPONSE");
      }
      return record;
    });
  }

  /**
   * 給一致性補驗使用的 strict read：只有 HTTP 404 才代表 gone；
   * 200 但沒有可辨識 entry 或 application status=ERROR 都是 read failure。
   */
  async observeEntry(
    formPath: string,
    entryId: string,
    requestOptions: RagicReadRequestOptions = {}
  ): Promise<RagicEntryObservationRead> {
    const normalizedPath = formPath.endsWith("/")
      ? `${formPath}${entryId}`
      : `${formPath}/${entryId}`;
    const timeoutMs = this.resolveReadTimeoutMs(requestOptions.timeoutMs);
    const response = await this.runReadRequest(
      `observeEntry:${normalizedPath}`,
      (requestTimeoutMs) =>
        this.axiosInstance.get<RagicRecord>(normalizedPath, {
          timeout: Math.max(1, Math.min(timeoutMs, requestTimeoutMs ?? timeoutMs)),
          params: { api: "true", subtables: "0" },
          validateStatus: (status) => status === 200 || status === 404,
        }),
      requestOptions.priority ?? "background",
      {
        maxRetries: requestOptions.maxRetries,
        timeoutMs,
        totalBudgetMs: requestOptions.totalBudgetMs,
        onAttemptTiming: requestOptions.onAttemptTiming,
      }
    );

    if (response.status === 404) {
      return { kind: "gone" };
    }
    const applicationStatus = isRagicRecord(response.data)
      ? String(response.data.status ?? "").trim().toUpperCase()
      : "";
    if (applicationStatus === "ERROR") {
      throw new UpstreamError(
        String(response.data.msg ?? "Ragic 補驗讀取回傳 application error"),
        "RAGIC_READ_FAILED"
      );
    }
    const record = extractEntry(response.data, entryId);
    if (!record) {
      throw new UpstreamError(
        `Ragic 補驗讀取回傳無法辨識的 entry payload（entry ${entryId}）`,
        "RAGIC_READ_INVALID_RESPONSE"
      );
    }
    return { kind: "found", record };
  }

  async inspectEntry(
    formPath: string,
    entryId: string,
    requestOptions: RagicReadRequestOptions = {}
  ): Promise<RagicEntryInspection> {
    const normalizedPath = formPath.endsWith("/")
      ? `${formPath}${entryId}`
      : `${formPath}/${entryId}`;
    const timeoutMs = this.resolveReadTimeoutMs(requestOptions.timeoutMs);
    const response = await this.runReadRequest(
      `inspectEntry:${normalizedPath}`,
      () =>
        this.axiosInstance.get<RagicRecord>(normalizedPath, {
          timeout: timeoutMs,
          params: { api: "true", history: "true", info: "true" },
          headers: {
            Authorization: `Basic ${env.DEV_SOURCE_RAGIC_API_KEY}`,
          },
          validateStatus: (status) => status === 200 || status === 404,
        }),
      requestOptions.priority ?? "user",
      { maxRetries: requestOptions.maxRetries, timeoutMs }
    );
    const record = response.status === 404 ? null : extractEntry(response.data, entryId);
    const history = findHistoryArray(response.data);
    return {
      record,
      history: history
        ? {
            requested: true,
            available: true,
            reason: "returned",
            sourcePath: history.sourcePath,
            entries: history.entries,
          }
        : {
            requested: true,
            available: false,
            reason: record ? "upstream-did-not-return-history" : "record-not-observed",
            sourcePath: null,
            entries: [],
          },
    };
  }

  async updateEntry(
    formPath: string,
    entryId: string,
    payload: RagicRecord,
    method: RagicWriteMethod = "PATCH",
    writeOptions: boolean | RagicWriteOptions = true,
    requestOptions: RagicWriteRequestOptions = {}
  ): Promise<RagicRecord> {
    const normalizedPath = formPath.endsWith("/")
      ? `${formPath}${entryId}`
      : `${formPath}/${entryId}`;

    const normalizedOptions: RagicWriteOptions =
      typeof writeOptions === "boolean"
        ? { doWorkflow: writeOptions }
        : { doWorkflow: true, ...writeOptions };
    const requestParams: Record<string, string> = {
      api: "true",
      doWorkflow: normalizedOptions.doWorkflow ? "true" : "false",
    };
    if (normalizedOptions.doFormula !== undefined) {
      requestParams.doFormula = normalizedOptions.doFormula ? "true" : "false";
    }
    if (normalizedOptions.doDefaultValue !== undefined) {
      requestParams.doDefaultValue = normalizedOptions.doDefaultValue ? "true" : "false";
    }
    if (normalizedOptions.doLinkLoad) {
      requestParams.doLinkLoad = normalizedOptions.doLinkLoad;
    }

    const response = await runWithWriteRetry(
      () =>
        this.runWriteRequest(
          `updateEntry:${normalizedPath}`,
          () =>
            this.axiosInstance.request<RagicWriteResponse>({
              url: normalizedPath,
              method,
              timeout: env.RAGIC_WRITE_TIMEOUT_MS,
              params: requestParams,
              data: payload,
              headers: {
                "Content-Type": "application/json",
              },
            }),
          requestOptions.onAttemptTiming
        ),
      {
        label: `updateEntry:${normalizedPath}`,
      }
    );

    const status = String(response.data?.status ?? "").toUpperCase();
    if (status && status !== "SUCCESS") {
      throw buildRagicWriteBodyError(response.data);
    }

    this.clearFormCache(formPath);
    return response.data;
  }

  async deleteEntry(formPath: string, entryId: string): Promise<void> {
    const normalizedPath = formPath.endsWith("/")
      ? `${formPath}${entryId}`
      : `${formPath}/${entryId}`;

    await runWithWriteRetry(
      () =>
        this.runWriteRequest(`deleteEntry:${normalizedPath}`, () =>
          this.axiosInstance.request<RagicWriteResponse>({
            url: normalizedPath,
            method: "DELETE",
            timeout: env.RAGIC_WRITE_TIMEOUT_MS,
            params: { api: "true" },
          })
        ),
      { label: `deleteEntry:${normalizedPath}` }
    );

    this.clearFormCache(formPath);
  }

  async createEntry(
    formPath: string,
    payload: RagicRecord,
    writeOptions: boolean | RagicWriteOptions = true
  ): Promise<RagicRecord> {
    const normalizedPath = formPath.endsWith("/") ? formPath.slice(0, -1) : formPath;
    const normalizedOptions: RagicWriteOptions =
      typeof writeOptions === "boolean"
        ? { doWorkflow: writeOptions }
        : { doWorkflow: true, ...writeOptions };
    const requestParams: Record<string, string> = {
      api: "true",
      doWorkflow: normalizedOptions.doWorkflow ? "true" : "false",
    };
    if (normalizedOptions.doFormula !== undefined) {
      requestParams.doFormula = normalizedOptions.doFormula ? "true" : "false";
    }
    if (normalizedOptions.doDefaultValue !== undefined) {
      requestParams.doDefaultValue = normalizedOptions.doDefaultValue ? "true" : "false";
    }
    if (normalizedOptions.doLinkLoad) {
      requestParams.doLinkLoad = normalizedOptions.doLinkLoad;
    }

    // NOTE: createEntry 不做自動 retry，避免 timeout/網路抖動時發生重複建立。
    const response = await this.runWriteRequest(
      `createEntry:${normalizedPath}`,
      () =>
        this.axiosInstance.post<RagicWriteResponse>(
          normalizedPath,
          payload,
          {
            timeout: env.RAGIC_WRITE_TIMEOUT_MS,
            params: requestParams,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
    );

    if (!normalizedOptions.skipResponseValidation) {
      const status = String(response.data?.status ?? "").toUpperCase();
      if (status && status !== "SUCCESS") {
        throw buildRagicWriteBodyError(response.data);
      }
    }

    this.clearFormCache(formPath);
    return response.data;
  }

  async getActionButtons(
    formPath: string,
    category: "massOperation" = "massOperation",
    requestOptions: RagicReadRequestOptions = {}
  ): Promise<Array<{ id: string; name: string }>> {
    const normalizedPath = formPath.endsWith("/") ? formPath.slice(0, -1) : formPath;
    const timeoutMs = this.resolveReadTimeoutMs(requestOptions.timeoutMs);
    const response = await this.runReadRequest(
      `getActionButtons:${normalizedPath}`,
      () =>
        this.axiosInstance.get<RagicActionButtonMetadata>(
          `${normalizedPath}/metadata/actionButton`,
          {
            timeout: timeoutMs,
            params: {
              api: "true",
              category,
            },
          }
        ),
      requestOptions.priority ?? "user",
      { maxRetries: requestOptions.maxRetries, timeoutMs }
    );
    const buttons = response.data?.actionButtons ?? [];
    return buttons
      .map((button) => ({
        id: button?.id === undefined || button?.id === null ? "" : String(button.id),
        name: button?.name ? String(button.name) : "",
      }))
      .filter((button) => button.id.length > 0);
  }

  async executeActionButton(
    formPath: string,
    entryId: string,
    buttonId: string,
    onAttemptTiming?: (timing: RagicRequestAttemptTiming) => void
  ): Promise<RagicActionButtonExecutionResult> {
    const normalizedPath = formPath.endsWith("/")
      ? `${formPath}${entryId}`
      : `${formPath}/${entryId}`;
    const response = await this.runWriteRequest(
      `executeActionButton:${normalizedPath}`,
      () =>
        this.axiosInstance.post<RagicWriteResponse>(normalizedPath, null, {
          timeout: env.RAGIC_ACTION_BUTTON_TIMEOUT_MS,
          params: {
            api: "true",
            bId: buttonId,
          },
        }),
      onAttemptTiming
    );

    const status = String(response.data?.status ?? "").toUpperCase();
    if (status && status !== "SUCCESS" && status !== "WARN") {
      const code = response.data.code ? ` (code: ${response.data.code})` : "";
      const message = response.data.msg ? String(response.data.msg) : "Ragic 回傳執行按鈕錯誤";
      throw new UpstreamError(`${message}${code}`, "RAGIC_ACTION_BUTTON_FAILED");
    }

    this.clearFormCache(formPath);
    return {
      status,
      msg: response.data?.msg ? String(response.data.msg) : "",
      code: response.data?.code,
      raw: response.data,
    };
  }

  clearFormCache(formPath: string): void {
    const normalized = formPath.endsWith("/") ? formPath.slice(0, -1) : formPath;
    const variants = new Set<string>([formPath, normalized, `${normalized}/`]);

    for (const path of variants) {
      this.cache.del(`form:${path}`);
      this.clearInFlightReadByCacheKey(`form:${path}`);
      const pagePrefix = `form-page:${path}:`;
      const pageKeys = this.cache.keys().filter((key) => key.startsWith(pagePrefix));
      if (pageKeys.length > 0) {
        this.cache.del(pageKeys);
      }
      this.clearInFlightReadsByPrefix(pagePrefix);
      const entryPrefix = `entry:${path}:`;
      const entryKeys = this.cache.keys().filter((key) => key.startsWith(entryPrefix));
      if (entryKeys.length > 0) {
        this.cache.del(entryKeys);
      }
      this.clearInFlightReadsByPrefix(entryPrefix);
    }
    this.notifyFormCacheCleared(normalized);
  }

  clearCache(): void {
    this.globalCacheGeneration += 1;
    this.inFlightReads.clear();
    this.inFlightReadCacheKeys.clear();
    this.cacheGenerationByKey.clear();
    this.cache.flushAll();
    this.notifyFormCacheCleared();
  }

  onFormCacheCleared(listener: RagicFormCacheClearListener): () => void {
    this.formCacheClearListeners.add(listener);
    return () => {
      this.formCacheClearListeners.delete(listener);
    };
  }

  getRuntimeStats(): RagicRequestSchedulerStats {
    return ragicRequestScheduler.getStats();
  }

  private async runReadRequest<T>(
    label: string,
    request: (requestTimeoutMs?: number) => Promise<T>,
    priority: RagicReadPriority = "user",
    options: {
      maxRetries?: number;
      timeoutMs?: number;
      totalBudgetMs?: number;
      onAttemptTiming?: (timing: RagicRequestAttemptTiming) => void;
    } = {}
  ): Promise<T> {
    // Retry 包在外面：每次 attempt 自己 acquire/release lane slot，
    // backoff sleep 不會佔住 lane（避免 4 個 background slot 都進入 retry sleep
    // 時 callback / projection 全部排隊卡住）。
    //
    // 副作用：每次 attempt 失敗都算 breaker.recordFailure，比舊版 (整個
    // retry 結束才算一次) 更敏感。已調 RAGIC_CIRCUIT_FAILURE_THRESHOLD=10
    // 補償；對 Ragic 來說每次 attempt 是真實請求，breaker 對「Ragic 健康度」
    // 計數更準。寫入端 (runWriteRequest) 本來就是這個結構。
    const totalBudgetMs =
      typeof options.totalBudgetMs === "number" &&
      Number.isFinite(options.totalBudgetMs) &&
      options.totalBudgetMs > 0
        ? Math.trunc(options.totalBudgetMs)
        : null;
    const deadlineAt = totalBudgetMs === null ? null : Date.now() + totalBudgetMs;
    return runWithReadRetry(
      () => {
        const remainingBudgetMs =
          deadlineAt === null
            ? undefined
            : Math.max(1, deadlineAt - Date.now());
        return ragicRequestScheduler.runRead(label, request, priority, {
          overallTimeoutMs: remainingBudgetMs,
          onTiming: options.onAttemptTiming,
        });
      },
      {
        label,
        priority,
        timeoutMs: options.timeoutMs,
        maxRetries: options.maxRetries,
        overallTimeoutMs: totalBudgetMs ?? undefined,
        getSchedulerStats: () => ragicRequestScheduler.getStats(),
      }
    );
  }

  private async runWriteRequest<T>(
    label: string,
    request: () => Promise<T>,
    onAttemptTiming?: (timing: RagicRequestAttemptTiming) => void
  ): Promise<T> {
    return ragicRequestScheduler.runWrite(label, request, {
      onTiming: onAttemptTiming,
    });
  }

  private async runCacheableRead<T>(
    cacheKey: string,
    inFlightKey: string,
    useCache: boolean,
    load: () => Promise<T>
  ): Promise<T> {
    const cached = useCache ? this.cache.get<T>(cacheKey) : undefined;
    if (useCache && cached !== undefined) {
      return cached;
    }

    const resolveResult = (result: { value: T }) => result.value;
    const resolveSharedResult = (result: { value: T }) => this.cloneReadValue(result.value);

    const inFlight = this.inFlightReads.get(inFlightKey) as
      | Promise<{ value: T }>
      | undefined;
    if (inFlight) {
      return inFlight.then(resolveSharedResult);
    }

    const generation = this.getCacheGeneration(cacheKey);
    const promise = load()
      .then((value) => {
        let resultValue = value;
        if (
          useCache &&
          this.isCacheGenerationCurrent(cacheKey, generation) &&
          value !== null &&
          value !== undefined
        ) {
          this.cache.set(cacheKey, value);
          resultValue = this.cache.get<T>(cacheKey) ?? value;
        }
        return { value: resultValue };
      })
      .finally(() => {
        if (this.inFlightReads.get(inFlightKey) === promise) {
          this.inFlightReads.delete(inFlightKey);
          this.inFlightReadCacheKeys.delete(inFlightKey);
        }
      });
    this.inFlightReads.set(inFlightKey, promise);
    this.inFlightReadCacheKeys.set(inFlightKey, cacheKey);
    return promise.then(resolveResult);
  }

  private buildReadInFlightKey(
    cacheKey: string,
    useCache: boolean,
    priority: RagicReadPriority,
    timeoutMs: number,
    maxRetries: number | undefined,
    totalBudgetMs?: number
  ): string {
    const retryKey = maxRetries === undefined ? "retry:default" : `retry:${Math.max(0, maxRetries)}`;
    const budgetKey =
      totalBudgetMs === undefined
        ? "budget:default"
        : `budget:${Math.max(1, Math.trunc(totalBudgetMs))}`;
    return `${cacheKey}\0${useCache ? "cache" : "live"}\0${priority}\0${timeoutMs}\0${retryKey}\0${budgetKey}`;
  }

  private clearInFlightReadByCacheKey(cacheKey: string): void {
    this.bumpCacheGeneration(cacheKey);
    this.inFlightReads.delete(cacheKey);
    this.inFlightReadCacheKeys.delete(cacheKey);
    this.clearInFlightReadsByPrefix(`${cacheKey}\0`);
  }

  private clearInFlightReadsByPrefix(prefix: string): void {
    for (const key of this.inFlightReads.keys()) {
      if (key.startsWith(prefix)) {
        const cacheKey = this.inFlightReadCacheKeys.get(key);
        if (cacheKey) {
          this.bumpCacheGeneration(cacheKey);
        }
        this.inFlightReads.delete(key);
        this.inFlightReadCacheKeys.delete(key);
      }
    }
  }

  private getCacheGeneration(cacheKey: string): { global: number; key: number } {
    return {
      global: this.globalCacheGeneration,
      key: this.cacheGenerationByKey.get(cacheKey) ?? 0,
    };
  }

  private isCacheGenerationCurrent(
    cacheKey: string,
    generation: { global: number; key: number }
  ): boolean {
    const current = this.getCacheGeneration(cacheKey);
    return current.global === generation.global && current.key === generation.key;
  }

  private bumpCacheGeneration(cacheKey: string): void {
    this.cacheGenerationByKey.set(cacheKey, (this.cacheGenerationByKey.get(cacheKey) ?? 0) + 1);
  }

  private notifyFormCacheCleared(formPath?: string): void {
    for (const listener of this.formCacheClearListeners) {
      try {
        listener(formPath);
      } catch (error) {
        console.warn("[ragic-client][cache-clear-listener-failed]", {
          formPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private cloneReadValue<T>(value: T): T {
    if (value === null || typeof value !== "object") {
      return value;
    }
    return structuredClone(value);
  }

  private resolveReadTimeoutMs(timeoutMs?: number): number {
    const resolved =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
        ? timeoutMs
        : env.RAGIC_READ_TIMEOUT_MS;
    return Math.max(1_000, Math.trunc(resolved));
  }
}

export interface RagicClientDemoExtensions {
  reset?(): void;
  getDemoMetadata?(): {
    lastResetAt: string | null;
    maxEntriesPerForm: number | null;
    buckets: Array<{ formPath: string; entries: number; seeded: number }>;
  };
  getFaultInjection?(): { enabled: boolean };
}

function createRagicClient(): RagicClient {
  if (env.DEMO_MODE) {
    console.info("[ragic-client] DEMO_MODE=true → using MockRagicClient with in-memory fixture");
    return new MockRagicClient(buildDemoFixture()) as unknown as RagicClient;
  }
  return new RagicClient();
}

export const ragicClient = createRagicClient() as RagicClient & RagicClientDemoExtensions;
