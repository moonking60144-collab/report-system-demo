export type RagicFieldScope = "main" | "subtable";

export interface RagicFieldIndexEntry {
  id: number;
  formPath: string;
  formName: string;
  scope: RagicFieldScope;
  subtableName: string | null;
  subtableKey: string | null;
  fieldPos: string | null;
  fieldName: string;
  fieldId: string;
  fieldType: string | null;
  fieldNote: string | null;
  refreshedAt: string;
}

export type RagicFieldIndexStatus = "idle" | "refreshing" | "ready" | "error";

/**
 * In-memory refresh progress（backend → frontend via GET /state）。
 *
 * 分相設計：每個 phase 各自一組對應 counter，避免「downloading 階段卻顯示
 * parsedForms / writtenFields」這種型別上能成立但語意荒謬的狀態。
 * 用 discriminated union (`phase` 是 literal) 讓 TS narrowing 直接拿到對的 counter。
 *
 * 與舊 flat downloadedBytes/totalBytes 形狀的相容性：
 *   - 後端寫入：service 在 setProgress() 時帶足新欄位（不可選）
 *   - 前端讀取：既有 RagicRefreshProgress UI 在 phase === 'downloading'
 *     才取 downloadedBytes/totalBytes；其他 phase 改用各自的 counter。
 *
 * monotonic 原則（既有）：patchProgress 對 downloadedBytes 取大值；
 *   新的 parsedForms / writtenFields 同樣需要 monotonic 處理
 *   （parser 不會回退，但 retry 可能讓計數歸零 → 視同 stale，取大值）。
 */
export type RagicFieldRefreshPhase = "downloading" | "parsing" | "writing";

export interface RagicFieldRefreshProgressBase {
  /** ISO timestamp；前端用這個當 React key 觸發 remount → 進度條重置 */
  startedAt: string;
}

export interface RagicFieldRefreshProgressDownloading
  extends RagicFieldRefreshProgressBase {
  phase: "downloading";
  downloadedBytes: number;
  /** Content-Length 抓不到時 null → 前端走 time-asymptotic 模擬 */
  totalBytes: number | null;
}

export interface RagicFieldRefreshProgressParsing
  extends RagicFieldRefreshProgressBase {
  phase: "parsing";
  parsedForms: number;
  /** parser 在跑到第一個 <form> 才知道總數時可能 null */
  totalForms: number | null;
}

export interface RagicFieldRefreshProgressWriting
  extends RagicFieldRefreshProgressBase {
  phase: "writing";
  writtenFields: number;
  /** repository.replaceAll 在 chunk 開始前已知總筆數 → 一般不為 null */
  totalFields: number | null;
}

export type RagicFieldRefreshProgress =
  | RagicFieldRefreshProgressDownloading
  | RagicFieldRefreshProgressParsing
  | RagicFieldRefreshProgressWriting;

export interface RagicFieldIndexState {
  status: RagicFieldIndexStatus;
  refreshedAt: string | null;
  totalForms: number;
  totalFields: number;
  message: string | null;
  updatedAt: string;
  /** 僅 refreshing 期間有值；其他時候為 null */
  progress: RagicFieldRefreshProgress | null;
  /**
   * 上次成功 refresh 的 parsed entries canonical sha1 hex（非 raw HTML hash；
   * 存於 doc_hash 欄位，欄位名沿用未改）。對排序後 flatten rows 的 canonical
   * string 串流計算，doc.jsp 動態雜訊不影響。
   * 舊部署 / 首次升級為 null（或舊的 HTML hash 必不相等）；下一次 refresh 補寫，
   * 第二次起才能 skip。
   */
  lastDocHash: string | null;
}

/** Parser 中間產物：尚未進 SQLite 的純資料 */
export interface ParsedRagicForm {
  formPath: string;
  formName: string;
  mainKey: string | null;
  mainFields: ParsedRagicField[];
  subtables: ParsedRagicSubtable[];
}

export interface ParsedRagicSubtable {
  name: string;
  key: string | null;
  fields: ParsedRagicField[];
}

export interface ParsedRagicField {
  pos: string | null;
  name: string;
  id: string;
  type: string | null;
  note: string | null;
}
