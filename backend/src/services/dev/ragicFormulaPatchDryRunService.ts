import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  ragicDefinitionsReadService,
  type RagicDefinitionFormula,
  type RagicDefinitionsReadService,
} from "./ragicDefinitionsReadService";
import { splitRawDefinitionsEntriesByFormScope } from "./ragicDefinitionsGitScope";
import {
  parseNuiFieldLine,
  type RawAttr,
} from "./ragicNuiParser";
import { tokenizeFormula } from "./ragicFormulaPositionTranslator";
import type { RagicFormulaPatchDryRunResult } from "@shared-types/ragicDefinitions";

export type { RagicFormulaPatchDryRunResult };

export interface RagicFormulaPatchDryRunRequest {
  formPath: string;
  fieldId: string;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  newFormula: string;
}

export interface RagicFormulaPatchDryRunServiceOptions {
  definitionsService?: RagicDefinitionsReadService;
  builderRoot?: string;
}

function emptyResult(input: RagicFormulaPatchDryRunRequest): RagicFormulaPatchDryRunResult {
  return {
    allowed: false,
    mode: "dry-run",
    formPath: input.formPath,
    formName: null,
    fieldId: input.fieldId,
    fieldName: null,
    position: null,
    formulaKind: input.formulaKind,
    sourceRelativePath: null,
    builderFilePath: null,
    sourceLine: null,
    oldFormula: null,
    newFormula: input.newFormula,
    oldLinePreview: null,
    newLinePreview: null,
    gitClean: null,
    warnings: [],
    blockers: [],
  };
}

export function maskSecrets(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "***REDACTED-JWT***")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-***REDACTED***")
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "AIza***REDACTED***")
    .replace(/[A-Za-z0-9_-]+-ragic-callback-[A-Za-z0-9_-]+/g, "demo-ragic-callback-***REDACTED***");
}

export function normalizeFormulaForNuiStorage(formula: string): string {
  return normalizeFormulaForNuiStorageWithMeta(formula).formula;
}

function normalizeFormulaForNuiStorageWithMeta(formula: string): {
  formula: string;
  changedLineBreaks: boolean;
  changedSeparators: boolean;
} {
  let out = "";
  let quote: '"' | "'" | null = null;
  let pendingSpace = false;
  let changedLineBreaks = false;
  let changedSeparators = false;

  for (const char of formula) {
    if (quote) {
      if (char === "\r" || char === "\n" || char === "\t") {
        changedLineBreaks = true;
        if (!out.endsWith(" ")) {
          out += " ";
        }
        continue;
      }
      out += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\r" || char === "\n" || char === "\t" || char === " ") {
      if (char !== " ") {
        changedLineBreaks = true;
      }
      pendingSpace = true;
      continue;
    }

    if (pendingSpace) {
      if (out && !out.endsWith(" ")) {
        out += " ";
      }
      pendingSpace = false;
    }

    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }

    if (char === ",") {
      changedSeparators = true;
      out += "`";
    } else {
      out += char;
    }
  }

  return {
    formula: out.trim(),
    changedLineBreaks,
    changedSeparators,
  };
}

export function resolveInside(root: string, relativePath: string): string | null {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    return null;
  }
  return resolvedPath;
}

function normalizeEncoding(encoding: string): string {
  const normalized = encoding.trim().toLowerCase();
  return normalized === "utf8" ? "utf-8" : normalized || "utf-8";
}

function isUtf8Encoding(encoding: string): boolean {
  return normalizeEncoding(encoding) === "utf-8";
}

function isTextDecoderSupported(encoding: string): boolean {
  try {
    new TextDecoder(encoding);
    return true;
  } catch {
    return false;
  }
}

