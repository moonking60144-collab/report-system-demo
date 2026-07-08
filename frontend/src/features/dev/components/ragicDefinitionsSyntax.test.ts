import { describe, expect, it } from "vitest";
import { tokenizeRagicFormula } from "./ragicDefinitionsSyntaxTokens";

describe("ragicDefinitionsSyntax", () => {
  it("公式高亮 tokenizer 可區分函式、欄位引用、字串與運算子", () => {
    const tokens = tokenizeRagicFormula(
      'UPDATEIF(AND(G4.RAW!="一般",B19.RAW!=""),B19)'
    ).filter((token) => token.kind !== "plain");

    expect(tokens).toMatchObject([
      { kind: "function", text: "UPDATEIF" },
      { kind: "punctuation", text: "(" },
      { kind: "function", text: "AND" },
      { kind: "punctuation", text: "(" },
      { kind: "cell", text: "G4.RAW" },
      { kind: "operator", text: "!=" },
      { kind: "string", text: '"一般"' },
      { kind: "punctuation", text: "," },
      { kind: "cell", text: "B19.RAW" },
      { kind: "operator", text: "!=" },
      { kind: "string", text: '""' },
      { kind: "punctuation", text: ")" },
      { kind: "punctuation", text: "," },
      { kind: "cell", text: "B19" },
      { kind: "punctuation", text: ")" },
    ]);
  });

  it("公式高亮 tokenizer 保留中文與未分類片段", () => {
    const tokens = tokenizeRagicFormula('IF(A1="是","這是測試",A2+100)');

    expect(tokens.map((token) => token.text).join("")).toBe(
      'IF(A1="是","這是測試",A2+100)'
    );
    expect(tokens).toContainEqual({ kind: "string", text: '"這是測試"' });
    expect(tokens).toContainEqual({ kind: "number", text: "100" });
  });
});
