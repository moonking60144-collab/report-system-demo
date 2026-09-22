import Markdown from "react-markdown";
import type { Root, RootContent } from "mdast";
import "./DevAiMessageContent.css";

function preserveLegacyOperators() {
  return (tree: Root, file: { value: unknown }) => {
    const raw = String(file.value);
    const visit = (node: Root | RootContent) => {
      if (!("children" in node)) return;
      node.children = node.children.map((child) => {
        if (child.type === "emphasis" && child.position) return { type: "text", value: raw.slice(child.position.start.offset, child.position.end.offset) };
        visit(child);
        return child;
      }) as typeof node.children;
    };
    visit(tree);
  };
}

export function DevAiMessageContent({ content, format }: { content: string; format?: unknown }) {
  if (format === "plain") return <div className="dev-ai-message-content"><p>{content}</p></div>;
  return (
    <div className="dev-ai-message-content">
      <Markdown
        skipHtml
        remarkPlugins={format === "markdown" ? [] : [preserveLegacyOperators]}
        components={{
          a: ({ children, href, title }) => (
            <a href={href} title={title} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
