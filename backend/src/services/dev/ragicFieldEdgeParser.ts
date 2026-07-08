/**
 * 把 ragic_field_index.field_note 解析成「欄位依賴邊」。
 *
 * field_note 是 doc.jsp 欄位「綜合說明欄」經 stripHtmlTags 後的文字（<br> 已轉成
 * "; "、部分 entity 已解碼）。一格內以「; 」分段，混有多種語意：
 *   - link：連結到 X 表單上的 Y                         → data edge
 *   - load：從 X 表單上的 Y 載入欄位值 (設定為隨時同步)  → data edge（含 sync 屬性）
 *   - 公式：公式: <expr> 內引用同表位置碼（A1 / AO3.RAW）  → data edge（formula_ref，最大宗）
 *   - reference：自動產生: {2`reference`<fieldId>}        → data edge（跨欄 by field_id）
 *   - 副作用：公式組命令呼叫外部（dbfcommander / savework / callHtmlApp / saveClose…）→ side_effect edge
 *   - 屬性：唯讀 / 隱藏 / 必填 / 選項: …                  → 非邊，跳過
 *   - broken：Linked to sheet not found. 等英文系統訊息  → 標 broken 的 dangling link
 *
 * 規則來源：43 萬 token 的 field_note pattern audit + completeness critic（對全表
 * 54339 列真實 sqlite3 查詢）。關鍵約束（違反就爆）：
 *   1. 切段必須引號感知 + 只在「; 」後接已知 leader 才斷（公式內含字面 "; " 不可亂切）
 *   2. cell-ref 只在公式段內抽，且先剝字串字面量（否則選項值 A1/B2 與字面量會誤抓）
 *   3. cell-ref 用 [A-Z]{1,2}\d+（多字母欄位碼 AO3/AB44，不可只 [A-Z]\d+）
 *   4. link/load 三錨點非貪婪（來源欄位名含字面「表單」二字，貪婪 split 會錯）
 *   5. 偵測副作用前先二次 unescape（&#x27; / &#92; 殘留會讓比對對不上）
 *   6. broken 與 live edge 可同列共存：先抽正常邊，再標 broken，不可整列丟
 */

export type RagicEdgeKind = "data" | "side_effect";

export type RagicEdgeType =
  | "link"
  | "load"
  | "formula_ref"
  | "reference"
  | "external_db_write"
  | "cross_form_write"
  | "external_http"
  | "ragic_action";

/**
 * Parser 中間產物：未解析節點（form name → form path、cell pos → field id）的原始邊。
 * 節點解析在 rebuildEdges 用全表 mapping 做（parser 保持純函式、不碰 DB）。
 */
export interface RawFieldEdge {
  kind: RagicEdgeKind;
  type: RagicEdgeType;
  /** link / load：原文目標表單名（trim 後，待 resolve 成 form_path）*/
  targetFormName?: string | null;
  /** link / load：目標欄位名（原文）*/
  targetFieldName?: string | null;
  /** formula_ref：同表位置碼（A1 / AO3，已 strip .RAW，待 resolve 成 field_id）*/
  targetFieldPos?: string | null;
  /** reference：直接帶的 field_id */
  targetFieldId?: string | null;
  /** load 專屬：true=隨時同步、false=載入當下一次性 */
  sync?: boolean | null;
  /** dangling link（目標表單已刪 / 失聯）*/
  broken?: boolean;
  /** side_effect：經由什麼（dbfcommander / savework / callHtmlApp / saveClose…）*/
  sideEffectVia?: string | null;
  /** side_effect：盡力抽出的目標（UNC 路徑 / formId / host）；抽不到為 null */
  sideEffectTarget?: string | null;
  /** 抽出此邊的原始 segment（debug / 追溯用）*/
  rawSegment?: string | null;
}

export interface ParseFieldNoteContext {
  formPath: string;
  fieldId: string;
}

// ── 已知段落 leader（切段錨點）。長字串務必排在短字串前，否則
// 「預設值公式:」會被「預設值:」吃掉、英文長句被短前綴吃掉。
const SEGMENT_LEADERS: readonly string[] = [
  // 英文系統訊息（最長優先）
  "The original link field",
  "Loaded field value source field not found.",
  "Linked to sheet not found.",
  "Link to sheet not found.",
  // 中文（長 → 短）
  "用新增原始表單欄位工具加入的",
  "預設值公式:",
  "預設值:",
  "自動產生:",
  "輸入檢查:",
  "選項:",
  "連結到",
  "公式:",
  "從",
  "唯讀",
  "隱藏",
  "必填",
  "不可重複",
];

