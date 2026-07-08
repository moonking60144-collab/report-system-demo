import type { ReactNode } from "react";
import {
  tokenizeJavaScript,
  tokenizeRagicFormula,
  type SyntaxToken,
} from "./ragicDefinitionsSyntaxTokens";

export function FormulaSyntax({
  value,
  title,
  block = false,
  className,
}: {
  value: string;
  title?: string;
  block?: boolean;
  className?: string;
}) {
  const classes = [
    "ragic-defs__syntax",
    "ragic-defs__syntax--formula",
    block ? "ragic-defs__syntax--block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const content = renderTokens(tokenizeRagicFormula(value || " "));

  if (block) {
    return (
      <pre className={classes} title={title}>
        {content}
      </pre>
    );
  }

  return (
    <code className={classes} title={title}>
      {content}
    </code>
  );
}

export function JavaScriptSyntax({ value }: { value: string }) {
  return (
    <code className="ragic-defs__syntax ragic-defs__syntax--js">
      {renderTokens(tokenizeJavaScript(value || " "))}
    </code>
  );
}

function renderTokens(tokens: SyntaxToken[]): ReactNode {
  return tokens.map((token, index) =>
    token.kind === "plain" ? (
      token.text
    ) : (
      <span key={`${index}:${token.kind}`} className={`tok-${token.kind}`}>
        {token.text}
      </span>
    )
  );
}
