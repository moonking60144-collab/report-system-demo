import test from "node:test";
import assert from "node:assert/strict";
import {
  flattenParsedFormsToInsertRows,
  parseRagicDocHtml,
} from "../../../src/services/dev/ragicFieldDocParser";

// 真實 Ragic doc.jsp 結構（probe 後修正）：
// - 子表用「<h4>子表格欄位標頭</h4>」標題，每個子表的標題文字一樣
// - 子表 key 在 <div>子表格Key: NNN</div>（注意「子表格」不是「子表單」）
// - 還會出現「資料回傳格式範例」「敘述欄位」這類 h4 必須略過
const SAMPLE_HTML = `
<html><body>
<h3><span style='color:#888;'>表單:</span>✍[901] 工令單製程 A 報工+排程</h3>
表單網址:<a href='https://demo.local/demo/work-orders/line-a' target='_blank'>https://demo.local/demo/work-orders/line-a</a><br/>
API 網址:<a href='https://demo.local/demo/work-orders/line-a?api=true' target='_blank'>...</a>
<h4 style='margin:15px 0 0 0;'>主表單欄位</h4>
主表單Key: 9001042<table class='paramTable'>
<tr>
<th>欄位位置</th><th>對應欄位</th><th>欄位編號</th><th>欄位型態</th><th>備註</th>
</tr>
<tr>
<td class='noWrap'>B1</td><td class='noWrap'>demo_work_order_no</td><td class='noWrap'>9001040</td><td class='noWrap'>文字</td><td>唯讀<br>必填</td>
</tr>
<tr>
<td class='noWrap'>E1</td><td class='noWrap'>工令單種類</td><td class='noWrap'>9001051</td><td class='noWrap'>選項</td><td>預設值: 內製</td>
</tr>
</table>

<h4>資料回傳格式範例</h4>
{ "9001040": "WO-DEMO-0003" }

<h4>子表格欄位標頭</h4>
<div>子表格Key: 9001050</div><table class='paramTable'>
<tr>
<th>欄位位置</th><th>對應欄位</th><th>欄位編號</th><th>欄位型態</th><th>備註</th>
</tr>
<tr>
<td>B1</td><td>操作員</td><td>9001062</td><td>選項</td><td>必填</td>
</tr>
</table>

<h4>子表格欄位標頭</h4>
<div>子表格Key: 9001048</div><table class='paramTable'>
<tr>
<th>欄位位置</th><th>對應欄位</th><th>欄位編號</th><th>欄位型態</th><th>備註</th>
</tr>
<tr>
<td>B66</td><td>完工品編號</td><td>9001071</td><td>文字</td><td>唯讀</td>
</tr>
</table>

<h3><span>表單:</span>[902] 報工表</h3>
表單網址:<a href='https://demo.local/demo/work-orders/line-b'>https://demo.local/demo/work-orders/line-b</a>
<h4>主表單欄位</h4>
主表單Key: 999<table class='paramTable'>
<tr>
<th>欄位位置</th><th>對應欄位</th><th>欄位編號</th><th>欄位型態</th><th>備註</th>
</tr>
<tr>
<td>A1</td><td>單號</td><td>1234567</td><td>文字</td><td></td>
</tr>
</table>
</body></html>
`;

test("parseRagicDocHtml 抓出兩張 form 且 health.ok=true", () => {
  const result = parseRagicDocHtml(SAMPLE_HTML);
  assert.equal(result.forms.length, 2);
  assert.equal(result.health.ok, true);
  assert.equal(result.health.warnings.length, 0);
});

test("parseRagicDocHtml 解析 form name + path + main key", () => {
  const { forms } = parseRagicDocHtml(SAMPLE_HTML);
  const f901 = forms[0]!;
  assert.equal(f901.formName, "✍[901] 工令單製程 A 報工+排程");
  assert.equal(f901.formPath, "demo/work-orders/line-a");
  assert.equal(f901.mainKey, "9001042");
});

test("parseRagicDocHtml 主表欄位完整解析", () => {
  const { forms } = parseRagicDocHtml(SAMPLE_HTML);
  const main = forms[0]!.mainFields;
  assert.equal(main.length, 2);
  assert.deepEqual(main[0], {
    pos: "B1",
    name: "demo_work_order_no",
    id: "9001040",
    type: "文字",
    note: "唯讀; 必填",
  });
  assert.equal(main[1]?.id, "9001051");
  assert.equal(main[1]?.type, "選項");
});

test("parseRagicDocHtml 真實格式：抓出兩個子表，名稱以 Key 標示", () => {
  const { forms } = parseRagicDocHtml(SAMPLE_HTML);
  const sub = forms[0]!.subtables;
  assert.equal(sub.length, 2);
  assert.equal(sub[0]?.key, "9001050");
  assert.equal(sub[0]?.name, "子表 (Key: 9001050)");
  assert.equal(sub[0]?.fields[0]?.id, "9001062");
  assert.equal(sub[1]?.key, "9001048");
  assert.equal(sub[1]?.fields[0]?.id, "9001071");
});

test("parseRagicDocHtml 略過 資料回傳格式範例 / 敘述欄位 等非欄位 h4", () => {
  // SAMPLE_HTML 的 901 在主表跟第一個子表之間有「資料回傳格式範例」h4
  // parser 應該不會把它當主表或子表
  const { forms } = parseRagicDocHtml(SAMPLE_HTML);
  const f = forms[0]!;
  // 主表 2 欄位、子表 1 + 1 = 2 個子表，總 4 + 1 = 5 個 entries
  assert.equal(f.mainFields.length, 2);
  assert.equal(f.subtables.length, 2);
});

