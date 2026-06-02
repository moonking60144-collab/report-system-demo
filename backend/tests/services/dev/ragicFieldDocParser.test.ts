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
<h3><span style='color:#888;'>表單:</span>✍[104] Work Order Report — Process A</h3>
表單網址:<a href='https://demo.local/default/forms8/104' target='_blank'>https://demo.local/default/forms8/104</a><br/>
API 網址:<a href='https://demo.local/default/forms8/104?api=true' target='_blank'>...</a>
<h4 style='margin:15px 0 0 0;'>主表單欄位</h4>
主表單Key: 1005987<table class='paramTable'>
<tr>
<th>欄位位置</th><th>對應欄位</th><th>欄位編號</th><th>欄位型態</th><th>備註</th>
</tr>
<tr>
<td class='noWrap'>B1</td><td class='noWrap'>工令單單號</td><td class='noWrap'>1005984</td><td class='noWrap'>文字</td><td>唯讀<br>必填</td>
</tr>
<tr>
<td class='noWrap'>E1</td><td class='noWrap'>工令單種類</td><td class='noWrap'>1006401</td><td class='noWrap'>選項</td><td>預設值: 內製</td>
</tr>
</table>

<h4>資料回傳格式範例</h4>
{ "1005984": "WO-26030401" }

<h4>子表格欄位標頭</h4>
<div>子表格Key: 1006400</div><table class='paramTable'>
<tr>
<th>欄位位置</th><th>對應欄位</th><th>欄位編號</th><th>欄位型態</th><th>備註</th>
</tr>
<tr>
<td>B1</td><td>操作員</td><td>1010920</td><td>選項</td><td>必填</td>
</tr>
</table>

<h4>子表格欄位標頭</h4>
<div>子表格Key: 1006371</div><table class='paramTable'>
<tr>
<th>欄位位置</th><th>對應欄位</th><th>欄位編號</th><th>欄位型態</th><th>備註</th>
</tr>
<tr>
<td>B66</td><td>完工品編號</td><td>1015341</td><td>文字</td><td>唯讀</td>
</tr>
</table>

<h3><span>表單:</span>[105] 報工表</h3>
表單網址:<a href='https://demo.local/default/forms8/105'>https://demo.local/default/forms8/105</a>
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
  const f104 = forms[0]!;
  assert.equal(f104.formName, "✍[104] Work Order Report — Process A");
  assert.equal(f104.formPath, "default/forms8/104");
  assert.equal(f104.mainKey, "1005987");
});

test("parseRagicDocHtml 主表欄位完整解析", () => {
  const { forms } = parseRagicDocHtml(SAMPLE_HTML);
  const main = forms[0]!.mainFields;
  assert.equal(main.length, 2);
  assert.deepEqual(main[0], {
    pos: "B1",
    name: "工令單單號",
    id: "1005984",
    type: "文字",
    note: "唯讀; 必填",
  });
  assert.equal(main[1]?.id, "1006401");
  assert.equal(main[1]?.type, "選項");
});

test("parseRagicDocHtml 真實格式：抓出兩個子表，名稱以 Key 標示", () => {
  const { forms } = parseRagicDocHtml(SAMPLE_HTML);
  const sub = forms[0]!.subtables;
  assert.equal(sub.length, 2);
  assert.equal(sub[0]?.key, "1006400");
  assert.equal(sub[0]?.name, "子表 (Key: 1006400)");
  assert.equal(sub[0]?.fields[0]?.id, "1010920");
  assert.equal(sub[1]?.key, "1006371");
  assert.equal(sub[1]?.fields[0]?.id, "1015341");
});

test("parseRagicDocHtml 略過 資料回傳格式範例 / 敘述欄位 等非欄位 h4", () => {
  // SAMPLE_HTML 的 104 在主表跟第一個子表之間有「資料回傳格式範例」h4
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
    表單網址:<a href='https://demo.local/default/forms8/999'>x</a>
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
    表單網址:<a href='https://demo.local/default/forms8/666'>x</a>
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

test("flattenParsedFormsToInsertRows 把主表 + 子表都攤平", () => {
  const { forms } = parseRagicDocHtml(SAMPLE_HTML);
  const rows = flattenParsedFormsToInsertRows(forms);
  // 104 主表 2 + 子表 1 + 子表 1 + 105 主表 1 = 5
  assert.equal(rows.length, 5);
  const main104 = rows.filter((r) => r.formPath === "default/forms8/104" && r.scope === "main");
  const sub104 = rows.filter((r) => r.formPath === "default/forms8/104" && r.scope === "subtable");
  assert.equal(main104.length, 2);
  assert.equal(sub104.length, 2);
  assert.equal(sub104[0]?.subtableKey, "1006400");
  assert.equal(sub104[1]?.subtableKey, "1006371");
});