const BROKEN_LINK_MARKERS: readonly string[] = [
  "Linked to sheet not found.",
  "Link to sheet not found.",
  "Loaded field value source field not found.",
  "The original link field",
];

/**
 * stripHtmlTags 沒處理掉的殘留數字 entity 二次解碼。
 * 偵測副作用 / 比對 link 目標名前必做，否則 &#x27; / &#92; / &#44; 會讓比對失敗。
 */
export function unescapeResidualEntities(input: string): string {
  return input
    // &amp; 要先解：doc.jsp 來源有雙重轉義（&amp;#44; / [KT&amp;MP]），先還原成 &
    // 才能讓後續 &#NN; 再解一階，並讓表單名 link 比對對得上（否則 resolve 漏一票）
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)));
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function startsWithLeader(rest: string): boolean {
  for (const leader of SEGMENT_LEADERS) {
    if (rest.startsWith(leader)) return true;
  }
  return false;
}

/**
 * 引號感知切段：只在「引號外的『; 』後緊接已知 leader」處斷。
 *   - 公式內含字面 "; "（如 UNIQUE(B10,"; ")）在引號內 → 不切
 *   - Ragic 自身的段分隔「; 唯讀」「; 連結到…」→ 後接 leader → 切
 * audit 實證此法在全 97031 段上 unmatched = 0。
 */
export function splitFieldNoteSegments(note: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < note.length) {
    const ch = note[i]!;
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }
    if (!inSingle && !inDouble && ch === ";" && note[i + 1] === " ") {
      const rest = note.slice(i + 2);
      if (startsWithLeader(rest)) {
        const trimmed = buf.trim();
        if (trimmed) segments.push(trimmed);
        buf = "";
        i += 2;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail) segments.push(tail);
  return segments;
}

// 尾端無空格雙寫（「…;必填」「…;不可重複」）會黏在前一段尾巴，污染 link 目標名 /
// 選項末值。lookahead 切段切不到無空格的「;必填」，這裡逐段剝掉。
function stripTrailingDuplicateAttr(segment: string): string {
  return segment.replace(/;(必填|不可重複)$/u, "").trim();
}

/** link 段：連結到 {form} 表單上的 {field} */
function parseLinkSegment(segment: string): RawFieldEdge | null {
  const m = /^連結到(.+?)表單上的(.+)$/u.exec(segment);
  if (!m) return null;
  return {
    kind: "data",
    type: "link",
    targetFormName: (m[1] ?? "").trim() || null,
    targetFieldName: (m[2] ?? "").trim() || null,
    rawSegment: segment,
  };
}

/** load 段：從 {form} 表單上的 {field} 載入欄位值 (設定為隨時同步)? */
function parseLoadSegment(segment: string): RawFieldEdge | null {
  const m =
    /^從(.+?)表單上的(.+?)載入欄位值(\s*\(設定為隨時同步\))?$/u.exec(segment);
  if (!m) return null;
  return {
    kind: "data",
    type: "load",
    targetFormName: (m[1] ?? "").trim() || null,
    targetFieldName: (m[2] ?? "").trim() || null,
    sync: Boolean(m[3]),
    rawSegment: segment,
  };
}

