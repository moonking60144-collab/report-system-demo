import { createHash } from "node:crypto";
import axios, { type AxiosInstance } from "axios";
import { env } from "../../config/env";
import { ragicRequestScheduler } from "../../infra/ragicRequestScheduler";
import { runWithReadRetry } from "../../infra/ragicReadRetry";
import {
  ragicFieldIndexRepository,
  type RagicFieldIndexInsertInput,
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
 *   4. 支援 AbortSignal：refresh() 接受 signal，在各 phase 邊界檢查；
 *      被中止時 throw DOMException(name='AbortError')，repository state 設成 'idle'
 */

const SIZE_WARN_BYTES = 30 * 1024 * 1024;
const SIZE_FAIL_BYTES = 45 * 1024 * 1024;

export interface RagicFieldIndexService {
  refresh(options?: {
    signal?: AbortSignal;
    /**
     * 觸發來源。"auto"（背景排程）失敗時 settle 成非 error 狀態，保留上一次好資料、
     * 不讓 UI 紅字嚇人；"manual"（route 觸發）失敗維持 status:'error'。預設 "manual"。
     */
    source?: "auto" | "manual";
  }): Promise<{ totalForms: number; totalFields: number }>;
  /** 讀目前 in-memory refresh 進度；非 refreshing 時回 null */
  getProgress(): RefreshProgress | null;
}

/**
 * 判斷 abort signal 是否已觸發；觸發則 throw DOMException(AbortError)。
 * 在各 phase 邊界呼叫，讓 route handler 區分「正常失敗」vs「使用者中止」。
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (signal.aborted) {
    // Web 標準 AbortError：name === 'AbortError'，route handler 用 name 判斷
    const err = new DOMException("refresh aborted", "AbortError");
    throw err;
  }
}

// ASCII 控制字元當分隔符：0x1F (Unit Separator) 隔欄、0x1E (Record Separator) 隔列。
// 不可能出現在 doc.jsp 的 HTML 文字欄位（欄位名 / 備註 / path）裡，杜絕
// 「'a','bc' 與 'ab','c' 撞同一 canonical string」的分隔符塌縮碰撞。
const FIELD_SEP = "\x1f";
const ROW_SEP = "\x1e";

/**
 * 每欄正規化：null / undefined / 缺欄全部塌成空字串，再 NFC normalize。
 *
 *   - flatten row 用 null，repository InsertInput 把 subtableName / subtableKey /
 *     fieldPos / fieldType / fieldNote 標成 optional（可能 undefined），DB 讀回是
 *     null → 三者塌成同一值，否則同一份資料在不同 code path 算出不同 hash。
 *   - NFC：Ragic 欄位名 / 備註含中文，doc.jsp 來源若混 NFC/NFD 會讓視覺相同
 *     的字 byte 不同 → hash 漂。統一成 NFC。
 *   - 不額外 trim：parser cellTextWithBrSeparator 已 collapse+trim，二次處理會讓
 *     hash 與真正寫進 DB 的 rows 語意分叉。
 */
function normalizeField(value: string | null | undefined): string {
  return ((value ?? "") + "").normalize("NFC");
}

// canonical string 內 10 欄的固定順序（刻意不含 refreshedAt——它是 per-refresh
// timestamp，另外傳給 replaceAll，天然排除）。precompute 時依此序填入 fields[]。
// 索引：0 formPath, 1 formName, 2 scope, 3 subtableName, 4 subtableKey,
//       5 fieldPos, 6 fieldName, 7 fieldId, 8 fieldType, 9 fieldNote
//
// compareRows 的 9-key 排序順序映射到上面這些索引（語意完全沿用既有 comparator）：
// formPath(0) → scope(2) → subtableKey(4) → subtableName(3) → fieldId(7) →
// fieldPos(5) → fieldName(6) → fieldType(8) → fieldNote(9)。
const COMPARE_ORDER = [0, 2, 4, 3, 7, 5, 6, 8, 9] as const;

/**
 * 把一列 flatten row 的 10 欄一次正規化（每欄 NFC、null/undefined 塌成空字串）。
 * 回傳 { fields, canonical }：
 *   - fields：依 canonical 順序排好的 10 個正規化字串，供 comparator 直接索引比較
 *   - canonical：fields 以 FIELD_SEP join + ROW_SEP，與舊 canonicalRow 逐 byte 相同
 *
 * 重點：normalize 在這裡對每欄只跑一次（10×N 次），取代舊版 comparator 每次比較
 * 重算（O(N log N × 9)）+ canonicalRow 再算一遍（10×N），把 normalize 從 ~34M 次
 * 砍到 ~1M 次。輸出值不變 → hash 與排序結果逐 byte 相同。
 */
function precomputeRow(row: RagicFieldIndexInsertInput): {
  fields: string[];
  canonical: string;
} {
  const fields = [
    normalizeField(row.formPath),
    normalizeField(row.formName),
    normalizeField(row.scope),
    normalizeField(row.subtableName),
    normalizeField(row.subtableKey),
    normalizeField(row.fieldPos),
    normalizeField(row.fieldName),
    normalizeField(row.fieldId),
    normalizeField(row.fieldType),
    normalizeField(row.fieldNote),
  ];
  return { fields, canonical: fields.join(FIELD_SEP) + ROW_SEP };
}

/**
 * 對 flatten rows 算 canonical string 的 streaming sha1 hex。
 *
 * 排序語意（沿用舊 compareRows，逐 byte 等價，只是改成讀預先正規化好的值）：
 * 用「正規化後字串的 code-unit 比較」，不用 localeCompare——localeCompare 受
 * ICU/locale 影響，跨機器 / 跨 Node 版本可能不同序，破壞跨環境穩定性。
 * 顯式 sort 讓 hash 不依賴 parser/DOM 走訪順序這個隱性契約。
 * key 順序見 COMPARE_ORDER；納入 subtableName 是關鍵：parser 在 doc.jsp 沒暴露
 * 子表 Key 時 subtableKey=null、以合成名「子表 #N」當 subtableName，少了它兩個
 * null-key 子表會撞、不成 total order → 排序不穩 → hash 不穩。fieldName/Type/Note
 * 做最後 tie-break，不 fallback 到 JS stable-sort 的輸入順序這個隱性契約。
 *
 * streaming（每列 update 後即可 GC）比 JSON.stringify 整個 ~11MB 陣列再 hash
 * 的記憶體 footprint 平很多。開頭餵入列數防「全空列 vs 0 列」撞同一 digest。
 *
 * 沿用 sha1（非 sha256）對齊既有 doc_hash 欄位語意；偵測欄位定義變動是非對抗
 * 場景，碰撞風險可忽略。
 *
 * fail-open：算 hash 不該失敗，但若真的 throw（OOM / crypto 異常）由 caller 包
 * try/catch → newEntriesHash=null → 自然 fail skip 條件 → 走 full refresh。
 */
function computeEntriesHash(rows: RagicFieldIndexInsertInput[]): string {
  const decorated = rows.map(precomputeRow);
  decorated.sort((a, b) => {
    for (const idx of COMPARE_ORDER) {
      const av = a.fields[idx]!;
      const bv = b.fields[idx]!;
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
  const hash = createHash("sha1");
  hash.update(decorated.length + ROW_SEP);
  for (const row of decorated) {
    hash.update(row.canonical, "utf8");
  }
  return hash.digest("hex");
}

export function createRagicFieldIndexService(options?: {
  repository?: RagicFieldIndexRepository;
  fetchDocHtml?: (signal?: AbortSignal) => Promise<string>;
}): RagicFieldIndexService {
  const repository = options?.repository ?? ragicFieldIndexRepository;
  const fetchDocHtml = options?.fetchDocHtml ?? defaultFetchDocHtml;

  return {
    getProgress,
    async refresh(refreshOptions) {
      const signal = refreshOptions?.signal;
      const source = refreshOptions?.source ?? "manual";
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
        throwIfAborted(signal);
        // 在 fetch 之前讀 prior state：claimRefresh 已把 status 改成 'refreshing'，
        // 但 lastDocHash（上次 parsed entries 的 sha1）/ totalFields / totalForms
        // 是 setState patch 語意保留的舊值，可以拿來判斷「上一次有沒有成功」。
        const priorState = await repository.getState();
        const html = await fetchDocHtml(signal);
        throwIfAborted(signal);
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

        // Entries hash skip：hash input 是 parsed entries（不是 raw HTML），所以
        // 「必須先 parse 才知道 hash」，skip 點在 parse + flatten 之後、replaceAll 之前。
        // 好處：doc.jsp 動態雜訊（廣告 timestamp、隨機 comment）不再讓 hash 漂，
        // 只有「欄位定義」真正變動才走 full replaceAll。
        //
        // Parsing phase：parseRagicDocHtml 是 sync cheerio，沒有逐 form callback。
        // 進入時設 parsedForms=0/totalForms=null，跑完後 patch 成 N/N，前端有
        // 「parsing 階段 N forms 解析中」的回饋。所有路徑（含 skip）都會真的 parse。
        setProgress({
          phase: "parsing",
          parsedForms: 0,
          totalForms: null,
          startedAt: startedAtIso,
        });
        const parsed = parseRagicDocHtml(html);
        throwIfAborted(signal);
        // Gate 0（前置，非 skip 專屬）：health 不 ok 直接 throw，根本不進
        // hash / skip 判斷——絕不能因為「壞 parse 算出某個穩定 hash」而 skip 掉
        // 真實變動或清空好資料。這條擋在 hash 計算之前。
        if (!parsed.health.ok) {
          // 不要清表！保留上一次的好資料
          throw buildParserHealthError(parsed.health);
        }
        const totalForms = parsed.forms.length;
        patchProgress({ phase: "parsing", parsedForms: totalForms, totalForms });

        const rows = flattenParsedFormsToInsertRows(parsed.forms);

        // 對排序後的 flatten rows 算 streaming sha1。fail-open：
        // crypto throw → newEntriesHash=null → gate 1 自然 fail → 走 full refresh。
        let newEntriesHash: string | null = null;
        try {
          newEntriesHash = computeEntriesHash(rows);
        } catch (hashError) {
          // 理論上不會發生；記 log 但不擋 refresh
          log.warn({
            event: "refresh.hash-compute-failed",
            error: hashError instanceof Error ? hashError.message : String(hashError),
          });
          newEntriesHash = null;
        }

        // Two-gate 設計（health gate 已過）：
        //   gate 1（cheap pre-filter）：env 開、hash 都存在且相等
        //   gate 2（defense-in-depth）：repository.countAll() 真實掃表 > 0
        // state row 的 total_fields 可能因為 WAL 復原 / partial commit drift 跟實表不同步，
        // 所以即使 hash 對得上，仍要走一次 countAll 確認資料還在才 skip。
        const hashGatePassed =
          env.RAGIC_FIELD_INDEX_HASH_SKIP &&
          newEntriesHash !== null &&
          priorState.lastDocHash !== null &&
          newEntriesHash === priorState.lastDocHash;

        if (hashGatePassed) {
          const counts = await repository.countAll();
          if (counts.totalFields > 0) {
            throwIfAborted(signal);
            // 跳過 replaceAll：直接把 progress 從 parsing 推到 writing 100%、
            // state 寫回 ready。totalForms/totalFields 用 countAll 真實值。
            const skippedRefreshedAt = new Date().toISOString();
            setProgress({
              phase: "writing",
              writtenFields: counts.totalFields,
              totalFields: counts.totalFields,
              startedAt: startedAtIso,
            });
            await repository.setState({
              status: "ready",
              refreshedAt: skippedRefreshedAt,
              totalForms: counts.totalForms,
              totalFields: counts.totalFields,
              message: "no-changes-skipped",
              // 重寫一次 hash，updated_at 跟 refreshed_at 都會更新
              lastDocHash: newEntriesHash,
            });
            throwIfAborted(signal);
            log.info({
              event: "refresh.skipped",
              reason: "entries-hash-match",
              totalForms: counts.totalForms,
              totalFields: counts.totalFields,
              elapsedMs: Date.now() - startedAt,
            });
            // 主索引沒變 → 邊通常也沒變，不重算（保留 skip 的省時）。
            // 唯一例外：首次升級邊表還空，補建一次。
            await rebuildEdgesIfEmpty(repository, skippedRefreshedAt);
            resetProgress();
            return counts;
          }
          // hash 對但 countAll = 0 → state row drift，繼續走 full refresh
          log.warn({
            event: "refresh.hash-skip-rejected",
            reason: "countAll-zero",
            priorTotalFields: priorState.totalFields,
          });
        }

        const refreshedAt = new Date().toISOString();
        // Writing phase：repository.replaceAll 是單一 transaction，沒有 per-chunk
        // callback。先設 writtenFields=0/totalFields=rows.length，replaceAll 完
        // 成後 patch 成 totalFields/totalFields。前端 UI 至少能看到「正在寫入
        // 資料庫 N 筆」的 indeterminate 段落，而非卡在 parsing 100%。
        setProgress({
          phase: "writing",
          writtenFields: 0,
          totalFields: rows.length,
          startedAt: startedAtIso,
        });
        throwIfAborted(signal);
        const counts = await repository.replaceAll(rows, refreshedAt);
        throwIfAborted(signal);
        patchProgress({
          phase: "writing",
          writtenFields: counts.totalFields,
          totalFields: counts.totalFields,
        });

        await repository.setState({
          status: "ready",
          refreshedAt,
          totalForms: counts.totalForms,
          totalFields: counts.totalFields,
          message: parsed.health.warnings.length
            ? `parsed with warnings: ${parsed.health.warnings.join("; ")}`
            : null,
          // 寫回這次 parsed entries 的 hash，下一次 refresh 就能比對 skip。
          // hash 計算 fail-open 時為 null，依然寫進 DB（清掉舊值），
          // 下一次 priorState.lastDocHash === null 自然 fail skip 條件 → 走 full refresh。
          lastDocHash: newEntriesHash,
        });
        log.info({
          event: "refresh.done",
          totalForms: counts.totalForms,
          totalFields: counts.totalFields,
          warnings: parsed.health.warnings.length,
        });
        // 主索引已換新 → 依賴邊一定重建（衍生資料，失敗不影響主 refresh）
        await rebuildEdgesSafely(repository, refreshedAt);
        resetProgress();
        return counts;
      } catch (error) {
        const isAbort =
          error instanceof DOMException && error.name === "AbortError";
        const message =
          error instanceof Error
            ? error.message
            : isAbort
              ? "refresh aborted"
              : "ragic doc refresh failed";
        resetProgress();
        if (isAbort) {
          // 使用者主動中止：state 回到 'idle'，message 記錄中止以利除錯，
          // 不算 'error'（避免 UI 紅字嚇人）
          await repository.setState({
            status: "idle",
            message: "refresh 已被使用者中止",
          });
          log.info({ event: "refresh.aborted" });
        } else if (source === "auto") {
          // 背景排程失敗：沿用 abort 的 downgrade 策略——status 回 'idle'（非
          // 'error' 紅字），保留上一次好資料可見，下一次 claim 能正常接續。
          // message 帶可辨識前綴讓 ops 還能在 state 看到失敗原因。log.error 照記。
          await repository.setState({
            status: "idle",
            message: "background-refresh-failed: " + message,
          });
          log.error({ event: "refresh.failed", source, error: message });
        } else {
          await repository.setState({ status: "error", message });
          log.error({ event: "refresh.failed", source, error: message });
        }
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

/**
 * 重建依賴邊。邊是衍生資料：失敗只 log，不讓主索引 refresh 算失敗
 * （主索引已成功寫入，邊缺了下一次 refresh 會補）。
 */
async function rebuildEdgesSafely(
  repository: RagicFieldIndexRepository,
  refreshedAt: string
): Promise<void> {
  try {
    const r = await repository.rebuildEdges(refreshedAt);
    log.info({
      event: "edges.rebuilt",
      totalEdges: r.totalEdges,
      dataEdges: r.dataEdges,
      sideEffectEdges: r.sideEffectEdges,
      resolvedEdges: r.resolvedEdges,
      brokenEdges: r.brokenEdges,
    });
  } catch (error) {
    log.warn({
      event: "edges.rebuild-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 邊表為空時才重建（升級後首次 refresh 剛好 hash-skip 的補救路徑）*/
async function rebuildEdgesIfEmpty(
  repository: RagicFieldIndexRepository,
  refreshedAt: string
): Promise<void> {
  try {
    const stats = await repository.getEdgeStats();
    if (stats.totalData + stats.totalSideEffect === 0) {
      await rebuildEdgesSafely(repository, refreshedAt);
    }
  } catch (error) {
    log.warn({
      event: "edges.rebuild-check-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let docHttpClient: AxiosInstance | null = null;
const DOC_FETCH_TIMEOUT_MS = 60_000;

function resolveAdminApiKey(): string {
  // /sims/doc.jsp 是 Ragic admin tool endpoint，service account 多半沒權限。
  // 優先用 ADMIN_API_KEY（個人帳號 key），沒設 fallback 到 RAGIC_API_KEY
  // 維持向後相容（換 service account 前的環境不需設這條）。
  return env.ADMIN_API_KEY || env.RAGIC_API_KEY;
}

function getDocHttpClient(): AxiosInstance {
  if (!docHttpClient) {
    docHttpClient = axios.create({
      baseURL: `${env.RAGIC_PROTOCOL}://${env.RAGIC_DOMAIN}`,
      timeout: DOC_FETCH_TIMEOUT_MS,
      headers: { Authorization: `Basic ${resolveAdminApiKey()}` },
      responseType: "text",
      transformResponse: [(d) => d],
      maxContentLength: SIZE_FAIL_BYTES,
    });
  }
  return docHttpClient;
}

/**
 * 走 ragicRequestScheduler.runRead("background") + retry 包裝。
 * 走 background token bucket 跟 breaker，避免漏網的 ad-hoc 呼叫繞過治理；
 * 同時不吃掉 user/write 的前景預算。
 *
 * onDownloadProgress 拿到的 loaded/total 會 patch 到 in-memory progress，
 * 讓前端透過 GET /state 顯示下載進度條。
 *
 * 接受 AbortSignal：axios 的 signal option 會把 fetch 中止映射到
 * CanceledError，外層 service 重新包成 AbortError 統一處理。
 */
async function defaultFetchDocHtml(signal?: AbortSignal): Promise<string> {
  return ragicRequestScheduler.runRead(
    "ragic-doc-fetch",
    () =>
      runWithReadRetry(
        async () => {
          try {
            const res = await getDocHttpClient().get("/sims/doc.jsp?a=default", {
              signal,
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
                  phase: "downloading",
                  downloadedBytes: loaded,
                  totalBytes: total,
                });
              },
            });
            // 診斷：確認 Ragic doc.jsp 回傳有沒有 gzip。axios 已預設
            // decompress:true + 送 Accept-Encoding: gzip，client 端無得再優化；
            // 這行 log 揭露 server 端到底有沒有壓縮，決定 fetch 那段是不是極限。
            log.info({
              event: "doc-fetch.transport",
              contentEncoding: res.headers?.["content-encoding"] ?? "(none)",
              contentLength: res.headers?.["content-length"] ?? "(none)",
              decodedBytes: Buffer.byteLength(String(res.data ?? ""), "utf8"),
            });
            return String(res.data ?? "");
          } catch (error) {
            // axios 把 abort 包成 CanceledError，name = 'CanceledError'。
            // 統一翻譯成 DOMException AbortError，外層用 name 判斷
            if (axios.isCancel(error)) {
              throw new DOMException("refresh aborted", "AbortError");
            }
            throw error;
          }
        },
        {
          label: "ragic-doc-fetch",
          priority: "background",
          timeoutMs: DOC_FETCH_TIMEOUT_MS,
          getSchedulerStats: () => ragicRequestScheduler.getStats(),
        }
      ),
    "background"
  );
}

export const ragicFieldIndexService = createRagicFieldIndexService();
