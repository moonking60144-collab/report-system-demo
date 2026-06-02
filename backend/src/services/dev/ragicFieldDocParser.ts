import type {
  ParsedRagicField,
  ParsedRagicForm,
  ParsedRagicSubtable,
} from "../../types/ragicFieldIndex";

/**
 * 解析 Ragic /sims/doc.jsp 的 HTML
 *
 * Doc 結構（依實際抓回觀察）：
 *   <h3><span style='color:#888;'>表單:</span>表單名稱</h3>
 *   表單網址:<a href='https://.../default/forms8/104' target='_blank'>...</a>
 *   <h4>主表單欄位</h4>
 *   主表單Key: 1005987
 *   <table class='paramTable'>
 *     <tr>
 *       <th>欄位位置</th><th>對應欄位</th><th>欄位編號</th><th>欄位型態</th><th>備註</th>
 *     </tr>
 *     <tr>
 *       <td>B1</td><td>工令單單號</td><td>1005984</td><td>文字</td><td>...</td>
 *     </tr>
 *     ...
 *   </table>
 *
 *   <h4>子表單: 名稱</h4>
 *   子表單Key: ...
 *   <table class='paramTable'>...</table>
 *
 *   ↓ 下一個 <h3> 表單 ...
 */

/** 把 <td> 內含 <br>、<b> 等簡單去除，只留純文字 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** 從一段 HTML 抓出第一個符合 regex 的 group 1，找不到回 null */
function firstGroup(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m && m[1] ? m[1].trim() : null;
}

/** 解析一張 paramTable 的 rows → ParsedRagicField[] */
function parseFieldTable(tableHtml: string): ParsedRagicField[] {
  const fields: ParsedRagicField[] = [];
  // 找所有 <tr>...</tr>，跳過第一個 header row
  const rowRegex = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  let isFirst = true;
  while ((m = rowRegex.exec(tableHtml)) !== null) {
    if (isFirst) {
      isFirst = false;
      continue;
    }
    const rowHtml = m[1] ?? "";
    const cells: string[] = [];
    const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g;
    let c;
    while ((c = cellRegex.exec(rowHtml)) !== null) {
      cells.push(stripHtmlTags(c[1] ?? ""));
    }
    if (cells.length < 4) continue;
    const [pos, name, idRaw, type, note] = cells;
    if (!idRaw || !/^\d+$/.test(idRaw)) continue;
    fields.push({
      pos: pos || null,
      name: name || idRaw,
      id: idRaw,
      type: type || null,
      note: note || null,
    });
  }
  return fields;
}

/**
 * 解析後對 doc 結構的健全性指標。Service 用這個判斷
 * 「parser 是不是壞了」（doc 格式變動 → 全部關鍵 selector 都 0）
 */
export interface ParseHealth {
  /** <h3> 出現次數（每個 form 各一）*/
  h3Count: number;
  /** <h4> 出現次數 */
  h4Count: number;
  /** paramTable class 出現次數 */
  paramTableCount: number;
  /** 「主表單欄位」字面出現次數 */
  mainSectionMarkerCount: number;
  /** 成功 parse 出至少一個欄位的 form 數 */
  formsWithFields: number;
  /** parser 認得 / 看起來健康 */
  ok: boolean;
  /** 警告訊息（要顯示給使用者）*/
  warnings: string[];
}

export interface ParseRagicDocResult {
  forms: ParsedRagicForm[];
  health: ParseHealth;
}

function countMatches(html: string, re: RegExp): number {
  return (html.match(re) || []).length;
}

/**
 * 把 doc.jsp HTML 切成 form 區塊、再切成主表 / 子表，每個都 parse 出欄位
 */