// cell-ref：欄位碼 1-2 個大寫字母 + 1-4 位數字，可帶 .RAW；
// 前不可接英數底線（避免 SCM440 的 M440 之類）、後不可接英數或 '('（排函式 / 連寫）。
const CELL_REF_RE = /(?<![A-Za-z0-9_])([A-Z]{1,2}\d{1,4})(?:\.RAW)?(?![A-Za-z0-9(])/g;

/**
 * 公式段抽同表 cell 引用（依賴圖最大宗的邊，約 8680 列）。
 * pipeline 順序錯就爆 false positive：
 *   1. 去 leader 前綴
 *   2. 剝字串字面量 "…" '…'（材質碼 SCM440 / 'HF01' 都在字面量內）
 *   3. 抽 cell-ref（多字母 [A-Z]{1,2}、strip .RAW、去重）
 */
export function extractFormulaCellRefs(segment: string): string[] {
  let body = segment.replace(/^預設值公式:\s*/u, "").replace(/^公式:\s*/u, "");
  body = body.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  CELL_REF_RE.lastIndex = 0;
  while ((m = CELL_REF_RE.exec(body)) !== null) {
    if (m[1]) refs.add(m[1]);
  }
  return [...refs];
}

// 自動產生段的跨欄參照：{<typeCode>`reference`<fieldId>}；中間段才是 field_id。
const REFERENCE_RE = /\{\d+`reference`(\d+)\}/g;

function parseReferenceSegment(segment: string): RawFieldEdge[] {
  const edges: RawFieldEdge[] = [];
  let m: RegExpExecArray | null;
  REFERENCE_RE.lastIndex = 0;
  while ((m = REFERENCE_RE.exec(segment)) !== null) {
    if (m[1]) {
      edges.push({
        kind: "data",
        type: "reference",
        targetFieldId: m[1],
        rawSegment: segment,
      });
    }
  }
  return edges;
}

function isBrokenLinkSegment(segment: string): boolean {
  for (const marker of BROKEN_LINK_MARKERS) {
    if (segment.includes(marker)) return true;
  }
  return false;
}

// ── 副作用偵測（對整段 note、已 unescape）。只認 audit 實證的三類，避免誤判：
//   external_db_write：dbfcommander / .exe（UPDATE 不可單獨當依據，英文 prose 會誤中）
//   cross_form_write / external_http：saveClose / &new / /action/ / webaction / savework
//   ragic_action：callHtmlApp
function detectSideEffects(decodedNote: string): RawFieldEdge[] {
  const edges: RawFieldEdge[] = [];

  if (/dbfcommander|\.exe\b/i.test(decodedNote)) {
    const unc = /(\\\\[^\s"']+\.dbf)/i.exec(decodedNote);
    edges.push({
      kind: "side_effect",
      type: "external_db_write",
      sideEffectVia: "dbfcommander",
      sideEffectTarget: unc ? unc[1]! : null,
      rawSegment: null,
    });
  }

  if (/savework/i.test(decodedNote)) {
    const host = /(https?:\/\/[^\s"')]+|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)/i.exec(
      decodedNote
    );
    edges.push({
      kind: "side_effect",
      type: "external_http",
      sideEffectVia: "savework",
      sideEffectTarget: host ? host[1]! : null,
      rawSegment: null,
    });
  }

  if (/saveClose|[?&]new\b|\/action\/|webaction/i.test(decodedNote)) {
    const formIdMatch = /forms?\d*\/(\d+)/i.exec(decodedNote);
    edges.push({
      kind: "side_effect",
      type: "cross_form_write",
      sideEffectVia: "saveClose/action",
      sideEffectTarget: formIdMatch ? formIdMatch[0]! : null,
      rawSegment: null,
    });
  }

  if (/callHtmlApp/i.test(decodedNote)) {
    edges.push({
      kind: "side_effect",
      type: "ragic_action",
      sideEffectVia: "callHtmlApp",
      sideEffectTarget: null,
      rawSegment: null,
    });
  }

  return edges;
}

/**
 * 解析單一 field_note → 原始依賴邊（節點未解析）。純函式，不碰 DB。
 * 節點解析（form name→path、cell pos→field id、reference 驗證）在 rebuildEdges 做。
 */
export function parseFieldNoteToEdges(
  note: string | null | undefined,
  _ctx?: ParseFieldNoteContext
): RawFieldEdge[] {
  if (note == null) return [];
  const decoded = unescapeResidualEntities(note);
  if (decoded.trim() === "") return [];

  const edges: RawFieldEdge[] = [];

  // 副作用對整段偵測（公式組命令可能跨多段，且 leader 不一定切得乾淨）
  edges.push(...detectSideEffects(decoded));

  const segments = splitFieldNoteSegments(decoded).map(stripTrailingDuplicateAttr);

  for (const segment of segments) {
    if (segment.startsWith("連結到")) {
      const edge = parseLinkSegment(segment);
      if (edge) edges.push(edge);
      continue;
    }
    if (segment.startsWith("從") && segment.includes("載入欄位值")) {
      const edge = parseLoadSegment(segment);
      if (edge) edges.push(edge);
      continue;
    }
    if (segment.startsWith("公式:") || segment.startsWith("預設值公式:")) {
      for (const pos of extractFormulaCellRefs(segment)) {
        edges.push({
          kind: "data",
          type: "formula_ref",
          targetFieldPos: pos,
          rawSegment: segment,
        });
      }
      continue;
    }
    if (segment.startsWith("自動產生:")) {
      edges.push(...parseReferenceSegment(segment));
      continue;
    }
    if (isBrokenLinkSegment(segment)) {
      // dangling link：目標已失聯，記 broken 邊但不嘗試解析 target。
      // 同列若另有正常 link/load 段，已在上面各自抽出，不受影響。
      edges.push({
        kind: "data",
        type: "link",
        broken: true,
        targetFormName: null,
        targetFieldName: null,
        rawSegment: segment,
      });
      continue;
    }
    // 其餘為純屬性段（唯讀 / 隱藏 / 必填 / 選項 / 預設值 / 輸入檢查 / 系統標記）→ 跳過
  }

  return edges;
}