export function decodeNuiContent(bytes: Buffer, encoding: string, warnings: string[]): string {
  const normalized = normalizeEncoding(encoding);
  try {
    return new TextDecoder(normalized).decode(bytes);
  } catch {
    warnings.push(`sourceEncoding=${encoding} 無法用 TextDecoder 解碼，已 fallback utf-8`);
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function isNuiFormulaInSync(params: {
  baselineFormula: string;
  liveFormula: string;
  sourceEncoding: string;
  liveRawFormula?: string | null;
}): boolean {
  if (params.baselineFormula === params.liveFormula) {
    return true;
  }

  const normalizedBaseline = normalizeFormulaForNuiStorage(params.baselineFormula);
  const normalizedLive = normalizeFormulaForNuiStorage(params.liveFormula);
  if (normalizedBaseline === normalizedLive) {
    return true;
  }

  if (!isUtf8Encoding(params.sourceEncoding) || !params.liveRawFormula) {
    return false;
  }

  return encodeReplacementAttrValue(normalizedBaseline, params.liveRawFormula) === params.liveRawFormula;
}

export function serializeRawAttrs(attrs: RawAttr[]): string {
  return attrs
    .map((attr) =>
      attr.rawValue === null ? attr.key : `${attr.key}=${attr.rawValue}`
    )
    .join("&");
}

export function encodeRawStyleAttrValue(value: string): string {
  let out = "";
  for (const char of value) {
    if (char === "&" || char === "\r" || char === "\n") {
      out += encodeURIComponent(char);
    } else {
      out += char;
    }
  }
  return out;
}

export function encodeReplacementAttrValue(value: string, _oldRawValue: string | null): string {
  return encodeRawStyleAttrValue(value);
}

export function replaceAttrValue(attrs: RawAttr[], key: string, value: string): RawAttr[] {
  let replaced = false;
  const next = attrs.map((attr) => {
    if (attr.key !== key) return attr;
    replaced = true;
    const rawValue = encodeReplacementAttrValue(value, attr.rawValue);
    return { key, rawValue, decodedValue: value };
  });
  return replaced
    ? next
    : [...next, { key, rawValue: encodeRawStyleAttrValue(value), decodedValue: value }];
}

export function formulaAttrKey(kind: RagicDefinitionFormula["formulaKind"]): "f" | "dv_f" {
  return kind === "formula" ? "f" : "dv_f";
}

function formatCyclePath(path: string[], positionByFieldId: ReadonlyMap<string, string>): string {
  return path.map((fieldId) => positionByFieldId.get(fieldId) ?? fieldId).join(" -> ");
}

function extractReferencedFieldIds(
  formula: string,
  fieldIdByPosition: ReadonlyMap<string, string>
): string[] {
  const refs = new Set<string>();
  for (const token of tokenizeFormula(formula)) {
    if (!token.isCellRef) continue;
    const fieldId = fieldIdByPosition.get(token.text);
    if (fieldId) refs.add(fieldId);
  }
  return [...refs];
}

function detectFormulaCycle(params: {
  detail: Awaited<ReturnType<RagicDefinitionsReadService["readForm"]>>;
  targetFieldId: string;
  targetFormulaKind: RagicDefinitionFormula["formulaKind"];
  newFormula: string;
}): string | null {
  const fieldIdByPosition = new Map<string, string>();
  const positionByFieldId = new Map<string, string>();
  for (const field of params.detail.fields) {
    fieldIdByPosition.set(field.position, field.fieldId);
    if (!positionByFieldId.has(field.fieldId)) {
      positionByFieldId.set(field.fieldId, field.position);
    }
  }

  for (const formula of params.detail.formulas) {
    if (!fieldIdByPosition.has(formula.position)) {
      fieldIdByPosition.set(formula.position, formula.fieldId);
    }
    if (!positionByFieldId.has(formula.fieldId)) {
      positionByFieldId.set(formula.fieldId, formula.position);
    }
  }

  const graph = new Map<string, Set<string>>();
  for (const formula of params.detail.formulas) {
    const expression = formula.nuiFormula;
    const refs = extractReferencedFieldIds(expression, fieldIdByPosition);
    if (refs.length === 0) continue;
    const edges = graph.get(formula.fieldId) ?? new Set<string>();
    for (const ref of refs) edges.add(ref);
    graph.set(formula.fieldId, edges);
  }

  const targetRefs = extractReferencedFieldIds(params.newFormula, fieldIdByPosition);
  graph.set(params.targetFieldId, new Set(targetRefs));

  const targetFieldId = params.targetFieldId;
  const findCycle = (
    currentFieldId: string,
    path: string[],
    visiting: Set<string>
  ): string[] | null => {
    for (const nextFieldId of graph.get(currentFieldId) ?? []) {
      if (nextFieldId === targetFieldId) {
        return [...path, nextFieldId];
      }
      if (visiting.has(nextFieldId)) continue;
      visiting.add(nextFieldId);
      const cycle = findCycle(nextFieldId, [...path, nextFieldId], visiting);
      visiting.delete(nextFieldId);
      if (cycle) return cycle;
    }
    return null;
  };

  const cycle = findCycle(targetFieldId, [targetFieldId], new Set([targetFieldId]));
  if (!cycle) return null;
  return `公式會造成循環參照：${formatCyclePath(cycle, positionByFieldId)}，請先調整公式依賴後再試算`;
}

export function createRagicFormulaPatchDryRunService(
  options: RagicFormulaPatchDryRunServiceOptions = {}
) {
  const definitionsService = options.definitionsService ?? ragicDefinitionsReadService;
  const builderRoot = options.builderRoot ?? process.env.RAGIC_BUILDER_PATH ?? "";

  async function dryRunFormulaPatch(
    input: RagicFormulaPatchDryRunRequest
  ): Promise<RagicFormulaPatchDryRunResult> {
    const normalizedFormula = normalizeFormulaForNuiStorageWithMeta(input.newFormula);
    const normalizedInput = {
      ...input,
      newFormula: normalizedFormula.formula,
    };
    const result = emptyResult(normalizedInput);

    if (!normalizedInput.newFormula.trim()) {
      result.blockers.push("newFormula 不能是空字串");
      return result;
    }
    if (normalizedFormula.changedLineBreaks) {
      result.warnings.push(
        "已將公式換行或 Tab 正規化為單一空白，避免 Ragic Builder 寫入 %0A 後無法儲存"
      );
    }
    if (normalizedFormula.changedSeparators) {
      result.warnings.push("已將公式逗號分隔符轉為 Ragic .nui 使用的 backtick 分隔符");
    }

    const state = await definitionsService.getState();
    result.gitClean = state.gitStatus.available ? state.gitStatus.clean : null;
    if (!state.gitStatus.available) {
      result.warnings.push(`無法取得 ragic-definitions Git 狀態：${state.gitStatus.error ?? "unknown"}`);
    } else if (!state.gitStatus.clean) {
      const { scopedEntries, retainedEntries } = splitRawDefinitionsEntriesByFormScope(
        state.gitStatus.entries,
        [normalizedInput.formPath]
      );
      if (scopedEntries.length > 0) {
        result.blockers.push(
          `目前表單 ${normalizedInput.formPath} 的 ragic-definitions 有未提交差異：${scopedEntries.join(" / ")}`
        );
      }
      if (retainedEntries.length > 0) {
        result.warnings.push(
          `ragic-definitions 有其他表單或非表單差異，本次不阻擋：${retainedEntries.join(" / ")}`
        );
      }
    }

    const detail = await definitionsService.readForm(normalizedInput.formPath);
    result.formName = detail.form.formName;
    result.sourceRelativePath = detail.form.sourceRelativePath;

    const formula = detail.formulas.find(
      (item) =>
        item.fieldId === normalizedInput.fieldId && item.formulaKind === normalizedInput.formulaKind
    );
    const field = detail.fields.find((item) => item.fieldId === normalizedInput.fieldId);
    if (!formula && !field) {
      result.blockers.push("baseline fields.json 找不到指定欄位");
      return result;
    }

    result.fieldName = formula?.fieldName ?? field?.fieldName ?? null;
    result.position = formula?.position ?? field?.position ?? null;
    result.sourceLine = formula?.sourceLine ?? field?.sourceLine ?? null;
    result.oldFormula = formula?.nuiFormula ?? null;

    const cycleBlocker = detectFormulaCycle({
      detail,
      targetFieldId: normalizedInput.fieldId,
      targetFormulaKind: normalizedInput.formulaKind,
      newFormula: normalizedInput.newFormula,
    });
    if (cycleBlocker) result.blockers.push(cycleBlocker);

    if (!builderRoot.trim()) {
      result.blockers.push("未設定 RAGIC_BUILDER_PATH，無法定位實際 .nui");
      return result;
    }

    const builderFilePath = resolveInside(builderRoot, detail.form.sourceRelativePath);
    result.builderFilePath = builderFilePath;
    if (!builderFilePath) {
      result.blockers.push("sourceRelativePath 超出 RAGIC_BUILDER_PATH 範圍");
      return result;
    }
    if (!existsSync(builderFilePath)) {
      result.blockers.push(`找不到實際 .nui：${builderFilePath}`);
      return result;
    }

    const bytes = await readFile(builderFilePath);
    const normalizedSourceEncoding = normalizeEncoding(detail.form.sourceEncoding);
    if (!isTextDecoderSupported(normalizedSourceEncoding)) {
      result.blockers.push(
        `sourceEncoding=${detail.form.sourceEncoding} 不在 Node.js TextDecoder 支援範圍，dry-run 先阻擋`
      );
      return result;
    }

    const content = decodeNuiContent(bytes, normalizedSourceEncoding, result.warnings);
    const lines = content.split(/\r?\n/);
    if (!result.sourceLine) {
      result.blockers.push("baseline 缺少 sourceLine，無法定位實際 .nui");
      return result;
    }

    const lineIndex = result.sourceLine - 1;
    const oldLine = lines[lineIndex];
    if (oldLine === undefined) {
      result.blockers.push(`實際 .nui 沒有第 ${result.sourceLine} 行`);
      return result;
    }
    result.oldLinePreview = maskSecrets(oldLine);

    const parsedLine = parseNuiFieldLine(oldLine, result.sourceLine);
    if (!parsedLine) {
      result.blockers.push("sourceLine 不是可解析的 .nui 欄位行");
      return result;
    }

    if (parsedLine.fieldId !== normalizedInput.fieldId) {
      result.blockers.push(
        `sourceLine fieldId 不一致：baseline=${normalizedInput.fieldId}，actual=${parsedLine.fieldId}`
      );
    }
    if (result.fieldName && parsedLine.fieldName !== result.fieldName) {
      result.warnings.push(
        `sourceLine fieldName 與 baseline 不同：baseline=${result.fieldName}，actual=${parsedLine.fieldName}`
      );
    }

    const attrs = parsedLine.attrs;
    const attrKey = formulaAttrKey(normalizedInput.formulaKind);
    const oldAttr = attrs.find((attr) => attr.key === attrKey);
    if (formula && (!oldAttr || oldAttr.rawValue === null)) {
      result.blockers.push(`sourceLine attrs 找不到 ${attrKey}= 公式`);
      return result;
    }
    if (!formula && oldAttr && oldAttr.rawValue !== null && oldAttr.decodedValue.trim() !== "") {
      result.blockers.push(
        `Ragic 現況已不同步，請先按重新匯入同步 definitions 後再試算：baseline=（無公式），actual=${oldAttr.decodedValue}`
      );
    }
    if (
      formula &&
      oldAttr &&
      !isNuiFormulaInSync({
        baselineFormula: formula.nuiFormula,
        liveFormula: oldAttr.decodedValue,
        sourceEncoding: detail.form.sourceEncoding,
        liveRawFormula: oldAttr.rawValue,
      })
    ) {
      result.blockers.push(
        `Ragic 現況已不同步，請先按重新匯入同步 definitions 後再試算：baseline=${formula.nuiFormula}，actual=${oldAttr.decodedValue}`
      );
    }

    const nextAttrs = replaceAttrValue(attrs, attrKey, normalizedInput.newFormula);
    const newLine = [...parsedLine.parts.slice(0, 5), serializeRawAttrs(nextAttrs)].join(",");
    result.newLinePreview = maskSecrets(newLine);
    result.allowed = result.blockers.length === 0;
    return result;
  }

  return {
    dryRunFormulaPatch,
  };
}

export type RagicFormulaPatchDryRunService = ReturnType<
  typeof createRagicFormulaPatchDryRunService
>;

export const ragicFormulaPatchDryRunService = createRagicFormulaPatchDryRunService();