export function parseRagicDocHtml(html: string): ParseRagicDocResult {
  const forms: ParsedRagicForm[] = [];

  const h3Count = countMatches(html, /<h3>[\s\S]*?<\/h3>/g);
  const h4Count = countMatches(html, /<h4[^>]*>[\s\S]*?<\/h4>/g);
  const paramTableCount = countMatches(html, /class=['"]paramTable['"]/g);
  const mainSectionMarkerCount = countMatches(html, /主表單欄位/g);

  // 用「<h3>...</h3>」位置分段每個 form
  const h3Regex = /<h3>[\s\S]*?<\/h3>/g;
  const h3Positions: number[] = [];
  let h;
  while ((h = h3Regex.exec(html)) !== null) {
    h3Positions.push(h.index);
  }

  for (let i = 0; i < h3Positions.length; i += 1) {
    const start = h3Positions[i] ?? 0;
    const end = h3Positions[i + 1] ?? html.length;
    const segment = html.slice(start, end);

    // 抓表單名（h3 內的最後段文字 = 表單名，前面是「<span>表單:</span>」）
    const formName = (() => {
      const inner = firstGroup(segment, /<h3>([\s\S]*?)<\/h3>/);
      if (!inner) return null;
      // 移除 <span>表單:</span> 那段，留下表單名
      const stripped = inner.replace(/<span[^>]*>表單:<\/span>/i, "");
      return stripHtmlTags(stripped) || null;
    })();
    if (!formName) continue;

    // 抓表單 path：<a href='https://<domain>/<form_path>'>
    const formPath = (() => {
      const url = firstGroup(
        segment,
        /表單網址:[\s\S]*?<a href=['"]([^'"]+)['"]/i
      );
      if (!url) return null;
      try {
        const u = new URL(url);
        return u.pathname.replace(/^\//, "");
      } catch {
        return null;
      }
    })();
    if (!formPath) continue;

    const mainKey = firstGroup(segment, /主表單Key:\s*(\d+)/);

    // 主表 + 各子表 都跟著一個 paramTable。我們依「<h4>」斷段。
    // 真實 doc.jsp 觀察到的 h4 文字：
    //   - 主表單欄位     → 主表
    //   - 子表格欄位標頭 → 子表（每個子表都用同一個標題文字，靠後面的「子表格Key: NNN」區別）
    //   - 資料回傳格式範例 / 敘述欄位 → 略過（不是欄位定義）
    type Section =
      | { kind: "main"; rawAfter: string }
      | { kind: "subtable"; name: string; key: string | null; rawAfter: string };

    const sections: Section[] = [];
    const h4Regex = /<h4[^>]*>([\s\S]*?)<\/h4>/g;
    // 同時記下 h4 起始 / 結束 offset，方便 sectionEnd 直接用「下個 h4 起始」切，不要用 length 反推
    const h4Matches: Array<{ start: number; end: number; headerText: string }> = [];
    let mh;
    while ((mh = h4Regex.exec(segment)) !== null) {
      h4Matches.push({
        start: mh.index,
        end: mh.index + mh[0].length,
        headerText: stripHtmlTags(mh[1] ?? ""),
      });
    }
    let subtableSequence = 0;
    for (let j = 0; j < h4Matches.length; j += 1) {
      const cur = h4Matches[j]!;
      const next = h4Matches[j + 1];
      const sectionEnd = next ? next.start : segment.length;
      const rawAfter = segment.slice(cur.end, sectionEnd);
      if (cur.headerText.includes("主表單欄位")) {
        sections.push({ kind: "main", rawAfter });
      } else if (
        cur.headerText.includes("子表格欄位標頭") ||
        cur.headerText.startsWith("子表單") ||
        cur.headerText.includes("子表單欄位")
      ) {
        // doc 頁面不暴露子表 friendly name，只有 Key 數字
        const subKey =
          firstGroup(rawAfter, /子表格Key:\s*(\d+)/) ??
          firstGroup(rawAfter, /子表單Key:\s*(\d+)/);
        subtableSequence += 1;
        const subName = subKey
          ? `子表 (Key: ${subKey})`
          : `子表 #${subtableSequence}`;
        sections.push({ kind: "subtable", name: subName, key: subKey, rawAfter });
      }
      // 其他標題（資料回傳格式範例 / 敘述欄位 / etc.）一律略過
    }

    const mainFields: ParsedRagicField[] = [];
    const subtables: ParsedRagicSubtable[] = [];

    for (const section of sections) {
      // 取該 section 內第一個 paramTable
      const tableHtml = firstGroup(
        section.rawAfter,
        /<table\s+class=['"]paramTable['"][^>]*>([\s\S]*?)<\/table>/i
      );
      if (!tableHtml) continue;
      const fields = parseFieldTable(tableHtml);
      if (section.kind === "main") {
        mainFields.push(...fields);
      } else {
        subtables.push({ name: section.name, key: section.key, fields });
      }
    }

    if (mainFields.length === 0 && subtables.length === 0) continue;

    forms.push({
      formPath,
      formName,
      mainKey,
      mainFields,
      subtables,
    });
  }

  const formsWithFields = forms.filter(
    (f) => f.mainFields.length > 0 || f.subtables.some((s) => s.fields.length > 0)
  ).length;

  const warnings: string[] = [];
  if (h3Count === 0) warnings.push("沒偵測到任何 <h3> form 標題");
  if (paramTableCount === 0) warnings.push("沒偵測到任何 paramTable");
  if (mainSectionMarkerCount === 0) warnings.push("沒偵測到「主表單欄位」標記");
  if (formsWithFields === 0 && h3Count > 0) {
    warnings.push("有 form 標題但沒成功 parse 出任何欄位");
  }

  const ok =
    h3Count > 0 &&
    paramTableCount > 0 &&
    mainSectionMarkerCount > 0 &&
    formsWithFields > 0;

  return {
    forms,
    health: {
      h3Count,
      h4Count,
      paramTableCount,
      mainSectionMarkerCount,
      formsWithFields,
      ok,
      warnings,
    },
  };
}

/** 把多個 ParsedRagicForm 攤平成 repository 接受的 insert 列 */
export function flattenParsedFormsToInsertRows(forms: ParsedRagicForm[]) {
  const rows: Array<{
    formPath: string;
    formName: string;
    scope: "main" | "subtable";
    subtableName: string | null;
    subtableKey: string | null;
    fieldPos: string | null;
    fieldName: string;
    fieldId: string;
    fieldType: string | null;
    fieldNote: string | null;
  }> = [];
  for (const form of forms) {
    for (const f of form.mainFields) {
      rows.push({
        formPath: form.formPath,
        formName: form.formName,
        scope: "main",
        subtableName: null,
        subtableKey: form.mainKey,
        fieldPos: f.pos,
        fieldName: f.name,
        fieldId: f.id,
        fieldType: f.type,
        fieldNote: f.note,
      });
    }
    for (const sub of form.subtables) {
      for (const f of sub.fields) {
        rows.push({
          formPath: form.formPath,
          formName: form.formName,
          scope: "subtable",
          subtableName: sub.name,
          subtableKey: sub.key,
          fieldPos: f.pos,
          fieldName: f.name,
          fieldId: f.id,
          fieldType: f.type,
          fieldNote: f.note,
        });
      }
    }
  }
  return rows;
}
