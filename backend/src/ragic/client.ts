import axios, { AxiosInstance } from "axios";
import NodeCache from "node-cache";
import { env } from "../config/env";
import { runWithReadRetry } from "../infra/ragicReadRetry";
import { runWithWriteRetry } from "../infra/ragicWriteRetry";
import {
  ragicRequestScheduler,
  RagicRequestSchedulerStats,
  type RagicReadPriority,
} from "../infra/ragicRequestScheduler";
import { HttpError, UpstreamError } from "../utils/httpError";

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

const RAGIC_PAGE_SIZE = 1000;

interface RagicWriteResponse extends RagicRecord {
  status?: string;
  msg?: string;
  code?: number | string;
}

interface RagicPageQuery {
  limit: number;
  offset: number;
  /** 單條件字串或多條件陣列（axios 會串成多個 where= 參數，Ragic 視為 AND） */
  where?: string | string[];
  fts?: string;
}

interface RagicReadRequestOptions {
  timeoutMs?: number;
  priority?: RagicReadPriority;
  maxRetries?: number;
}

interface RagicActionButtonItem {
  id?: string | number;
  name?: string;
}

interface RagicActionButtonMetadata extends RagicRecord {
  actionButtons?: RagicActionButtonItem[];
}

function isRagicRecord(value: unknown): value is RagicRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RagicClient {
  private readonly axiosInstance: AxiosInstance;
  private readonly cache: NodeCache;

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
    if (useCache) {
      const cached = this.cache.get<RagicFormData>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const merged: RagicFormData = {};
    let offset = 0;

    while (true) {
      const response = await this.runReadRequest(
        `getFormData:${formPath}`,
        () =>
          this.axiosInstance.get<RagicFormData>(formPath, {
            timeout: this.resolveReadTimeoutMs(requestOptions.timeoutMs),
            params: { api: "true", offset },
          }),
        requestOptions.priority ?? "user",
        { maxRetries: requestOptions.maxRetries }
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

    if (useCache) {
      this.cache.set(cacheKey, merged);
    }

    return merged;
  }

  async getFormPage(
    formPath: string,
    query: RagicPageQuery,
    useCache = true,
    requestOptions: RagicReadRequestOptions = {}
  ): Promise<RagicFormData> {
    const whereKey = Array.isArray(query.where) ? query.where.join("|") : (query.where ?? "");
    const cacheKey = `form-page:${formPath}:${query.limit}:${query.offset}:${whereKey}:${query.fts ?? ""}`;
    if (useCache) {
      const cached = this.cache.get<RagicFormData>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const response = await this.runReadRequest(
      `getFormPage:${formPath}`,
      () =>
        this.axiosInstance.get<RagicFormData>(formPath, {
          timeout: this.resolveReadTimeoutMs(requestOptions.timeoutMs),
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
      requestOptions.priority ?? "user",
      { maxRetries: requestOptions.maxRetries }
    );

    const container = response.data as RagicRecord;
    const nested = container?.data;
    if (isRagicRecord(nested)) {
      const pageData = nested as RagicFormData;
      if (useCache) {
        this.cache.set(cacheKey, pageData);
      }
      return pageData;
    }
    if (useCache) {
      this.cache.set(cacheKey, response.data);
    }
    return response.data;
  }

  async getEntry(
    formPath: string,
    entryId: string,
    useCache = true,
    requestOptions: RagicReadRequestOptions = {}
  ): Promise<RagicRecord | null> {
    const cacheKey = `entry:${formPath}:${entryId}`;
    if (useCache) {
      const cached = this.cache.get<RagicRecord>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const normalizedPath = formPath.endsWith("/")
      ? `${formPath}${entryId}`
      : `${formPath}/${entryId}`;

    const response = await this.runReadRequest(
      `getEntry:${normalizedPath}`,
      () =>
        this.axiosInstance.get<RagicRecord>(normalizedPath, {
          timeout: this.resolveReadTimeoutMs(requestOptions.timeoutMs),
          params: { api: "true" },
        }),
      requestOptions.priority ?? "user",
      { maxRetries: requestOptions.maxRetries }
    );

    const payload = response.data?.data ?? response.data;
    if (!isRagicRecord(payload)) {
      return null;
    }

    if ("_ragicId" in payload || "_ragic_id" in payload) {
      if (useCache) {
        this.cache.set(cacheKey, payload);
      }
      return payload;
    }

    const directMatch = payload[entryId];
    if (isRagicRecord(directMatch)) {
      if (useCache) {
        this.cache.set(cacheKey, directMatch);
      }
      return directMatch;
    }

    const keys = Object.keys(payload).filter((key) => !key.startsWith("_"));
    if (keys.length === 1 && isRagicRecord(payload[keys[0]])) {
      const single = payload[keys[0]] as RagicRecord;
      if (useCache) {
        this.cache.set(cacheKey, single);
      }
      return single;
    }

    return null;
  }

  async updateEntry(
    formPath: string,
    entryId: string,
    payload: RagicRecord,
    method: RagicWriteMethod = "PATCH",
    writeOptions: boolean | RagicWriteOptions = true
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
        this.runWriteRequest(`updateEntry:${normalizedPath}`, () =>
          this.axiosInstance.request<RagicWriteResponse>({
            url: normalizedPath,
            method,
            timeout: env.RAGIC_WRITE_TIMEOUT_MS,
            params: requestParams,
            data: payload,
            headers: {
              "Content-Type": "application/json",
            },
          })
        ),
      {
        label: `updateEntry:${normalizedPath}`,
      }
    );

    const status = String(response.data?.status ?? "").toUpperCase();
    if (status && status !== "SUCCESS") {
      const code = response.data.code ? ` (code: ${response.data.code})` : "";
      const message = response.data.msg ? String(response.data.msg) : "Ragic 回傳寫入錯誤";
      throw new UpstreamError(`${message}${code}`, "RAGIC_WRITE_FAILED");
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
        const code = response.data.code ? ` (code: ${response.data.code})` : "";
        const message = response.data.msg ? String(response.data.msg) : "Ragic 回傳寫入錯誤";
        throw new UpstreamError(`${message}${code}`, "RAGIC_WRITE_FAILED");
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
    const response = await this.runReadRequest(
      `getActionButtons:${normalizedPath}`,
      () =>
        this.axiosInstance.get<RagicActionButtonMetadata>(
          `${normalizedPath}/metadata/actionButton`,
          {
            timeout: this.resolveReadTimeoutMs(requestOptions.timeoutMs),
            params: {
              api: "true",
              category,
            },
          }
        ),
      requestOptions.priority ?? "user",
      { maxRetries: requestOptions.maxRetries }
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
    buttonId: string
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
        })
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
      const pagePrefix = `form-page:${path}:`;
      const pageKeys = this.cache.keys().filter((key) => key.startsWith(pagePrefix));
      if (pageKeys.length > 0) {
        this.cache.del(pageKeys);
      }
      const entryPrefix = `entry:${path}:`;
      const entryKeys = this.cache.keys().filter((key) => key.startsWith(entryPrefix));
      if (entryKeys.length > 0) {
        this.cache.del(entryKeys);
      }
    }
  }

  clearCache(): void {
    this.cache.flushAll();
  }

  getRuntimeStats(): RagicRequestSchedulerStats {
    return ragicRequestScheduler.getStats();
  }

  private async runReadRequest<T>(
    label: string,
    request: () => Promise<T>,
    priority: RagicReadPriority = "user",
    options: { maxRetries?: number } = {}
  ): Promise<T> {
    // Retry 包在外面：每次 attempt 自己 acquire/release lane slot，
    // backoff sleep 不會佔住 lane（避免 4 個 background slot 都進入 retry sleep
    // 時 callback / projection 全部排隊卡住）。
    //
    // 副作用：每次 attempt 失敗都算 breaker.recordFailure，比舊版 (整個
    // retry 結束才算一次) 更敏感。已調 RAGIC_CIRCUIT_FAILURE_THRESHOLD=10
    // 補償；對 Ragic 來說每次 attempt 是真實請求，breaker 對「Ragic 健康度」
    // 計數更準。寫入端 (runWriteRequest) 本來就是這個結構。
    return runWithReadRetry(
      () => ragicRequestScheduler.runRead(label, request, priority),
      { label, maxRetries: options.maxRetries }
    );
  }

  private async runWriteRequest<T>(
    label: string,
    request: () => Promise<T>
  ): Promise<T> {
    return ragicRequestScheduler.runWrite(label, request);
  }

  private resolveReadTimeoutMs(timeoutMs?: number): number {
    const resolved =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
        ? timeoutMs
        : env.RAGIC_READ_TIMEOUT_MS;
    return Math.max(1_000, Math.trunc(resolved));
  }
}

import { MockRagicClient } from "./mockClient";
import { buildDemoFixture } from "./demoFixture";

/**
 * Demo-only 介面延伸：在 DEMO_MODE=true 時，runtime 的實際物件是 MockRagicClient，
 * 帶有 reset() / getDemoMetadata() / setFaultInjection() 等只在 demo 場景需要的方法。
 * Production 走真實 RagicClient，這些 method 不存在 → 用 optional 形 cast 進去。
 */
export interface RagicClientDemoExtensions {
  reset?(): void;
  getDemoMetadata?(): {
    lastResetAt: string;
    maxEntriesPerForm: number;
    buckets: Array<{ formPath: string; entries: number; seeded: number }>;
  };
  setFaultInjection?(spec: unknown): void;
  getFaultInjection?(): { enabled: boolean };
}

function createRagicClient(): RagicClient {
  if (env.DEMO_MODE) {
    console.info("[ragic-client] DEMO_MODE=true → using MockRagicClient with in-memory fixture");
    // MockRagicClient 對外提供與 RagicClient 同形的方法（duck typing），用結構轉型放行
    return new MockRagicClient(buildDemoFixture()) as unknown as RagicClient;
  }
  return new RagicClient();
}

export const ragicClient = createRagicClient() as RagicClient & RagicClientDemoExtensions;
