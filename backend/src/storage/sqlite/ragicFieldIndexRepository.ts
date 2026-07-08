import { randomUUID } from "node:crypto";
import type { Database } from "sqlite";
import { createConnectionSerializer, sqliteClient } from "./sqliteClient";
import {
  parseFieldNoteToEdges,
  unescapeResidualEntities,
} from "../../services/dev/ragicFieldEdgeParser";
import {
  classifyConstraints,
  classifyRole,
  fkTargetName,
  isBrokenNote,
  type RagicFieldRole,
} from "../../services/dev/ragicSchemaClassify";
import type {
  RagicFieldIndexEntry,
  RagicFieldIndexState,
  RagicFieldIndexStatus,
  RagicFieldScope,
} from "../../types/ragicFieldIndex";
import { createLogger } from "../../observability/logger";

const log = createLogger("ragic-field-index-repository");

function createGenerationId(refreshedAt: string): string {
  return `${refreshedAt}#${randomUUID()}`;
}

export interface RagicFieldEdgeRebuildResult {
  totalEdges: number;
  dataEdges: number;
  sideEffectEdges: number;
  resolvedEdges: number;
  brokenEdges: number;
}

/** 依賴查詢的一個節點（沿一條邊抵達）*/
export interface RagicDependencyNode {
  depth: number;
  edgeType: string;
  sync: boolean | null;
  fieldId: string;
  formPath: string | null;
  formName: string | null;
  fieldName: string | null;
  fieldType: string | null;
  /** 從哪個欄位（field_id）連過來 */
  viaFieldId: string;
}

export interface RagicFieldEdgeStats {
  byType: Array<{ edgeType: string; count: number }>;
  totalData: number;
  totalSideEffect: number;
  resolvedData: number;
  brokenData: number;
}

export interface RagicSideEffectEdge {
  srcFormPath: string;
  srcFormName: string | null;
  srcFieldId: string;
  srcFieldName: string | null;
  edgeType: string;
  via: string | null;
  target: string | null;
}

export type DependencyDirection = "upstream" | "downstream";

/** 實體（mainKey 群組）摘要 */
export interface RagicEntitySummary {
  entityKey: string;
  repName: string | null;
  viewCount: number;
  fieldCount: number;
  refCount: number;
  /** true=僅被子表引用、沒有 main 主視圖（doc.jsp 未抓到 or 純子表實體）*/
  dangling: boolean;
}

/** 實體的一個欄位（已分類） */
export interface RagicEntityField {
  fieldId: string;
  fieldName: string;
  fieldPos: string | null;
  fieldType: string | null;
  role: RagicFieldRole;
  readOnly: boolean;
  unique: boolean;
  required: boolean;
  autoGen: boolean;
  /** foreign 欄位的目標表單名（FK 指向）*/
  fkTarget: string | null;
  broken: boolean;
}

export interface RagicEntityDetail {
  entityKey: string;
  repName: string | null;
  views: string[];
  fields: RagicEntityField[];
  /** 掛在這個實體底下的子表（FK 指向本實體）*/
  childTables: Array<{ formPath: string; subtableName: string | null }>;
}

// ── Workflow JS 依賴（ragic_workflow_edge）：補 field_note 那層看不到的「JS 盲區」 ──
export interface RagicWorkflowEdgeStats {
  formsWithWorkflow: number; // 有 workflow（query/set/external 任一）的表數
  queryEdges: number; // getAPIQuery 跨表邊（去重列數）
  setEdges: number; // setFieldValue 寫值邊
  externalEdges: number; // 連外副作用邊
  unresolvedQueryTargets: number; // query target 不在已知 form 的列數
  /** 入度榜：被最多「不同來源表」的 workflow query 的表（排除自我引用） */
  topDepended: Array<{ formPath: string; dependedByCount: number; resolved: boolean }>;
}

export interface RagicWorkflowFormDeps {
  formPath: string;
  /** 這張表有原文的 scope（pre/post/button 子集），供前端決定顯示哪些「看原始碼」按鈕 */
  sourceScopes: string[];
  /** 這張表的 workflow 會 getAPIQuery 哪些表（下游） */
  downstreamForms: Array<{ targetFormPath: string; resolved: boolean; scopes: string[]; occurCount: number }>;
  /** 哪些表的 workflow 會 getAPIQuery 這張表（上游 / 入度） */
  upstreamForms: Array<{ srcFormPath: string; scopes: string[]; occurCount: number }>;
  /** 這張表的 workflow setFieldValue 寫的欄位（field_id 跨表不唯一，名稱取任一命中視圖） */
  writes: Array<{ fieldId: string; fieldName: string | null; formPath: string | null; scopes: string[]; occurCount: number }>;
  /** 連外副作用（http / dbf / callHtmlApp） */
  externals: Array<{ via: string; target: string; scopes: string[]; occurCount: number }>;
}

// group 聚合 ER 鳥瞰：form_path 第二段為 group；>=10 表的 27 群保留，其餘併 'other'。
// 這份 mapping 是常數——要合併 / 排除系統表 / 改成業務名，改這裡即可（不動聚合邏輯）。
// 測試/臨時表降噪：form_name 命中這些關鍵字 → 從分析（矩陣/正規化體檢）排除；搜尋/實體不受影響。
// 刻意不含「專用」（會誤殺 [E8輸出Sheets專用] 這種正式功能表）。
const TEST_FORM_RE = /測試|test|temp|backup|複本|copy|暫存/i;

// 整群排除（form_path 第二段命中）：devtest 是開發測試群（44 張雜表），整群從分析降噪
const EXCLUDED_GROUPS = new Set(["devtest"]);
function isExcludedForm(formPath: string, formName: string): boolean {
  return TEST_FORM_RE.test(formName) || EXCLUDED_GROUPS.has(formPath.split("/")[1] ?? "");
}

const GROUP_GRAPH_WHITELIST = new Set<string>([
  "forms12", "devtest", "mis", "forms8", "forms31", "lvvp", "forms4", "d5", "d12", "forms11",
  "ragicadministration", "d4", "forms20", "mis6", "forms9", "ragicrd", "it", "ragicforms12",
  "forms16", "forms", "forms19", "c1", "ragicforms4", "forms3", "forms27", "forms2", "forms14",
]);
function groupGraphKey(formPath: string): string {
  const g = formPath.split("/")[1] ?? "";
  return GROUP_GRAPH_WHITELIST.has(g) ? g : "other";
}

// Tarjan 強連通元件：有向圖找 size>1 的 SCC＝循環依賴（A→B→…→A）。節點數百、遞迴深度夠用。
function findSCCs(nodes: string[], adj: Map<string, Set<string>>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const sccs: string[][] = [];
  const strongconnect = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp); // 只要循環團
    }
  };
  for (const v of nodes) if (!idx.has(v)) strongconnect(v);
  return sccs;
}

export interface RagicGroupGraph {
  nodes: Array<{
    group: string;
    formCount: number;
    entityCount: number;
    selfEdges: number;
    // 群成員表單：抽象 group 代號（form_path 第二段）要能追回實際 Ragic 表單；route 層補 ragicUrl
    forms: Array<{ formPath: string; formName: string }>;
  }>;
  // 跨群有向邊（src≠dst）；三型分開存，前端切圖層只 filter 不重打 API
  edges: Array<{ src: string; dst: string; type: "fk" | "workflow" | "subtable"; count: number }>;
}

