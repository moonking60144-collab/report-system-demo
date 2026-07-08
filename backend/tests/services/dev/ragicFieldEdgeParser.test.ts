import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFieldNoteToEdges,
  splitFieldNoteSegments,
  extractFormulaCellRefs,
  unescapeResidualEntities,
  type RawFieldEdge,
} from "../../../src/services/dev/ragicFieldEdgeParser";

function ofType(edges: RawFieldEdge[], type: string): RawFieldEdge[] {
  return edges.filter((e) => e.type === type);
}

// ── 業務規則：null / 空 note 不產生任何邊
test("空 note → 無邊", () => {
  assert.deepEqual(parseFieldNoteToEdges(null), []);
  assert.deepEqual(parseFieldNoteToEdges(undefined), []);
  assert.deepEqual(parseFieldNoteToEdges("   "), []);
});

// ── 業務規則：純屬性段不產生邊
test("純屬性段（唯讀/隱藏/必填/選項）→ 無邊", () => {
  assert.deepEqual(parseFieldNoteToEdges("唯讀"), []);
  assert.deepEqual(parseFieldNoteToEdges("唯讀; 隱藏"), []);
  assert.deepEqual(parseFieldNoteToEdges("選項: 內銷,外銷,代工"), []);
  assert.deepEqual(parseFieldNoteToEdges("預設值: $USERNAME"), []);
});

// ── 業務規則：link 段抽出 (目標表單名, 目標欄位名)，前綴屬性不干擾
test("link：連結到 X 表單上的 Y", () => {
  const edges = parseFieldNoteToEdges(
    "唯讀; 連結到[46] 檢驗基準群組表單上的群組名稱"
  );
  const links = ofType(edges, "link");
  assert.equal(links.length, 1);
  assert.equal(links[0]!.targetFormName, "[46] 檢驗基準群組");
  assert.equal(links[0]!.targetFieldName, "群組名稱");
  assert.equal(links[0]!.broken ?? false, false);
});

test("link：表單名帶 emoji 前綴整段保留", () => {
  const edges = parseFieldNoteToEdges("連結到⚪ [13] 工段項目清單表單上的工段代號");
  const links = ofType(edges, "link");
  assert.equal(links.length, 1);
  assert.equal(links[0]!.targetFormName, "⚪ [13] 工段項目清單");
  assert.equal(links[0]!.targetFieldName, "工段代號");
});

// ── 業務規則：load 段抽出來源 + sync 屬性
test("load：從 X 表單上的 Y 載入欄位值 + 隨時同步", () => {
  const edges = parseFieldNoteToEdges(
    "唯讀; 從[01] 求職者基本資料表單上的姓名載入欄位值 (設定為隨時同步)"
  );
  const loads = ofType(edges, "load");
  assert.equal(loads.length, 1);
  assert.equal(loads[0]!.targetFormName, "[01] 求職者基本資料");
  assert.equal(loads[0]!.targetFieldName, "姓名");
  assert.equal(loads[0]!.sync, true);
});

test("load：無同步 → sync=false", () => {
  const edges = parseFieldNoteToEdges("唯讀; 從課程表單上的課程名稱載入欄位值");
  const loads = ofType(edges, "load");
  assert.equal(loads.length, 1);
  assert.equal(loads[0]!.sync, false);
});

// ── critique 致命陷阱：來源欄位名本身含字面「表單」二字（表單簽核狀態），
// 三錨點非貪婪不可被「表單上的」貪婪 split 騙到
test("load：來源欄位名含字面「表單」二字仍正確抽取", () => {
  const edges = parseFieldNoteToEdges(
    "唯讀; 從產品生產工段評估表表單上的表單簽核狀態載入欄位值"
  );
  const loads = ofType(edges, "load");
  assert.equal(loads.length, 1);
  assert.equal(loads[0]!.targetFormName, "產品生產工段評估表");
  assert.equal(loads[0]!.targetFieldName, "表單簽核狀態");
});

// ── 業務規則：combo 同格產生 link + load 兩條獨立邊
test("combo：連結到 X; 從 Y 載入 → link + load 各一條，目標不同", () => {
  const edges = parseFieldNoteToEdges(
    "唯讀; 連結到部門表單上的部門代碼名稱; 從職缺表單上的職缺部門載入欄位值"
  );
  assert.equal(ofType(edges, "link").length, 1);
  assert.equal(ofType(edges, "load").length, 1);
  assert.equal(ofType(edges, "link")[0]!.targetFormName, "部門");
  assert.equal(ofType(edges, "load")[0]!.targetFormName, "職缺");
});

// ── critique 最大遺漏：公式同表 cell 依賴是依賴圖最大宗的邊
test("formula：抽同表 cell 引用，多字母欄位碼 AO3 不可變 O3", () => {
  const edges = parseFieldNoteToEdges('公式: COUNTIFS(A3,"1",AO3,"Yes")');
  const refs = ofType(edges, "formula_ref").map((e) => e.targetFieldPos).sort();
  assert.deepEqual(refs, ["A3", "AO3"]);
});

