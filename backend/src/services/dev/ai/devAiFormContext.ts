import { isSafeRagicDefinitionFormPath } from "../ragicDefinitionFormPath";

const SUPPORTED_DEFINITION_NAMESPACES = new Set(["default", "standard", "demo"]);

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
    /(?:https?:\/\/[^\s/]+\/|(?<![\w/])\/?)(default\/[A-Za-z0-9_.-]+\/\d+|standard\/[A-Za-z0-9_.-]+\/\d+|demo\/[A-Za-z0-9_.-]+\/\d+|forms\d*\/\d+)(?=[/?#\s，。！？、）)\]`]|$)/g
  )) {
    const formPath = /^(?:default|standard|demo)\//.test(match[1])
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
  return asksForWorkflow(question) || /欄位|表單|工令單|業務流程|公式|definition|\bfield\b|\bformula\b|\bform\b|這(?:張|欄)|(?:表|欄).{0,6}(?:用途|做什麼|幹什麼)/i.test(question)
    || formPathsFromQuestion(question).length > 0;
}

export function asksForWorkflow(question: string): boolean {
  const text = question.replace(/https?:\/\/\S+/g, "");
  return /workflow|工作流程|業務流程|腳本|程式碼|函式|\bfunction\b|\bjs\b|javascript/i.test(text)
    || /\b[a-z_$][a-z\d_$]*[A-Z][\w$]*\s*\(/.test(text);
}

export function formNumbersFromQuestion(question: string): string[] {
  const numbers = new Set<string>();
  for (const match of question.matchAll(/(?:^|[^\d])(?:\[\s*(\d{1,3})\s*\]|(\d{1,3}))\s*(?:工令單|表單)/g)) {
    const number = match[1] ?? match[2];
    if (number) numbers.add(number);
  }
  return [...numbers];
}

export function isFormPathOnly(question: string): boolean {
  const text = question.trim();
  return formPathsFromQuestion(text).length === 1 &&
    /^(?:https?:\/\/[^\s]+|\/?(?:default|standard|demo)\/[\w.-]+\/\d+|\/?forms\d*\/\d+)$/.test(text);
}

export function isContextualFormFollowUp(question: string): boolean {
  return /(?:這|那)(?:個|張|筆|段)?(?:流程|表單|工令|欄位|按鈕|狀態|設定)/.test(question)
    || /(?:流程|表單|工令|欄位|按鈕|結案).{0,12}(?:為什麼|怎麼|如何|原因)/.test(question);
}
