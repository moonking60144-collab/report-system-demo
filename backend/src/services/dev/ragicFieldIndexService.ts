import axios, { type AxiosInstance } from "axios";
import { env } from "../../config/env";
import { ragicRequestScheduler } from "../../infra/ragicRequestScheduler";
import { runWithReadRetry } from "../../infra/ragicReadRetry";
import {
  ragicFieldIndexRepository,
  type RagicFieldIndexRepository,
} from "../../storage/sqlite/ragicFieldIndexRepository";
import {
  flattenParsedFormsToInsertRows,
  parseRagicDocHtml,
  type ParseHealth,
} from "./ragicFieldDocParser";
import {
  getProgress,
  patchProgress,
  resetProgress,
  setProgress,
  type RefreshProgress,
} from "./ragicFieldIndexProgress";
import { createLogger } from "../../observability/logger";

const log = createLogger("ragic-field-index");

/**
 * 抓 Ragic /sims/doc.jsp HTML、parse、寫進 SQLite。
 *
 * State 反映進度：
 *   idle → refreshing → ready / error
 *
 * 設計重點（review feedback 收斂）：
 *   1. 透過 ragicRequestScheduler.runRead("background") + runWithReadRetry
 *      → 跟其他 Ragic 呼叫共用 lane 治理（token bucket / circuit breaker / retry）
 *   2. 只有 parser health.ok 才呼叫 replaceAll，避免「Ragic doc 變動 → 0 結果 → 靜默清空」
 *   3. 監控 HTML size（warn / fail 上限），catch Ragic 改版增大或截斷
 */

const SIZE_WARN_BYTES = 30 * 1024 * 1024;
const SIZE_FAIL_BYTES = 45 * 1024 * 1024;

export interface RagicFieldIndexService {
  refresh(): Promise<{ totalForms: number; totalFields: number }>;
  /** 讀目前 in-memory refresh 進度；非 refreshing 時回 null */
  getProgress(): RefreshProgress | null;
}

export function createRagicFieldIndexService(options?: {
  repository?: RagicFieldIndexRepository;
  fetchDocHtml?: () => Promise<string>;
}): RagicFieldIndexService {
  const repository = options?.repository ?? ragicFieldIndexRepository;
  const fetchDocHtml = options?.fetchDocHtml ?? defaultFetchDocHtml;

  return {
    getProgress,
    async refresh() {
      // 注意：這裡不再 setState('refreshing')。Route 用 claimRefresh()
      // atomic 抓到 lock 後才會呼叫此 method；service 只負責進行 + 結算。
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();
      setProgress({
        phase: "downloading",
        downloadedBytes: 0,
        totalBytes: null,
        startedAt: startedAtIso,
      });
      try {
        const html = await fetchDocHtml();
        const sizeBytes = Buffer.byteLength(html, "utf8");
        log.info({
          event: "doc-fetch.done",
          length: html.length,
          sizeBytes,
          elapsedMs: Date.now() - startedAt,
        });

        if (sizeBytes >= SIZE_FAIL_BYTES) {
          throw new Error(
            `doc.jsp 過大 (${sizeBytes} bytes)，超過 ${SIZE_FAIL_BYTES} cap，疑似被截斷或格式異常`
          );
        }
        if (sizeBytes >= SIZE_WARN_BYTES) {
          log.warn({ event: "doc-fetch.size-warn", sizeBytes });
        }

        setProgress({
          phase: "parsing",
          downloadedBytes: sizeBytes,
          totalBytes: sizeBytes,
          startedAt: startedAtIso,
        });
        const parsed = parseRagicDocHtml(html);
        if (!parsed.health.ok) {
          // 不要清表！保留上一次的好資料
          throw buildParserHealthError(parsed.health);
        }

        const rows = flattenParsedFormsToInsertRows(parsed.forms);
        const refreshedAt = new Date().toISOString();
        setProgress({
          phase: "writing",
          downloadedBytes: sizeBytes,
          totalBytes: sizeBytes,
          startedAt: startedAtIso,
        });
        const counts = await repository.replaceAll(rows, refreshedAt);

        await repository.setState({
          status: "ready",
          refreshedAt,
          totalForms: counts.totalForms,
          totalFields: counts.totalFields,
          message: parsed.health.warnings.length
            ? `parsed with warnings: ${parsed.health.warnings.join("; ")}`
            : null,
        });
        log.info({
          event: "refresh.done",
          totalForms: counts.totalForms,
          totalFields: counts.totalFields,
          warnings: parsed.health.warnings.length,
        });
        resetProgress();
        return counts;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "ragic doc refresh failed";
        resetProgress();
        await repository.setState({ status: "error", message });
        log.error({ event: "refresh.failed", error: message });
        throw error;
      }
    },
  };
}

function buildParserHealthError(health: ParseHealth): Error {
  const detail = health.warnings.join("; ");
  return new Error(
    `parser 看起來不健康（不寫入 SQLite，保留上一次資料）: ${detail || "0 forms parsed"}`
  );
}

let docHttpClient: AxiosInstance | null = null;

function getDocHttpClient(): AxiosInstance {
  if (!docHttpClient) {
    docHttpClient = axios.create({
      baseURL: `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`,
      timeout: 60_000,
      headers: { Authorization: `Basic ${env.RAGIC_API_KEY}` },
      responseType: "text",
      transformResponse: [(d) => d],
      maxContentLength: SIZE_FAIL_BYTES,
    });
  }
  return docHttpClient;
}

/**
 * 走 ragicRequestScheduler.runRead("background") + retry 包裝。
 * 跟 user / sync 流量共用 token bucket 跟 breaker，避免漏網的 ad-hoc 呼叫。
 *
 * onDownloadProgress 拿到的 loaded/total 會 patch 到 in-memory progress，
 * 讓前端透過 GET /state 顯示下載進度條。
 */
async function defaultFetchDocHtml(): Promise<string> {
  return ragicRequestScheduler.runRead(
    "ragic-doc-fetch",
    () =>
      runWithReadRetry(
        async () => {
          const res = await getDocHttpClient().get("/sims/doc.jsp?a=default", {
            onDownloadProgress: (event) => {
              const loaded =
                typeof event.loaded === "number" && Number.isFinite(event.loaded)
                  ? event.loaded
                  : 0;
              const total =
                typeof event.total === "number" &&
                Number.isFinite(event.total) &&
                event.total > 0
                  ? event.total
                  : null;
              patchProgress({
                downloadedBytes: loaded,
                totalBytes: total,
              });
            },
          });
          return String(res.data ?? "");
        },
        { label: "ragic-doc-fetch" }
      ),
    "background"
  );
}

export const ragicFieldIndexService = createRagicFieldIndexService();
