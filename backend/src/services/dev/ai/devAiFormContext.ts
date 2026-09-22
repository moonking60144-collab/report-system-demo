import { isSafeRagicDefinitionFormPath } from "../ragicDefinitionFormPath";

const SUPPORTED_DEFINITION_NAMESPACES = new Set(["default", "standard"]);

export function normalizeExplicitFormPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const input = value.trim().replace(/^\/+|\/+$/g, "");
  if (!input) return undefined;
  const extracted = formPathsFromQuestion(input)[0];
  const formPath = extracted ?? input;
  const namespace = formPath.split("/", 1)[0];
  return SUPPORTED_DEFINITION_NAMESPACES.has(namespace) && isSafeRagicDefinitionFormPath(formPath)
    ? formPath
    : undefined;
}

export function formPathsFromQuestion(question: string): string[] {
  const paths = new Set<string>();
  for (const match of question.matchAll(
    /(?:https?:\/\/[^\s/]+\/|(?<![\w/])\/?)(default\/[A-Za-z0-9_.-]+\/\d+|standard\/[A-Za-z0-9_.-]+\/\d+|forms\d*\/\d+)(?=[/?#\s，。！？、）)\]`]|$)/g
  )) {
    const formPath = /^(?:default|standard)\//.test(match[1])
      ? match[1]
      : `default/${match[1]}`;
    const normalized = normalizeExplicitFormPathCandidate(formPath);
    if (normalized) paths.add(normalized);
  }
  return [...paths];
}

function normalizeExplicitFormPathCandidate(formPath: string): string | undefined {
  const namespace = formPath.split("/", 1)[0];
  return SUPPORTED_DEFINITION_NAMESPACES.has(namespace) && isSafeRagicDefinitionFormPath(formPath)
    ? formPath
    : undefined;
}

export function asksAboutForm(question: string): boolean {
  return asksForWorkflow(question) || /欄位|表單|工令單|公式|definition|\bfield\b|\bformula\b|\bform\b|這(?:張|欄)|(?:表|欄).{0,6}(?:用途|做什麼|幹什麼)/i.test(question)
    || formPathsFromQuestion(question).length > 0;
}

export function asksForWorkflow(question: string): boolean {
  const text = question.replace(/https?:\/\/\S+/g, "");
  return /workflow|工作流程|腳本|程式碼|函式|\bfunction\b|\bjs\b|javascript/i.test(text)
    || /\b[a-z_$][a-z\d_$]*[A-Z][\w$]*\s*\(/.test(text);
}