test("parseRagicDocHtml 跳過沒有 paramTable 的 form 不會炸", () => {
  const html = `
    <h3><span>表單:</span>空表</h3>
    表單網址:<a href='https://demo.local/default/forms999/9099'>x</a>
    <h4>主表單欄位</h4>
    主表單Key: 1
  `;
  const { forms, health } = parseRagicDocHtml(html);
  assert.equal(forms.length, 0);
  assert.equal(health.ok, false);
  // 有 h3 + 主表單欄位 marker，但沒 paramTable → warning 含「沒偵測到任何 paramTable」
  assert.ok(health.warnings.some((w) => w.includes("paramTable")));
});

test("parseRagicDocHtml 過濾非數字的 field id", () => {
  const html = `
    <h3><span>表單:</span>怪表</h3>
    表單網址:<a href='https://demo.local/default/forms999/9066'>x</a>
    <h4>主表單欄位</h4>
    <table class='paramTable'>
    <tr><th>位置</th><th>名</th><th>id</th><th>型</th><th>註</th></tr>
    <tr><td>A1</td><td>合法</td><td>123</td><td>文字</td><td></td></tr>
    <tr><td>A2</td><td>無效</td><td>NOT_A_NUMBER</td><td>文字</td><td></td></tr>
    <tr><td>A3</td><td>空</td><td></td><td>文字</td><td></td></tr>
    </table>
  `;
  const { forms } = parseRagicDocHtml(html);
  const fields = forms[0]?.mainFields ?? [];
  assert.equal(fields.length, 1);
  assert.equal(fields[0]?.id, "123");
});

test("parseRagicDocHtml 完全空 html → health.ok=false 且 warnings 列出多項", () => {
  const { forms, health } = parseRagicDocHtml("<html><body></body></html>");
  assert.equal(forms.length, 0);
  assert.equal(health.ok, false);
  assert.ok(health.warnings.length >= 2);
});

test("parseRagicDocHtml 巢狀 table 不會污染外層 row 計數", () => {
  // 主表 paramTable 有 2 個合法 row；其中第一個 td 故意塞一張巢狀 table（含 1 row）。
  // 用 .find("tr") 會把巢狀 row 也算進來 → 期望實作改用 direct-child 後不會出現。
  const html = `
    <h3><span>表單:</span>巢狀表</h3>
    表單網址:<a href='https://demo.local/default/forms999/90037'>x</a>
    <h4>主表單欄位</h4>
    主表單Key: 7770000
    <table class='paramTable'>
      <tr><th>位置</th><th>名</th><th>id</th><th>型</th><th>註</th></tr>
      <tr>
        <td>
          A1
          <table><tr><td>內層 phantom 1</td><td>x</td><td>9999999</td><td>x</td><td>x</td></tr></table>
        </td>
        <td>外層欄位 1</td><td>1111111</td><td>文字</td><td>n1</td>
      </tr>
      <tr>
        <td>A2</td><td>外層欄位 2</td><td>2222222</td><td>文字</td><td>n2</td>
      </tr>
    </table>
  `;
  const { forms } = parseRagicDocHtml(html);
  assert.equal(forms.length, 1);
  const fields = forms[0]!.mainFields;
  assert.equal(fields.length, 2, "外層 table 應只解析 2 筆，巢狀 row 不應被算入");
  assert.equal(fields[0]?.id, "1111111");
  assert.equal(fields[1]?.id, "2222222");
});

test("parseRagicDocHtml formName 內部多空白／換行 collapse 成單空格", () => {
  const html = `
    <h3><span style='color:#888;'>表單:</span>  ✍[901]   工令單
    製程 A\t報工+排程  </h3>
    表單網址:<a href='https://demo.local/demo/work-orders/line-a'>x</a>
    <h4>主表單欄位</h4>
    主表單Key: 1
    <table class='paramTable'>
      <tr><th>位置</th><th>名</th><th>id</th><th>型</th><th>註</th></tr>
      <tr><td>A1</td><td>x</td><td>123</td><td>文字</td><td></td></tr>
    </table>
  `;
  const { forms } = parseRagicDocHtml(html);
  assert.equal(forms.length, 1);
  assert.equal(forms[0]?.formName, "✍[901] 工令單 製程 A 報工+排程");
});

test("parseRagicDocHtml cell 內 <br> 兩側 whitespace 仍然分號隔開", () => {
  const html = `
    <h3><span>表單:</span>br 測試</h3>
    表單網址:<a href='https://demo.local/default/forms999/9088'>x</a>
    <h4>主表單欄位</h4>
    主表單Key: 1
    <table class='paramTable'>
      <tr><th>位置</th><th>名</th><th>id</th><th>型</th><th>註</th></tr>
      <tr><td>A1</td><td>x</td><td>123</td><td>文字</td><td>  唯讀  <br/>  必填  </td></tr>
    </table>
  `;
  const { forms } = parseRagicDocHtml(html);
  assert.equal(forms[0]?.mainFields[0]?.note, "唯讀; 必填");
});

test("flattenParsedFormsToInsertRows 把主表 + 子表都攤平", () => {
  const { forms } = parseRagicDocHtml(SAMPLE_HTML);
  const rows = flattenParsedFormsToInsertRows(forms);
  // 901 主表 2 + 子表 1 + 子表 1 + 902 主表 1 = 5
  assert.equal(rows.length, 5);
  const main901 = rows.filter((r) => r.formPath === "demo/work-orders/line-a" && r.scope === "main");
  const sub901 = rows.filter((r) => r.formPath === "demo/work-orders/line-a" && r.scope === "subtable");
  assert.equal(main901.length, 2);
  assert.equal(sub901.length, 2);
  assert.equal(sub901[0]?.subtableKey, "9001050");
  assert.equal(sub901[1]?.subtableKey, "9001048");
});