// 正規化體檢：用 Link&Load fan-in/fan-out 把每張表啟發式分成 主檔 / 交易檔 / 葉表（候選，非結論）
export interface RagicNormalizationAudit {
  tables: Array<{
    formPath: string;
    formName: string;
    fanIn: number; // 被幾個 distinct 實體 Link/Load 指向（高＝主檔被引用）
    fanOut: number; // Link/Load 指向幾個 distinct 實體（高＝交易檔引用多主檔）
    hasSubtable: boolean;
    kind: "master" | "transaction" | "leaf";
    versionCount: number; // 合併的多版本數（同 mainKey），1=單一版本
  }>;
  // Link&Load 循環依賴（SCC，size>1）：A→B→…→A，運算可能卡死、該優先打斷
  cycles: Array<{ members: Array<{ formPath: string; formName: string }> }>;
}

interface RagicFieldIndexRow {
  id: number;
  form_path: string;
  form_name: string;
  scope: string;
  subtable_name: string | null;
  subtable_key: string | null;
  field_pos: string | null;
  field_name: string;
  field_id: string;
  field_type: string | null;
  field_note: string | null;
  refreshed_at: string;
  generation_id: string;
}

interface RagicFieldIndexStateRow {
  status: string;
  refreshed_at: string | null;
  total_forms: number;
  total_fields: number;
  message: string | null;
  updated_at: string;
  doc_hash: string | null;
  active_generation_id: string | null;
}

const VALID_STATUSES: ReadonlySet<RagicFieldIndexStatus> = new Set([
  "idle",
  "refreshing",
  "ready",
  "error",
]);

function mapEntry(row: RagicFieldIndexRow): RagicFieldIndexEntry {
  const scope: RagicFieldScope = row.scope === "subtable" ? "subtable" : "main";
  return {
    id: row.id,
    formPath: row.form_path,
    formName: row.form_name,
    scope,
    subtableName: row.subtable_name,
    subtableKey: row.subtable_key,
    fieldPos: row.field_pos,
    fieldName: row.field_name,
    fieldId: row.field_id,
    fieldType: row.field_type,
    fieldNote: row.field_note,
    refreshedAt: row.refreshed_at,
  };
}

function mapState(row: RagicFieldIndexStateRow): RagicFieldIndexState {
  const status: RagicFieldIndexStatus = VALID_STATUSES.has(row.status as RagicFieldIndexStatus)
    ? (row.status as RagicFieldIndexStatus)
    : "idle";
  return {
    status,
    refreshedAt: row.refreshed_at,
    totalForms:
      typeof row.total_forms === "number" && Number.isFinite(row.total_forms)
        ? row.total_forms
        : 0,
    totalFields:
      typeof row.total_fields === "number" && Number.isFinite(row.total_fields)
        ? row.total_fields
        : 0,
    message: row.message,
    updatedAt: row.updated_at,
    // Repository 不知道 in-memory progress；由 route handler 在回應時注入
    progress: null,
    lastDocHash: row.doc_hash ?? null,
  };
}

export interface RagicFieldIndexInsertInput {
  formPath: string;
  formName: string;
  scope: RagicFieldScope;
  subtableName?: string | null;
  subtableKey?: string | null;
  fieldPos?: string | null;
  fieldName: string;
  fieldId: string;
  fieldType?: string | null;
  fieldNote?: string | null;
}

export interface RagicFieldIndexSearchParams {
  q?: string;
  formPath?: string;
  fieldId?: string;
  limit?: number;
}

export interface RagicFieldIndexRepository {
  replaceAll(
    entries: RagicFieldIndexInsertInput[],
    refreshedAt: string
  ): Promise<{ totalForms: number; totalFields: number }>;
  search(params: RagicFieldIndexSearchParams): Promise<RagicFieldIndexEntry[]>;
  countAll(): Promise<{ totalForms: number; totalFields: number }>;

  getState(): Promise<RagicFieldIndexState>;
  setState(input: {
    status: RagicFieldIndexStatus;
    refreshedAt?: string | null;
    totalForms?: number;
    totalFields?: number;
    message?: string | null;
    /**
     * 上次成功 refresh 的 parsed entries canonical sha1（存於 doc_hash 欄位，
     * 非 raw HTML hash）。undefined = 不動（沿用舊值）；null = 顯式清掉；
     * string = 寫新 hash。跟 message / refreshedAt 同樣 patch 語意。
     */
    lastDocHash?: string | null;
  }): Promise<RagicFieldIndexState>;
  /**
   * Atomic 取得「執行 refresh 的權」：
   *   - 若當前 status 已是 'refreshing' → 不變更，回 false
   *   - 否則一併把 status 設成 'refreshing'，回 true
   * 由 SQLite 單寫線（runSerializedWrite）保證原子性。
   */
  claimRefresh(message?: string | null): Promise<boolean>;
  /**
   * 部署時補救：把 stuck 在 'refreshing' 的狀態（例如 backend
   * 上次跑到一半 crash）重設成 'idle'。回傳是否真的有重設。
   */
  resetStuckRefreshing(message?: string | null): Promise<boolean>;

  /**
   * 從 ragic_field_index.field_note 重建整張依賴邊表（衍生資料，全量替換）。
   * 不需重抓 doc.jsp；refresh 寫完主索引後呼叫，或單獨重建。
   */
  rebuildEdges(refreshedAt: string): Promise<RagicFieldEdgeRebuildResult>;
  /**
   * 沿依賴邊遍歷：
   *   upstream   = 給定欄位「依賴 / 引用」哪些欄位（C 要正確須先有的上游）
   *   downstream = 哪些欄位「依賴 / 引用」給定欄位（改它會波及的下游）
   * recursive CTE + 深度上限 + path 去環，只走 kind='data' 且目標已解析的邊。
   */
  queryDependencies(params: {
    fieldId: string;
    direction: DependencyDirection;
    maxDepth?: number;
  }): Promise<RagicDependencyNode[]>;
  getEdgeStats(): Promise<RagicFieldEdgeStats>;
  listSideEffects(): Promise<RagicSideEffectEdge[]>;
  /** 實體清單（mainKey 群組 + 懸空父表），供開發者模式「實體瀏覽」用 */
  listEntities(): Promise<RagicEntitySummary[]>;
  /**
   * 同 mainKey（main scope 的 subtable_key）的多版本兄弟表單，排除自己。
   * 單一版本表單回空陣列；公式跨版本連動用。
   */
  listVersionSiblingForms(
    formPath: string
  ): Promise<Array<{ formPath: string; formName: string }>>;
  /**
   * 單一表單全部欄位的 position 映射（含子表格欄位；公式 cell ref 共用同一
   * 座標空間）。公式位置翻譯器的對應表來源。
   */
  listFormFieldPositions(
    formPath: string
  ): Promise<Array<{ fieldId: string; fieldName: string; position: string; scope: RagicFieldScope }>>;
  /** 單一實體詳情：欄位（已分類角色/約束/FK）+ 掛它的子表 */
  getEntityFields(entityKey: string): Promise<RagicEntityDetail>;

