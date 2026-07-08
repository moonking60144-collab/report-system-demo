/**
 * Workflow JS 依賴解析核心（CLI analyze 與 backend 直讀 .nui service 共用）。
 *
 * parseFile：對任一段文字抽出 getAPIQuery 跨表 / setFieldValue 寫值 / 連外副作用。
 * getAPIQuery / setFieldValue 只出現在 workflow JS（欄位定義、按鈕設定 JSON 不會有），
 * 所以對整個 .nui（含 sheet 定義雜訊）掃 regex 也不會誤中——已實測 .nui 直讀結果與
 * txtedit 撈的完全一致。rebuildWorkflowEdges / Sources：彙總去重後全量替換對應表。
 * 注意：這兩個 rebuild 函式不自行開交易，呼叫端必須放在 SQLite 單寫線 /
 * withWriteTransaction 內，避免跟其他 writer 形成 nested BEGIN。
 */
import type { Database } from "sqlite";

export interface ParsedFile {
  srcFormPath: string;
  scope: string; // pre | post | button | all（直讀 .nui 整檔不分 scope 時用 all）
  queries: string[]; // getAPIQuery 原始路徑
  setFields: string[]; // setFieldValue field id
  getFields: string[]; // getFieldValue field id
  externals: Array<{ via: string; target: string }>;
}

export function collect(re: RegExp, s: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[0]);
  return out;
}

function countOf(re: RegExp, s: string): number {
  return (s.match(re) ?? []).length;
}

// 自家基礎設施 / Ragic 平台 / 文件 / 範本佔位 → 不是「對外副作用」，過濾掉避免灌水
const SELF_OR_NOISE_HOST = [
  /\bfdtw\.app/i, // 自家主域
  /\bragic\.com/i, // Ragic 平台 + 官方文件 url（常出現在 workflow 註解）
  /118\.163\.115\.30/, // 自家內網鏡像 server
  /\[/, // [YOUR_RAGIC_SERVER] 之類文件範本佔位字串
];
export function isNoiseUrl(url: string): boolean {
  return SELF_OR_NOISE_HOST.some((re) => re.test(url));
}
// 同一端點不同 path/query 聚成一列：只留 protocol://host(:port)
export function normalizeHost(url: string): string {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1]! : url;
}

export function parseFile(content: string, srcFormPath: string, scope: string): ParsedFile {
  const externals: Array<{ via: string; target: string }> = [];
  for (const url of collect(/(https?:\/\/[^\s'"`)]+)/g, content)) {
    if (isNoiseUrl(url)) continue; // 自家 host / 文件 / 範本 → 不算對外副作用
    externals.push({ via: "http", target: normalizeHost(url) });
  }
  if (countOf(/dbfcommander/gi, content) > 0) externals.push({ via: "dbf", target: "dbfcommander" });
  if (countOf(/callHtmlApp\s*\(/g, content) > 0) externals.push({ via: "callHtmlApp", target: "" });

  return {
    srcFormPath,
    scope,
    queries: collect(/getAPIQuery\(\s*['"]([^'"]+)['"]/g, content),
    // ['"]? 兼容 setFieldValue("1033216", …) 引號數字字面值寫法（漏抓修正）
    setFields: collect(/setFieldValue\(\s*['"]?(\d+)/g, content),
    getFields: collect(/getFieldValue\(\s*['"]?(\d+)/g, content),
    externals,
  };
}

/** 把解析結果彙總成 ragic_workflow_edge 列（同 src/scope/type/target 去重 + occur_count）並 rebuild 整張表 */
export async function rebuildWorkflowEdges(
  db: Database,
  parsed: ParsedFile[],
  knownPaths: Set<string>,
  refreshedAt: string
): Promise<number> {
  const SEP = "\x1f";
  const edges = new Map<string, { cols: Array<string | number | null>; count: number }>();
  const bump = (
    src: string,
    scope: string,
    type: string,
    targetForm: string | null,
    targetFieldId: string | null,
    via: string | null,
    target: string | null,
    resolved: number
  ): void => {
    const key = [src, scope, type, targetForm, targetFieldId, via, target].join(SEP);
    const cur = edges.get(key);
    if (cur) cur.count += 1;
    else edges.set(key, { cols: [src, scope, type, targetForm, targetFieldId, via, target, resolved], count: 1 });
  };
  for (const p of parsed) {
    const account = p.srcFormPath.split("/")[0];
    for (const q of p.queries) {
      const clean = q.replace(/^\//, "");
      const tf = clean.startsWith(`${account}/`) ? clean : `${account}/${clean}`;
      bump(p.srcFormPath, p.scope, "query", tf, null, null, null, knownPaths.has(tf) ? 1 : 0);
    }
    for (const f of p.setFields) bump(p.srcFormPath, p.scope, "set", null, f, null, null, 0);
    for (const e of p.externals) bump(p.srcFormPath, p.scope, "external", null, null, e.via, e.target, 0);
  }
  const rows = [...edges.values()];
  await db.exec("DELETE FROM ragic_workflow_edge");
  const CHUNK = 500;
  const single = "(" + new Array(10).fill("?").join(", ") + ")";
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => single).join(", ");
    const params: Array<string | number | null> = [];
    for (const r of chunk) params.push(...r.cols, r.count, refreshedAt);
    await db.run(
      `INSERT INTO ragic_workflow_edge (
        src_form_path, scope, edge_type, target_form_path, target_field_id,
        external_via, external_target, resolved, occur_count, refreshed_at
      ) VALUES ${placeholders}`,
      ...params
    );
  }
  return rows.length;
}

/** 把 workflow JS 原文 rebuild 進 ragic_workflow_source（供前端展開看完整碼） */
export async function rebuildWorkflowSources(
  db: Database,
  sources: Array<{ formPath: string; scope: string; js: string }>,
  refreshedAt: string
): Promise<number> {
  await db.exec("DELETE FROM ragic_workflow_source");
  const CHUNK = 100; // 原文大（最大 ~290KB），chunk 小一點避免單一 INSERT 過大
  const single = "(?, ?, ?, ?, ?)";
  for (let i = 0; i < sources.length; i += CHUNK) {
    const chunk = sources.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => single).join(", ");
    const params: Array<string | number> = [];
    for (const s of chunk) params.push(s.formPath, s.scope, s.js, s.js.length, refreshedAt);
    await db.run(
      `INSERT INTO ragic_workflow_source (form_path, scope, js, char_count, refreshed_at)
       VALUES ${placeholders}`,
      ...params
    );
  }
  return sources.length;
}
