const OpenCC = require("opencc-js/cn2t") as {
  Converter(options: { from: "cn"; to: "twp" }): (value: string) => string;
};

export const DEFAULT_DEV_AI_THREAD_TITLE = "新的 Dev AI 對話";

const MIN_DEV_AI_THREAD_TITLE_LENGTH = 4;
const MAX_DEV_AI_THREAD_TITLE_LENGTH = 24;
const SUPPORTED_TITLE_CHARACTERS = /^[\p{Script=Han}\p{Script=Latin}\p{Number}\s&+./:#()（）_\-—·，、：；？！]+$/u;
const toTaiwanTraditional = OpenCC.Converter({ from: "cn", to: "twp" });

export function normalizeDevAiTraditionalText(value: string): string {
  return value
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((segment, index) => (
      index % 2 === 1
        ? segment
        : toTaiwanTraditional(segment)
            .replace(/當前/g, "目前")
            .replace(/隻(?=(?:影響|有|要|能|可|需|會|在|對|處理|更新|執行|允許|提供|使用))/g, "只")
    ))
    .join("");
}

export function normalizeGeneratedDevAiThreadTitle(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_DEV_AI_THREAD_TITLE;
  const normalized = value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[#*`'"「『]+|[#*`'"」』]+$/g, "")
    .trim();
  const title = normalizeDevAiTraditionalText(normalized).trim();
  const characters = [...title];
  if (
    characters.length < MIN_DEV_AI_THREAD_TITLE_LENGTH ||
    !SUPPORTED_TITLE_CHARACTERS.test(title)
  ) {
    return DEFAULT_DEV_AI_THREAD_TITLE;
  }
  return characters.length <= MAX_DEV_AI_THREAD_TITLE_LENGTH
    ? title
    : `${characters.slice(0, MAX_DEV_AI_THREAD_TITLE_LENGTH - 1).join("").trimEnd()}…`;
}

export function shouldApplyGeneratedDevAiThreadTitle(currentTitle: string): boolean {
  return currentTitle.trim() === DEFAULT_DEV_AI_THREAD_TITLE;
}