  /** Workflow JS 層依賴統計（中樞入度榜），供開發者模式 workflow 依賴查詢用 */
  getWorkflowEdgeStats(): Promise<RagicWorkflowEdgeStats>;
  /** 單張表的 workflow 依賴：下游(query 哪些表)、上游(被誰 query)、JS 寫的欄位、連外副作用 */
  getWorkflowFormDeps(formPath: string): Promise<RagicWorkflowFormDeps>;
  /** 單表單 scope 的 workflow JS 原文（前端展開看完整碼）；無則 null */
  getWorkflowSource(
    formPath: string,
    scope: string
  ): Promise<{ js: string; charCount: number } | null>;
  /** group 聚合 ER 鳥瞰圖：form group 超級節點 + 三型跨群聚合邊（FK / workflow / 子表 1:N） */
  getGroupGraph(): Promise<RagicGroupGraph>;
  /** 正規化體檢：每表 Link&Load fan-in/fan-out + 啟發式分類（主檔/交易檔/葉表） */
  getNormalizationAudit(): Promise<RagicNormalizationAudit>;
}

function buildSearchText(input: RagicFieldIndexInsertInput): string {
  return [
    input.formName,
    input.scope,
    input.subtableName ?? "",
    input.fieldPos ?? "",
    input.fieldName,
    input.fieldId,
    input.fieldType ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function createRagicFieldIndexRepository(
  getDb: () => Promise<Database>,
  getReadDb: () => Promise<Database> = getDb
): RagicFieldIndexRepository {
  const { runSerializedWrite, withWriteTransaction } =
    createConnectionSerializer(getDb);

  return {
    async replaceAll(entries, refreshedAt) {
      const normalizedRefreshedAt = refreshedAt || new Date().toISOString();
      const generationId = createGenerationId(normalizedRefreshedAt);

      const cleanupGeneration = async (targetGenerationId: string) => {
        await runSerializedWrite(async (db) => {
          await db.run(
            "DELETE FROM ragic_field_index_fts WHERE rowid IN (SELECT id FROM ragic_field_index WHERE generation_id = ?)",
            targetGenerationId
          );
          await db.run(
            "DELETE FROM ragic_field_index WHERE generation_id = ?",
            targetGenerationId
          );
        });
      };

      try {
        await cleanupGeneration(generationId);

        // Batched multi-row INSERT — 改 chunk 1000，prepare/bind 次數減半。
        // 寫到 inactive generation；active_generation_id 未切換前，reader 仍看舊索引。
        // 每個 chunk 獨立排進 SQLite 單寫線，不用一個長 transaction 佔住 writer。
        const CHUNK_SIZE = 1000;
        const colCount = 13;
        const singleRowPlaceholders =
          "(" + new Array(colCount).fill("?").join(", ") + ")";
        for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
          const chunk = entries.slice(i, i + CHUNK_SIZE);
          const placeholders = chunk
            .map(() => singleRowPlaceholders)
            .join(", ");
          await runSerializedWrite(async (db) => {
            const params: unknown[] = [];
            for (const entry of chunk) {
              params.push(
                entry.formPath,
                entry.formName,
                entry.scope,
                entry.subtableName ?? null,
                entry.subtableKey ?? null,
                entry.fieldPos ?? null,
                entry.fieldName,
                entry.fieldId,
                entry.fieldType ?? null,
                entry.fieldNote ?? null,
                buildSearchText(entry),
                normalizedRefreshedAt,
                generationId
              );
            }
            await db.run(
              `INSERT INTO ragic_field_index (
                form_path, form_name, scope, subtable_name, subtable_key,
                field_pos, field_name, field_id, field_type, field_note,
                search_text, refreshed_at, generation_id
              ) VALUES ${placeholders}`,
              ...params
            );
          });
        }

        await runSerializedWrite(async (db) => {
          await db.run(
            "INSERT INTO ragic_field_index_fts (rowid, search_text) SELECT id, search_text FROM ragic_field_index WHERE generation_id = ?",
            generationId
          );
        });

        await withWriteTransaction(async (db) => {
          await db.run(
            "UPDATE ragic_field_index_state SET active_generation_id = ? WHERE id = 1",
            generationId
          );
        });
      } catch (error) {
        await cleanupGeneration(generationId).catch((cleanupError) => {
          log.warn({
            event: "cleanup-failed-generation-failed",
            generationId,
            error:
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        });
        throw error;
      }

      try {
        await runSerializedWrite(async (db) => {
          await db.run(
            "DELETE FROM ragic_field_index_fts WHERE rowid IN (SELECT id FROM ragic_field_index WHERE generation_id != ?)",
            generationId
          );
          await db.run(
            "DELETE FROM ragic_field_index WHERE generation_id != ?",
            generationId
          );
        });
      } catch (error) {
        log.warn({
          event: "cleanup-old-generations-failed",
          generationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // COUNT 在 promote 後讀 active view；cleanup 失敗也不影響 active generation。
      const db = await getReadDb();
      const counts = await db.get<{ form_count: number; field_count: number }>(
        "SELECT COUNT(DISTINCT form_path) AS form_count, COUNT(*) AS field_count FROM ragic_field_index_active"
      );
      return {
        totalForms: counts?.form_count ?? 0,
        totalFields: counts?.field_count ?? 0,
      };
    },

    async search(params) {
      const db = await getReadDb();
      const q = (params.q ?? "").trim().toLowerCase();
      const formPath = params.formPath?.trim() ?? "";
      const fieldId = params.fieldId?.trim() ?? "";
      const limit = Math.min(
        Math.max(Math.trunc(params.limit ?? 200), 1),
        2000
      );

      // FTS5 trigram 需要 query >= 3 字元才能用 trigram index；< 3 字元 trigram
      // 內部會 full scan FTS table 反而比 main table LIKE 慢、且行為不對等。
      // 短 query 走原本 LIKE。
      const useFts = q.length >= 3;

      const conditions: string[] = [];
      const values: unknown[] = [];

      if (q) {
        if (useFts) {
          // FTS5 phrase syntax：用 "..." 包住確保 query 被當成 literal substring，
          // 不會被解讀成 FTS operator (AND/OR/NOT/NEAR)。內部 " 要 double 跳脫。
          conditions.push(
            "id IN (SELECT rowid FROM ragic_field_index_fts WHERE search_text MATCH ?)"
          );
          values.push(`"${q.replace(/"/g, '""')}"`);
        } else {
          conditions.push("search_text LIKE ?");
          values.push(`%${q}%`);
        }
      }
      if (formPath) {
        conditions.push("form_path = ?");
        values.push(formPath);
      }
      if (fieldId) {
        conditions.push("field_id = ?");
        values.push(fieldId);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const sql = `
        SELECT id, form_path, form_name, scope, subtable_name, subtable_key,
               field_pos, field_name, field_id, field_type, field_note, refreshed_at
        FROM ragic_field_index_active
        ${where}
        ORDER BY form_path ASC, scope DESC, subtable_key ASC, field_pos ASC, id ASC
        LIMIT ?
      `;
      const rows = await db.all<RagicFieldIndexRow[]>(sql, ...values, limit);
      return rows.map(mapEntry);
    },

    async countAll() {
      const db = await getReadDb();
      const row = await db.get<{ form_count: number; field_count: number }>(
        "SELECT COUNT(DISTINCT form_path) AS form_count, COUNT(*) AS field_count FROM ragic_field_index_active"
      );
      return {
        totalForms: row?.form_count ?? 0,
        totalFields: row?.field_count ?? 0,
      };
    },

    async listVersionSiblingForms(formPath) {
      const db = await getReadDb();
      const rows = await db.all<Array<{ form_path: string; form_name: string }>>(
        `
        SELECT DISTINCT t.form_path AS form_path, t.form_name AS form_name
        FROM ragic_field_index_active AS s
        JOIN ragic_field_index_active AS t
          ON t.scope = 'main' AND t.subtable_key = s.subtable_key
        WHERE s.form_path = ?
          AND s.scope = 'main'
          AND s.subtable_key IS NOT NULL
          AND s.subtable_key != ''
          AND t.form_path != s.form_path
        ORDER BY t.form_name ASC, t.form_path ASC
        `,
        formPath
      );
      return rows.map((row) => ({
        formPath: row.form_path,
        formName: row.form_name,
      }));
    },

    async listFormFieldPositions(formPath) {
      const db = await getReadDb();
      const rows = await db.all<
        Array<{ field_id: string; field_name: string; field_pos: string; scope: RagicFieldScope }>
      >(
        `
        SELECT field_id, field_name, field_pos, scope
        FROM ragic_field_index_active
        WHERE form_path = ?
          AND field_pos IS NOT NULL
          AND field_pos != ''
        ORDER BY id ASC
        `,
        formPath
      );
      return rows.map((row) => ({
        fieldId: row.field_id,
        fieldName: row.field_name,
        position: row.field_pos,
        scope: row.scope,
      }));
    },

    async getState() {
      const db = await getReadDb();
      const row = await db.get<RagicFieldIndexStateRow>(
        "SELECT status, refreshed_at, total_forms, total_fields, message, updated_at, doc_hash, active_generation_id FROM ragic_field_index_state WHERE id = 1"
      );
      if (!row) {
        return {
          status: "idle",
          refreshedAt: null,
          totalForms: 0,
          totalFields: 0,
          message: null,
          updatedAt: "1970-01-01T00:00:00.000Z",
          progress: null,
          lastDocHash: null,
        };
      }
      return mapState(row);
    },

    async claimRefresh(message) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        // 用 WHERE status != 'refreshing' 確保原子性：
        // 兩個並發呼叫只有一個會 update changes>0，另一個 changes=0 視為失去 race
        const result = await db.run(
          `
          UPDATE ragic_field_index_state
          SET status = 'refreshing', message = ?, updated_at = ?
          WHERE id = 1 AND status != 'refreshing'
          `,
          message ?? null,
          now
        );
        const changes = typeof result.changes === "number" ? result.changes : 0;
        return changes > 0;
      });
    },

    async resetStuckRefreshing(message) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        const result = await db.run(
          `
          UPDATE ragic_field_index_state
          SET status = 'idle', message = ?, updated_at = ?
          WHERE id = 1 AND status = 'refreshing'
          `,
          message ?? null,
          now
        );
        const changes = typeof result.changes === "number" ? result.changes : 0;
        return changes > 0;
      });
    },

    async setState(input) {
      return runSerializedWrite(async (db) => {
        const now = new Date().toISOString();
        // 讀回舊的，patch 沒指定的欄位
        const existing = await db.get<RagicFieldIndexStateRow>(
          "SELECT status, refreshed_at, total_forms, total_fields, message, updated_at, doc_hash, active_generation_id FROM ragic_field_index_state WHERE id = 1"
        );
        const merged: RagicFieldIndexStateRow = {
          status: input.status,
          refreshed_at:
            input.refreshedAt !== undefined
              ? input.refreshedAt
              : existing?.refreshed_at ?? null,
          total_forms:
            input.totalForms !== undefined
              ? input.totalForms
              : existing?.total_forms ?? 0,
          total_fields:
            input.totalFields !== undefined
              ? input.totalFields
              : existing?.total_fields ?? 0,
          message:
            input.message !== undefined ? input.message : existing?.message ?? null,
          updated_at: now,
          doc_hash:
            input.lastDocHash !== undefined
              ? input.lastDocHash
              : existing?.doc_hash ?? null,
          active_generation_id: existing?.active_generation_id ?? "legacy",
        };
        await db.run(
          `
          INSERT INTO ragic_field_index_state (id, status, refreshed_at, total_forms, total_fields, message, updated_at, doc_hash)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            refreshed_at = excluded.refreshed_at,
            total_forms = excluded.total_forms,
            total_fields = excluded.total_fields,
            message = excluded.message,
            updated_at = excluded.updated_at,
            doc_hash = excluded.doc_hash
          `,
          merged.status,
          merged.refreshed_at,
          merged.total_forms,
          merged.total_fields,
          merged.message,
          merged.updated_at,
          merged.doc_hash
        );
        return mapState(merged);
      });
    },

    async rebuildEdges(refreshedAt) {
      const SEP = "\x1f";
      const db = await getReadDb();
      const rows = await db.all<
        Array<{
          form_path: string;
          form_name: string;
          field_pos: string | null;
          field_name: string;
          field_id: string;
          field_note: string | null;
        }>
      >(
        "SELECT form_path, form_name, field_pos, field_name, field_id, field_note FROM ragic_field_index_active"
      );

      const normName = (s: string) => unescapeResidualEntities(s).trim();
      // 建解析 mapping：表單名→path（唯一才採信）、(表單,位置碼)→field_id、(表單,欄位名)→field_id
      const formNameToPaths = new Map<string, Set<string>>();
      const posToFieldId = new Map<string, string>();
      const formFieldNameToId = new Map<string, string>();
      const fieldIdSet = new Set<string>();
      for (const r of rows) {
        fieldIdSet.add(r.field_id);
        const fn = normName(r.form_name);
        if (fn) {
          let set = formNameToPaths.get(fn);
          if (!set) {
            set = new Set();
            formNameToPaths.set(fn, set);
          }
          set.add(r.form_path);
        }
        if (r.field_pos) {
          posToFieldId.set(r.form_path + SEP + r.field_pos, r.field_id);
        }
        formFieldNameToId.set(r.form_path + SEP + normName(r.field_name), r.field_id);
      }

      const edgeRows: unknown[][] = [];
      let dataEdges = 0;
      let sideEffectEdges = 0;
      let resolvedEdges = 0;
      let brokenEdges = 0;

      for (const r of rows) {
        const raws = parseFieldNoteToEdges(r.field_note, {
          formPath: r.form_path,
          fieldId: r.field_id,
        });
        for (const e of raws) {
          const targetFormName = e.targetFormName ?? null;
          let targetFormPath: string | null = null;
          let targetFieldId: string | null = null;
          let resolved = 0;

          if (e.type === "link" || e.type === "load") {
            if (targetFormName) {
              const paths = formNameToPaths.get(normName(targetFormName));
              if (paths && paths.size === 1) {
                targetFormPath = [...paths][0] ?? null;
                if (targetFormPath) {
                  const fid = formFieldNameToId.get(
                    targetFormPath + SEP + normName(e.targetFieldName ?? "")
                  );
                  if (fid) targetFieldId = fid;
                }
              }
            }
            resolved = targetFormPath ? 1 : 0;
          } else if (e.type === "formula_ref") {
            const fid = posToFieldId.get(r.form_path + SEP + (e.targetFieldPos ?? ""));
            if (fid) {
              targetFieldId = fid;
              // 公式引用的是「同表」cell → 目標 form 就是來源 form。
              // 設了它，依「(target_field_id, target_form_path)」做的下游統計才不漏算公式邊。
              targetFormPath = r.form_path;
              resolved = 1;
            }
          } else if (e.type === "reference") {
            if (e.targetFieldId) {
              targetFieldId = e.targetFieldId;
              resolved = fieldIdSet.has(e.targetFieldId) ? 1 : 0;
            }
          }

          if (e.kind === "side_effect") sideEffectEdges += 1;
          else dataEdges += 1;
          if (resolved) resolvedEdges += 1;
          if (e.broken) brokenEdges += 1;

          edgeRows.push([
            r.form_path,
            r.field_id,
            r.field_name,
            e.kind,
            e.type,
            targetFormName,
            targetFormPath,
            e.targetFieldPos ?? e.targetFieldName ?? null,
            targetFieldId,
            e.sync === undefined || e.sync === null ? null : e.sync ? 1 : 0,
            e.broken ? 1 : 0,
            resolved,
            e.sideEffectVia ?? null,
            e.sideEffectTarget ?? null,
            e.rawSegment ?? null,
            refreshedAt,
          ]);
        }
      }

      await withWriteTransaction(async (wdb) => {
        await wdb.exec("DELETE FROM ragic_field_edge");
        const CHUNK = 1000;
        const COLS = 16;
        const single = "(" + new Array(COLS).fill("?").join(", ") + ")";
        for (let i = 0; i < edgeRows.length; i += CHUNK) {
          const chunk = edgeRows.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => single).join(", ");
          const params: unknown[] = [];
          for (const row of chunk) params.push(...row);
          await wdb.run(
            `INSERT INTO ragic_field_edge (
              src_form_path, src_field_id, src_field_name, kind, edge_type,
              target_form_name, target_form_path, target_field_raw, target_field_id,
              sync, broken, resolved, side_effect_via, side_effect_target, raw_segment, refreshed_at
            ) VALUES ${placeholders}`,
            ...params
          );
        }
      });

      return {
        totalEdges: edgeRows.length,
        dataEdges,
        sideEffectEdges,
        resolvedEdges,
        brokenEdges,
      };
    },

    async queryDependencies({ fieldId, direction, maxDepth = 10 }) {
      const db = await getReadDb();
      const depth = Math.min(Math.max(Math.trunc(maxDepth), 1), 25);
      // path 去環：把走過的節點串進 '/a/b/c/'，下一跳若已在 path 內就不再展開。
      // 只走 kind='data' 且 target_field_id 已解析的邊（link 落空 / 副作用不進遍歷）。
      const sql =
        direction === "upstream"
          ? `
        WITH RECURSIVE dep(node_id, via_id, edge_type, sync, depth, path) AS (
          SELECT e.target_field_id, e.src_field_id, e.edge_type, e.sync, 1,
                 '/' || e.src_field_id || '/' || e.target_field_id || '/'
          FROM ragic_field_edge e
          WHERE e.src_field_id = ? AND e.kind = 'data' AND e.target_field_id IS NOT NULL
          UNION
          SELECT e.target_field_id, e.src_field_id, e.edge_type, e.sync, dep.depth + 1,
                 dep.path || e.target_field_id || '/'
          FROM ragic_field_edge e
          JOIN dep ON e.src_field_id = dep.node_id
          WHERE e.kind = 'data' AND e.target_field_id IS NOT NULL
            AND dep.depth < ?
            AND dep.path NOT LIKE '%/' || e.target_field_id || '/%'
        )
        SELECT dep.node_id AS field_id, dep.via_id, dep.edge_type, dep.sync, dep.depth,
               (SELECT form_path FROM ragic_field_index_active WHERE field_id = dep.node_id LIMIT 1) AS form_path,
               (SELECT form_name FROM ragic_field_index_active WHERE field_id = dep.node_id LIMIT 1) AS form_name,
               (SELECT field_name FROM ragic_field_index_active WHERE field_id = dep.node_id LIMIT 1) AS field_name,
               (SELECT field_type FROM ragic_field_index_active WHERE field_id = dep.node_id LIMIT 1) AS field_type
        FROM dep
        ORDER BY dep.depth, dep.node_id`
          : `
        WITH RECURSIVE dep(node_id, via_id, edge_type, sync, depth, path) AS (
          SELECT e.src_field_id, e.target_field_id, e.edge_type, e.sync, 1,
                 '/' || e.target_field_id || '/' || e.src_field_id || '/'
          FROM ragic_field_edge e
          WHERE e.target_field_id = ? AND e.kind = 'data'
          UNION
          SELECT e.src_field_id, e.target_field_id, e.edge_type, e.sync, dep.depth + 1,
                 dep.path || e.src_field_id || '/'
          FROM ragic_field_edge e
          JOIN dep ON e.target_field_id = dep.node_id
          WHERE e.kind = 'data'
            AND dep.depth < ?
            AND dep.path NOT LIKE '%/' || e.src_field_id || '/%'
        )
        SELECT dep.node_id AS field_id, dep.via_id, dep.edge_type, dep.sync, dep.depth,
               (SELECT form_path FROM ragic_field_index_active WHERE field_id = dep.node_id LIMIT 1) AS form_path,
               (SELECT form_name FROM ragic_field_index_active WHERE field_id = dep.node_id LIMIT 1) AS form_name,
               (SELECT field_name FROM ragic_field_index_active WHERE field_id = dep.node_id LIMIT 1) AS field_name,
               (SELECT field_type FROM ragic_field_index_active WHERE field_id = dep.node_id LIMIT 1) AS field_type
        FROM dep
        ORDER BY dep.depth, dep.node_id`;

      const rows = await db.all<
        Array<{
          field_id: string;
          via_id: string;
          edge_type: string;
          sync: number | null;
          depth: number;
          form_path: string | null;
          form_name: string | null;
          field_name: string | null;
          field_type: string | null;
        }>
      >(sql, fieldId, depth);

      // rows 已 ORDER BY depth：同一個目標欄位經多條 path 到達會有多列（DAG 展開成
      // 樹的固有重複，深層尤其明顯），對使用者只需顯示一次——保留最淺距離那筆。
      const seen = new Set<string>();
      const out: RagicDependencyNode[] = [];
      for (const r of rows) {
        if (seen.has(r.field_id)) continue;
        seen.add(r.field_id);
        out.push({
          depth: r.depth,
          edgeType: r.edge_type,
          sync: r.sync === null ? null : Boolean(r.sync),
          fieldId: r.field_id,
          formPath: r.form_path ?? null,
          formName: r.form_name ?? null,
          fieldName: r.field_name ?? null,
          fieldType: r.field_type ?? null,
          viaFieldId: r.via_id,
        });
      }
      return out;
    },

    async getEdgeStats() {
      const db = await getReadDb();
      const byTypeRows = await db.all<Array<{ edge_type: string; cnt: number }>>(
        "SELECT edge_type, COUNT(*) AS cnt FROM ragic_field_edge GROUP BY edge_type ORDER BY cnt DESC"
      );
      const agg = await db.get<{
        data_cnt: number;
        se_cnt: number;
        resolved_cnt: number;
        broken_cnt: number;
      }>(
        `SELECT
           SUM(CASE WHEN kind='data' THEN 1 ELSE 0 END) AS data_cnt,
           SUM(CASE WHEN kind='side_effect' THEN 1 ELSE 0 END) AS se_cnt,
           SUM(CASE WHEN kind='data' AND resolved=1 THEN 1 ELSE 0 END) AS resolved_cnt,
           SUM(CASE WHEN kind='data' AND broken=1 THEN 1 ELSE 0 END) AS broken_cnt
         FROM ragic_field_edge`
      );
      return {
        byType: byTypeRows.map((r) => ({ edgeType: r.edge_type, count: r.cnt })),
        totalData: agg?.data_cnt ?? 0,
        totalSideEffect: agg?.se_cnt ?? 0,
        resolvedData: agg?.resolved_cnt ?? 0,
        brokenData: agg?.broken_cnt ?? 0,
      };
    },

    async listSideEffects() {
      const db = await getReadDb();
      const rows = await db.all<
        Array<{
          src_form_path: string;
          src_form_name: string | null;
          src_field_id: string;
          src_field_name: string | null;
          edge_type: string;
          side_effect_via: string | null;
          side_effect_target: string | null;
        }>
      >(
        // JOIN 必須帶 form_path：Ragic 的 field_id 跨表單不唯一（連結欄位共用來源
        // field_id），只 ON field_id 會把一條邊放大成 N 列。
        `SELECT e.src_form_path, e.src_field_id, e.src_field_name, e.edge_type,
                e.side_effect_via, e.side_effect_target, fi.form_name AS src_form_name
         FROM ragic_field_edge e
         LEFT JOIN ragic_field_index_active fi
           ON fi.field_id = e.src_field_id AND fi.form_path = e.src_form_path
         WHERE e.kind = 'side_effect'
         ORDER BY e.edge_type, e.src_form_path`
      );
      return rows.map((r) => ({
        srcFormPath: r.src_form_path,
        srcFormName: r.src_form_name ?? null,
        srcFieldId: r.src_field_id,
        srcFieldName: r.src_field_name ?? null,
        edgeType: r.edge_type,
        via: r.side_effect_via ?? null,
        target: r.side_effect_target ?? null,
      }));
    },

    async listEntities() {
      const db = await getReadDb();
      const ents = await db.all<
        Array<{ entity_key: string; view_count: number; field_count: number }>
      >(`
        SELECT subtable_key AS entity_key, COUNT(DISTINCT form_path) AS view_count,
               COUNT(DISTINCT field_id) AS field_count
        FROM ragic_field_index_active WHERE scope='main' AND subtable_key IS NOT NULL
        GROUP BY subtable_key
      `);
      const mainKeySet = new Set(ents.map((e) => e.entity_key));

      // 代表名 = 該 mainKey 欄位最多的視圖
      const repRows = await db.all<Array<{ subtable_key: string; form_name: string; cnt: number }>>(`
        SELECT subtable_key, form_name, COUNT(*) cnt FROM ragic_field_index_active
        WHERE scope='main' AND subtable_key IS NOT NULL
        GROUP BY subtable_key, form_path ORDER BY subtable_key, cnt DESC, form_path
      `);
      const repName = new Map<string, string>();
      for (const r of repRows) if (!repName.has(r.subtable_key)) repName.set(r.subtable_key, r.form_name);

      const refRows = await db.all<Array<{ subtable_key: string; c: number }>>(`
        SELECT subtable_key, COUNT(DISTINCT form_path) c FROM ragic_field_index_active
        WHERE scope='subtable' AND subtable_key IS NOT NULL GROUP BY subtable_key
      `);
      const refCount = new Map(refRows.map((r) => [r.subtable_key, r.c]));

      const out: RagicEntitySummary[] = ents.map((e) => ({
        entityKey: e.entity_key,
        repName: repName.get(e.entity_key) ?? null,
        viewCount: e.view_count,
        fieldCount: e.field_count,
        refCount: refCount.get(e.entity_key) ?? 0,
        dangling: false,
      }));
      for (const [key, c] of refCount) {
        if (!mainKeySet.has(key)) {
          out.push({ entityKey: key, repName: null, viewCount: 0, fieldCount: 0, refCount: c, dangling: true });
        }
      }
      out.sort((a, b) => (a.dangling === b.dangling ? b.fieldCount - a.fieldCount : a.dangling ? 1 : -1));
      return out;
    },

    async getEntityFields(entityKey) {
      const db = await getReadDb();
      const rows = await db.all<
        Array<{
          form_path: string;
          field_pos: string | null;
          field_name: string;
          field_id: string;
          field_type: string | null;
          field_note: string | null;
          out_types: string | null;
        }>
      >(
        `SELECT fi.form_path, fi.field_pos, fi.field_name, fi.field_id, fi.field_type, fi.field_note,
                (SELECT GROUP_CONCAT(DISTINCT e.edge_type) FROM ragic_field_edge e
                   WHERE e.src_field_id = fi.field_id AND e.src_form_path = fi.form_path) AS out_types
         FROM ragic_field_index_active fi WHERE fi.scope='main' AND fi.subtable_key = ?
         ORDER BY fi.field_pos`,
        entityKey
      );
      // 每個 field_id 取「資訊最完整」視圖（避開 broken note）
      const byField = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        const ex = byField.get(r.field_id);
        if (!ex || (isBrokenNote(ex.field_note) && !isBrokenNote(r.field_note))) byField.set(r.field_id, r);
      }
      const fields: RagicEntityField[] = [...byField.values()].map((r) => {
        const c = classifyConstraints(r.field_note);
        const role = classifyRole(r.out_types, r.field_note);
        return {
          fieldId: r.field_id,
          fieldName: r.field_name,
          fieldPos: r.field_pos,
          fieldType: r.field_type,
          role,
          readOnly: c.readOnly,
          unique: c.unique,
          required: c.required,
          autoGen: c.autoGen,
          fkTarget: role === "foreign" ? fkTargetName(r.field_note) : null,
          broken: isBrokenNote(r.field_note),
        };
      });

      const viewRows = await db.all<Array<{ form_path: string }>>(
        "SELECT DISTINCT form_path FROM ragic_field_index_active WHERE scope='main' AND subtable_key = ?",
        entityKey
      );
      const childRows = await db.all<Array<{ form_path: string; subtable_name: string | null }>>(
        "SELECT DISTINCT form_path, subtable_name FROM ragic_field_index_active WHERE scope='subtable' AND subtable_key = ?",
        entityKey
      );
      const repRow = await db.get<{ form_name: string }>(
        `SELECT form_name, COUNT(*) cnt FROM ragic_field_index_active
         WHERE scope='main' AND subtable_key = ? GROUP BY form_path ORDER BY cnt DESC LIMIT 1`,
        entityKey
      );
      return {
        entityKey,
        repName: repRow?.form_name ?? null,
        views: viewRows.map((v) => v.form_path),
        fields,
        childTables: childRows.map((c) => ({ formPath: c.form_path, subtableName: c.subtable_name })),
      };
    },

    async getWorkflowEdgeStats() {
      const db = await getReadDb();
      const counts = await db.get<{ q: number; s: number; e: number; unr: number }>(
        `SELECT
           SUM(CASE WHEN edge_type='query' THEN 1 ELSE 0 END) AS q,
           SUM(CASE WHEN edge_type='set' THEN 1 ELSE 0 END) AS s,
           SUM(CASE WHEN edge_type='external' THEN 1 ELSE 0 END) AS e,
           SUM(CASE WHEN edge_type='query' AND resolved=0 THEN 1 ELSE 0 END) AS unr
         FROM ragic_workflow_edge`
      );
      const formsRow = await db.get<{ c: number }>(
        "SELECT COUNT(DISTINCT src_form_path) AS c FROM ragic_workflow_edge"
      );
      // 入度榜：被多少「不同來源表」query（排除自我引用）
      const topRows = await db.all<Array<{ target_form_path: string; c: number; resolved: number }>>(
        `SELECT target_form_path, COUNT(DISTINCT src_form_path) AS c, MAX(resolved) AS resolved
         FROM ragic_workflow_edge
         WHERE edge_type='query' AND target_form_path IS NOT NULL AND target_form_path <> src_form_path
         GROUP BY target_form_path ORDER BY c DESC LIMIT 20`
      );
      return {
        formsWithWorkflow: formsRow?.c ?? 0,
        queryEdges: counts?.q ?? 0,
        setEdges: counts?.s ?? 0,
        externalEdges: counts?.e ?? 0,
        unresolvedQueryTargets: counts?.unr ?? 0,
        topDepended: topRows.map((r) => ({
          formPath: r.target_form_path,
          dependedByCount: r.c,
          resolved: Boolean(r.resolved),
        })),
      };
    },

    async getWorkflowFormDeps(formPath) {
      const db = await getReadDb();
      const splitScopes = (s: string | null): string[] => (s ? s.split(",").sort() : []);

      const downRows = await db.all<
        Array<{ target_form_path: string; resolved: number; scopes: string | null; occ: number }>
      >(
        `SELECT target_form_path, MAX(resolved) AS resolved,
                GROUP_CONCAT(DISTINCT scope) AS scopes, SUM(occur_count) AS occ
         FROM ragic_workflow_edge
         WHERE edge_type='query' AND src_form_path = ? AND target_form_path IS NOT NULL
           AND target_form_path <> src_form_path
         GROUP BY target_form_path ORDER BY occ DESC`,
        formPath
      );
      const upRows = await db.all<Array<{ src_form_path: string; scopes: string | null; occ: number }>>(
        `SELECT src_form_path, GROUP_CONCAT(DISTINCT scope) AS scopes, SUM(occur_count) AS occ
         FROM ragic_workflow_edge
         WHERE edge_type='query' AND target_form_path = ? AND src_form_path <> ?
         GROUP BY src_form_path ORDER BY occ DESC`,
        formPath,
        formPath
      );
      const writeRows = await db.all<Array<{ target_field_id: string; scopes: string | null; occ: number }>>(
        `SELECT target_field_id, GROUP_CONCAT(DISTINCT scope) AS scopes, SUM(occur_count) AS occ
         FROM ragic_workflow_edge
         WHERE edge_type='set' AND src_form_path = ? AND target_field_id IS NOT NULL
         GROUP BY target_field_id ORDER BY occ DESC`,
        formPath
      );
      const extRows = await db.all<
        Array<{ external_via: string; external_target: string | null; scopes: string | null; occ: number }>
      >(
        `SELECT external_via, external_target, GROUP_CONCAT(DISTINCT scope) AS scopes, SUM(occur_count) AS occ
         FROM ragic_workflow_edge
         WHERE edge_type='external' AND src_form_path = ?
         GROUP BY external_via, external_target ORDER BY occ DESC`,
        formPath
      );

      // setFieldValue 的 field_id → 欄位名/表（field_id 跨表不唯一，取任一命中視圖供顯示）
      const fieldNameById = new Map<string, { name: string; form: string }>();
      const ids = writeRows.map((r) => r.target_field_id).filter(Boolean);
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        const fiRows = await db.all<Array<{ field_id: string; field_name: string; form_path: string }>>(
          // setFieldValue 寫的是當前 record 的欄位 → 鎖定本表（formPath）解析欄位名；
          // field_id 跨表不唯一，不帶 form_path 會抓到別表同 id 欄位（張冠李戴 + 錯 ragicUrl）。
          `SELECT field_id, field_name, form_path FROM ragic_field_index_active
           WHERE field_id IN (${ph}) AND form_path = ? GROUP BY field_id`,
          ...ids,
          formPath
        );
        for (const r of fiRows) fieldNameById.set(r.field_id, { name: r.field_name, form: r.form_path });
      }

      const srcScopeRows = await db.all<Array<{ scope: string }>>(
        "SELECT scope FROM ragic_workflow_source WHERE form_path = ? ORDER BY scope",
        formPath
      );

      return {
        formPath,
        sourceScopes: srcScopeRows.map((r) => r.scope),
        downstreamForms: downRows.map((r) => ({
          targetFormPath: r.target_form_path,
          resolved: Boolean(r.resolved),
          scopes: splitScopes(r.scopes),
          occurCount: r.occ,
        })),
        upstreamForms: upRows.map((r) => ({
          srcFormPath: r.src_form_path,
          scopes: splitScopes(r.scopes),
          occurCount: r.occ,
        })),
        writes: writeRows.map((r) => ({
          fieldId: r.target_field_id,
          fieldName: fieldNameById.get(r.target_field_id)?.name ?? null,
          formPath: fieldNameById.get(r.target_field_id)?.form ?? null,
          scopes: splitScopes(r.scopes),
          occurCount: r.occ,
        })),
        externals: extRows.map((r) => ({
          via: r.external_via,
          target: r.external_target ?? "",
          scopes: splitScopes(r.scopes),
          occurCount: r.occ,
        })),
      };
    },

    async getWorkflowSource(formPath, scope) {
      const db = await getReadDb();
      const row = await db.get<{ js: string; char_count: number }>(
        "SELECT js, char_count FROM ragic_workflow_source WHERE form_path = ? AND scope = ?",
        formPath,
        scope
      );
      return row ? { js: row.js, charCount: row.char_count } : null;
    },

    async getGroupGraph() {
      const db = await getReadDb();
      const groupOf = groupGraphKey;

      // 每群成員表單（distinct form_path + form_name）；抽象 group 要能追回實際表單，formCount 也由此得出
      const formRows = await db.all<Array<{ form_path: string; form_name: string }>>(
        "SELECT DISTINCT form_path, form_name FROM ragic_field_index_active ORDER BY form_path"
      );
      // 測試/臨時表 + 整群排除：連同它的邊一起排除（只影響分析，不動搜尋/實體）
      const testPaths = new Set<string>();
      for (const r of formRows) if (isExcludedForm(r.form_path, r.form_name)) testPaths.add(r.form_path);

      const groupForms = new Map<string, Array<{ formPath: string; formName: string }>>();
      for (const { form_path, form_name } of formRows) {
        if (testPaths.has(form_path)) continue;
        const g = groupOf(form_path);
        if (!groupForms.has(g)) groupForms.set(g, []);
        groupForms.get(g)!.push({ formPath: form_path, formName: form_name });
      }

      // entityCount per group（distinct subtable_key, scope=main）+ mainKey→group（給子表邊找父實體所在群）
      const mainRows = await db.all<Array<{ form_path: string; subtable_key: string }>>(
        "SELECT DISTINCT form_path, subtable_key FROM ragic_field_index_active WHERE scope='main' AND subtable_key IS NOT NULL"
      );
      const entitySet = new Map<string, Set<string>>();
      const mainKeyGroup = new Map<string, string>();
      for (const { form_path, subtable_key } of mainRows) {
        if (testPaths.has(form_path)) continue;
        const g = groupOf(form_path);
        if (!entitySet.has(g)) entitySet.set(g, new Set());
        entitySet.get(g)!.add(subtable_key);
        if (!mainKeyGroup.has(subtable_key)) mainKeyGroup.set(subtable_key, g);
      }

      // 三型邊聚合：跨群進 edgeMap，群內自連累加到 selfEdges（前端標節點上、不畫穿圓線）
      const edgeMap = new Map<string, number>();
      const selfEdges = new Map<string, number>();
      const addEdge = (type: string, srcG: string, dstG: string): void => {
        if (srcG === dstG) {
          selfEdges.set(srcG, (selfEdges.get(srcG) ?? 0) + 1);
          return;
        }
        const k = `${type}|${srcG}|${dstG}`;
        edgeMap.set(k, (edgeMap.get(k) ?? 0) + 1);
      };

      const fkRows = await db.all<Array<{ src_form_path: string; target_form_path: string }>>(
        "SELECT src_form_path, target_form_path FROM ragic_field_edge WHERE kind='data' AND edge_type IN ('link','load') AND resolved=1 AND target_form_path IS NOT NULL"
      );
      for (const r of fkRows) {
        if (testPaths.has(r.src_form_path) || testPaths.has(r.target_form_path)) continue;
        addEdge("fk", groupOf(r.src_form_path), groupOf(r.target_form_path));
      }

      const wfRows = await db.all<Array<{ src_form_path: string; target_form_path: string }>>(
        "SELECT src_form_path, target_form_path FROM ragic_workflow_edge WHERE edge_type='query' AND target_form_path IS NOT NULL"
      );
      for (const r of wfRows) {
        if (testPaths.has(r.src_form_path) || testPaths.has(r.target_form_path)) continue;
        addEdge("workflow", groupOf(r.src_form_path), groupOf(r.target_form_path));
      }

      // 子表 1:N：子表 group → 父實體（mainKey）所在 group。JOIN 改用 mainKeyGroup 避免 field_id 跨表放大
      const subRows = await db.all<Array<{ form_path: string; subtable_key: string }>>(
        "SELECT DISTINCT form_path, subtable_key FROM ragic_field_index_active WHERE scope='subtable' AND subtable_key IS NOT NULL"
      );
      for (const r of subRows) {
        if (testPaths.has(r.form_path)) continue;
        const dstG = mainKeyGroup.get(r.subtable_key);
        if (dstG) addEdge("subtable", groupOf(r.form_path), dstG);
      }

      const nodes = [...groupForms.keys()]
        .map((g) => ({
          group: g,
          formCount: groupForms.get(g)!.length,
          entityCount: entitySet.get(g)?.size ?? 0,
          selfEdges: selfEdges.get(g) ?? 0,
          forms: groupForms.get(g)!,
        }))
        .sort((a, b) => b.formCount - a.formCount);

      const edges = [...edgeMap.entries()].map(([k, count]) => {
        const [type, src, dst] = k.split("|");
        return { src: src!, dst: dst!, type: type as "fk" | "workflow" | "subtable", count };
      });

      return { nodes, edges };
    },

    async getNormalizationAudit() {
      const db = await getReadDb();
      const forms = await db.all<Array<{ form_path: string; form_name: string }>>(
        "SELECT DISTINCT form_path, form_name FROM ragic_field_index_active"
      );

      // 測試/臨時表 + 整群排除降噪
      const testPaths = new Set<string>();
      for (const f of forms) if (isExcludedForm(f.form_path, f.form_name)) testPaths.add(f.form_path);

      // form_path → mainKey（main scope 的 subtable_key）；同 mainKey = 多版本同一實體
      // → 合併避免 fan-in/out 灌水（ERP料品 10 版本本來各算一次）
      const mainRows = await db.all<Array<{ form_path: string; subtable_key: string }>>(
        "SELECT DISTINCT form_path, subtable_key FROM ragic_field_index_active WHERE scope='main' AND subtable_key IS NOT NULL"
      );
      const formToKey = new Map<string, string>();
      for (const r of mainRows) if (!formToKey.has(r.form_path)) formToKey.set(r.form_path, r.subtable_key);
      const keyOf = (fp: string): string => formToKey.get(fp) ?? fp; // 沒 mainKey 的 form 自成一實體

      // 實體任一版本有子表 → 標記
      const subForms = await db.all<Array<{ form_path: string }>>(
        "SELECT DISTINCT form_path FROM ragic_field_index_active WHERE scope='subtable'"
      );
      const entSub = new Set<string>();
      for (const r of subForms) if (!testPaths.has(r.form_path)) entSub.add(keyOf(r.form_path));

      // 每實體：版本數 + 代表名（取最短 form_name，通常是主版本而非「…多版本表單/已作廢」）
      const entities = new Map<
        string,
        { key: string; repName: string; repPath: string; versionCount: number }
      >();
      for (const f of forms) {
        if (testPaths.has(f.form_path)) continue;
        const k = keyOf(f.form_path);
        const e = entities.get(k);
        if (!e) {
          entities.set(k, { key: k, repName: f.form_name, repPath: f.form_path, versionCount: 1 });
        } else {
          e.versionCount += 1;
          if (f.form_name.length < e.repName.length) {
            e.repName = f.form_name;
            e.repPath = f.form_path;
          }
        }
      }

      // Link/Load 邊：form → 實體 key，fan-in/out 算實體間（同實體的多版本互連不算）
      const edges = await db.all<Array<{ src_form_path: string; target_form_path: string }>>(
        "SELECT DISTINCT src_form_path, target_form_path FROM ragic_field_edge WHERE kind='data' AND edge_type IN ('link','load') AND resolved=1 AND target_form_path IS NOT NULL AND src_form_path <> target_form_path"
      );
      const fanIn = new Map<string, Set<string>>();
      const fanOut = new Map<string, Set<string>>();
      for (const e of edges) {
        if (testPaths.has(e.src_form_path) || testPaths.has(e.target_form_path)) continue;
        const s = keyOf(e.src_form_path);
        const t = keyOf(e.target_form_path);
        if (s === t) continue; // 多版本互連（同實體）不算
        if (!fanOut.has(s)) fanOut.set(s, new Set());
        fanOut.get(s)!.add(t);
        if (!fanIn.has(t)) fanIn.set(t, new Set());
        fanIn.get(t)!.add(s);
      }

      const tables = [...entities.values()].map((ent) => {
        const fin = fanIn.get(ent.key)?.size ?? 0;
        const fout = fanOut.get(ent.key)?.size ?? 0;
        const sub = entSub.has(ent.key);
        // 啟發式（候選，非結論）：master 要求 fan-in 明顯高於 fan-out（純被引用），
        // fan-in/out 都高的「樞紐」（如工令單 in=50 out=47）歸交易檔；引用多實體（常帶子表）＝交易檔；其餘＝葉表
        let kind: "master" | "transaction" | "leaf";
        if (fin >= 3 && fin >= fout * 1.5) kind = "master";
        else if (fout >= 2 || (sub && fout >= 1)) kind = "transaction";
        else kind = "leaf";
        return {
          formPath: ent.repPath,
          formName: ent.repName,
          fanIn: fin,
          fanOut: fout,
          hasSubtable: sub,
          kind,
          versionCount: ent.versionCount,
        };
      });
      tables.sort(
        (a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut) || a.formPath.localeCompare(b.formPath)
      );

      // SCC：實體間 Link/Load 有向圖找循環（A→B→…→A），size>1 才是循環團
      const sccGroups = findSCCs([...entities.keys()], fanOut);
      const cycles = sccGroups.map((members) => ({
        members: members.map((k) => {
          const ent = entities.get(k)!;
          return { formPath: ent.repPath, formName: ent.repName };
        }),
      }));

      return { tables, cycles };
    },
  };
}

export const ragicFieldIndexRepository: RagicFieldIndexRepository =
  createRagicFieldIndexRepository(
    () => sqliteClient.getDb(),
    () => sqliteClient.getReadDb()
  );
