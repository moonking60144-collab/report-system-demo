import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DevAiMessageContent } from "./DevAiMessageContent";

describe("Dev AI 回答呈現", () => {
  it("沒有格式標記的歷史字串保留裸乘號、底線與既有粗體", () => {
    const html = renderToStaticMarkup(<DevAiMessageContent content={"qty*price*rate _1_ **重要**"} />);
    expect(html).toContain("qty*price*rate _1_");
    expect(html).toContain("<strong>重要</strong>");
    expect(html).not.toContain("<em>");
  });
  it("新 Markdown 可以使用斜體，plain 公式與原文永不解析格式", () => {
    expect(renderToStaticMarkup(<DevAiMessageContent content="_重點_" format="markdown" />)).toContain("<em>重點</em>");
    const html = renderToStaticMarkup(<DevAiMessageContent content="qty*price*rate **原文** <script>" format="plain" />);
    expect(html).toContain("qty*price*rate **原文** &lt;script&gt;");
    expect(html).not.toContain("<strong>");
  });
  it("把歷史回答的粗體、段落與清單呈現為文字格式", () => {
    const html = renderToStaticMarkup(
      <DevAiMessageContent content={"**DEMOCO** 是我們公司。\n\n可協助：\n\n1. 查看欄位定義\n2. 分析公式"} />
    );
    expect(html).toContain("<strong>DEMOCO</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>查看欄位定義</li>");
    expect(html).not.toContain("**DEMOCO**");
  });

  it("保留程式碼裡的星號與公式，不當成文字格式刪除", () => {
    const html = renderToStaticMarkup(
      <DevAiMessageContent content={'`2 ** 3`\n\n```js\nconst marker = "**原文**";\nconst total = price * qty;\n```'} />
    );
    expect(html).toContain("<code>2 ** 3</code>");
    expect(html).toContain("**原文**");
    expect(html).toContain("price * qty");
    expect(html).toContain('<pre><code class="language-js">');
  });

  it("不執行原始 HTML、危險連結或載入回答中的圖片", () => {
    const html = renderToStaticMarkup(
      <DevAiMessageContent content={'<script>alert(1)</script>\n\n[危險連結](javascript:alert%281%29)\n\n![圖片說明](https://example.com/track.png)\n\n[官方網站](https://www.ragic.com)'} />
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("track.png");
    expect(html).toContain("圖片說明");
    expect(html).toContain('href="https://www.ragic.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("仍能顯示既有純文字與換行", () => {
    const html = renderToStaticMarkup(
      <DevAiMessageContent content={"第一行\n第二行\n\n下一段"} />
    );
    expect(html).toContain("第一行\n第二行");
    expect(html).toContain("<p>下一段</p>");
  });
});