test("formula：剝字串字面量，.RAW 正規化成位置碼", () => {
  const edges = parseFieldNoteToEdges('公式: IF(A11.RAW="HF",D45*1000,L45.RAW)');
  const refs = ofType(edges, "formula_ref").map((e) => e.targetFieldPos).sort();
  // "HF" 在字面量內不可被當欄位；A11/D45/L45 為真引用
  assert.deepEqual(refs, ["A11", "D45", "L45"]);
});

test("formula：純常數公式不產生假邊", () => {
  assert.equal(ofType(parseFieldNoteToEdges("公式: 200001"), "formula_ref").length, 0);
  assert.equal(ofType(parseFieldNoteToEdges('公式: "產品"'), "formula_ref").length, 0);
});

// ── critique 反例：公式內含字面 "; " 不可被亂切成多段
test("formula：公式內字面 \"; \" 不被切碎", () => {
  const segs = splitFieldNoteSegments('公式: UNIQUE(B10,"; "); 唯讀');
  assert.equal(segs.length, 2);
  assert.equal(segs[0], '公式: UNIQUE(B10,"; ")');
  assert.equal(segs[1], "唯讀");
  const edges = parseFieldNoteToEdges('公式: UNIQUE(B10,"; "); 唯讀');
  assert.deepEqual(
    ofType(edges, "formula_ref").map((e) => e.targetFieldPos),
    ["B10"]
  );
});

// ── critique 反例：選項值含 A1/A2/B3 但「不是公式段」→ 不可被當 cell 依賴
test("選項段內的 A1/B2 不被誤抓成 formula_ref", () => {
  const edges = parseFieldNoteToEdges("選項: A,B,C,D,A1,A2,A3,B1,B2,B3");
  assert.equal(ofType(edges, "formula_ref").length, 0);
});

// ── 業務規則：autogen reference 跨欄邊，以 token 計（critique：雙 token 一列要兩條）
test("reference：自動產生 {2`reference`ID} 抽 field_id", () => {
  const edges = parseFieldNoteToEdges("自動產生: {2`reference`1019490}-{0`number`00000}");
  const refs = ofType(edges, "reference");
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.targetFieldId, "1019490");
});

test("reference：同段雙 reference token → 兩條邊", () => {
  const edges = parseFieldNoteToEdges(
    "自動產生: {2`reference`1027078}{2`reference`1027099}"
  );
  const refs = ofType(edges, "reference").map((e) => e.targetFieldId).sort();
  assert.deepEqual(refs, ["1027078", "1027099"]);
});

// ── critique 反例：broken 與 live edge 同列共存，先抽正常邊再標 broken
test("broken-link：與正常 load 同列共存 → load 照抽 + broken 各一條", () => {
  const edges = parseFieldNoteToEdges(
    "唯讀; Linked to sheet not found.; 從[04] 客戶報價需求表單上的營業作成載入欄位值"
  );
  assert.equal(ofType(edges, "load").length, 1, "正常 load 不可因 broken 整列丟");
  const broken = edges.filter((e) => e.broken);
  assert.equal(broken.length, 1);
});

// ── 業務規則：副作用偵測（先 unescape 才比對得到）
test("side-effect：dbfcommander 公式 → external_db_write", () => {
  const note =
    "唯讀; 公式: &#x27;&#x27;+&#x27;c:&#92;&#92;dbfcommander.exe&#x27;+&#x27; -q &#x27;+&#x27;UPDATE &#92;&#92;&#92;&#92;MS01&#92;&#92;MIS$&#92;&#92;LACOUNT.dbf SET qty_p=&#x27;+A24";
  const edges = parseFieldNoteToEdges(note);
  const se = ofType(edges, "external_db_write");
  assert.equal(se.length, 1);
  assert.equal(se[0]!.kind, "side_effect");
  assert.equal(se[0]!.sideEffectVia, "dbfcommander");
});

test("side-effect：callHtmlApp → ragic_action", () => {
  const edges = parseFieldNoteToEdges("公式: 'callHtmlApp(\"x\",\"y\")'");
  assert.equal(ofType(edges, "ragic_action").length, 1);
});

// ── 業務規則：entity 二次解碼
test("unescapeResidualEntities 還原殘留 entity", () => {
  assert.equal(unescapeResidualEntities("&#x27;"), "'");
  assert.equal(unescapeResidualEntities("&#92;"), "\\");
  assert.equal(unescapeResidualEntities("&#44;"), ",");
  assert.equal(unescapeResidualEntities("&apos;"), "'");
});

test("unescapeResidualEntities 還原雙重轉義 &amp;（含 &amp;#44; 兩階）", () => {
  assert.equal(unescapeResidualEntities("[KT&amp;MP]"), "[KT&MP]");
  assert.equal(unescapeResidualEntities("Giá MN&amp;#44; GCN"), "Giá MN, GCN");
});

// ── extractFormulaCellRefs 直接單元測：去重
test("extractFormulaCellRefs 去重同一 cell", () => {
  const refs = extractFormulaCellRefs("公式: A1+A1+A1.RAW").sort();
  assert.deepEqual(refs, ["A1"]);
});
