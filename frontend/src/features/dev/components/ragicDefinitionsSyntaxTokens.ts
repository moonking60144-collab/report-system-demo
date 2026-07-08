export type SyntaxTokenKind =
  | "plain"
  | "comment"
  | "string"
  | "keyword"
  | "function"
  | "cell"
  | "number"
  | "literal"
  | "operator"
  | "punctuation";

export interface SyntaxToken {
  kind: SyntaxTokenKind;
  text: string;
}

const FORMULA_TOKEN_RE =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b[A-Z]{1,4}\d+(?:\.RAW)?\b)|(\b\d+(?:\.\d+)?\b)|(\b[A-Z_][A-Z0-9_]*(?=\s*\())|(\b(?:TRUE|FALSE|YES|NO|NULL)\b)|([=!<>]=?|<>|&&|\|\||[-+*/&])|([(),])/gi;

const JS_TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(function|return|var|let|const|if|else|for|while|do|switch|case|break|continue|new|try|catch|finally|throw|typeof|instanceof|true|false|null|undefined|this|void|in|of)\b|\b(\d+\.?\d*)\b/g;

export function tokenizeRagicFormula(formula: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let last = 0;

  for (const match of formula.matchAll(FORMULA_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ kind: "plain", text: formula.slice(last, index) });
    }

    const kind: SyntaxTokenKind = match[1]
      ? "string"
      : match[2]
        ? "cell"
        : match[3]
          ? "number"
          : match[4]
            ? "function"
            : match[5]
              ? "literal"
              : match[6]
                ? "operator"
                : "punctuation";
    tokens.push({ kind, text: match[0] });
    last = index + match[0].length;
  }

  if (last < formula.length) {
    tokens.push({ kind: "plain", text: formula.slice(last) });
  }

  return tokens;
}

export function tokenizeJavaScript(source: string): SyntaxToken[] {
  return tokenizeWithRegex(source, JS_TOKEN_RE, (match) =>
    match[1] ? "comment" : match[2] ? "string" : match[3] ? "keyword" : "number"
  );
}

function tokenizeWithRegex(
  source: string,
  tokenRegex: RegExp,
  getKind: (match: RegExpMatchArray) => SyntaxTokenKind
): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  let last = 0;

  for (const match of source.matchAll(tokenRegex)) {
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ kind: "plain", text: source.slice(last, index) });
    }
    tokens.push({ kind: getKind(match), text: match[0] });
    last = index + match[0].length;
  }

  if (last < source.length) {
    tokens.push({ kind: "plain", text: source.slice(last) });
  }

  return tokens;
}
