import { env } from "../../../config/env";
import { HttpError } from "../../../utils/httpError";
import {
  ragicDefinitionsReadService,
  type RagicDefinitionsReadService,
} from "../ragicDefinitionsReadService";
import {
  maskSecrets,
} from "../ragicFormulaPatchDryRunService";
import {
  ragicFormulaSiblingsService,
  type RagicFormulaSiblingsService,
} from "../ragicFormulaSiblingsService";
import type {
  RagicDefinitionField,
  RagicDefinitionFormula,
  RagicDefinitionSearchItem,
  RagicFormulaAiContextPreview,
  RagicFormulaAiSuggestRequest,
  RagicFormulaSiblingInfo,
} from "@shared-types/ragicDefinitions";

export interface RagicFormulaAiContext {
  promptContext: string;
  preview: RagicFormulaAiContextPreview;
  fieldsById: Map<string, RagicDefinitionField>;
  positions: Set<string>;
}

export interface RagicFormulaAiContextBuilderDeps {
  definitionsService?: Pick<RagicDefinitionsReadService, "readForm" | "search">;
  formulaSiblingsService?: Pick<RagicFormulaSiblingsService, "listSiblings">;
  maxContextChars?: number;
}

function compactFormula(formula: RagicDefinitionFormula) {
  return {
    fieldId: formula.fieldId,
    fieldName: formula.fieldName,
    position: formula.position,
    formulaKind: formula.formulaKind,
    formula: formula.nuiFormula,
  };
}

function compactField(field: RagicDefinitionField) {
  return {
    fieldId: field.fieldId,
    fieldName: field.fieldName,
    position: field.position,
    kind: field.kind,
  };
}

function compactSibling(sibling: RagicFormulaSiblingInfo) {
  return {
    formPath: sibling.formPath,
    formName: sibling.formName,
    hasField: sibling.hasField,
    fieldPosition: sibling.fieldPosition,
    currentFormula: sibling.currentFormula,
    translatedFormula: sibling.translation?.translated ?? null,
    untranslatable: sibling.translation?.untranslatable ?? [],
  };
}

function compactSimilar(item: RagicDefinitionSearchItem) {
  return {
    type: item.type,
    formPath: item.formPath,
    formName: item.formName,
    fieldId: item.fieldId,
    fieldName: item.fieldName,
    position: item.position,
    formulaKind: item.formulaKind,
    formula: item.nuiFormula,
  };
}

function trimContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 120))}\n...[context trimmed to ${maxChars} chars]`;
}

export function createRagicFormulaAiContextBuilder(
  deps: RagicFormulaAiContextBuilderDeps = {}
) {
  const definitionsService = deps.definitionsService ?? ragicDefinitionsReadService;
  const siblingsService = deps.formulaSiblingsService ?? ragicFormulaSiblingsService;
  const maxContextChars = Math.max(
    4_000,
    Math.trunc(deps.maxContextChars ?? env.DEV_AI_MAX_CONTEXT_CHARS)
  );

  async function buildContext(
    request: RagicFormulaAiSuggestRequest,
    options: { signal?: AbortSignal } = {}
  ): Promise<RagicFormulaAiContext> {
    const detail = await definitionsService.readForm(request.formPath);
    const targetField = detail.fields.find((field) => field.fieldId === request.fieldId);
    if (!targetField) {
      throw new HttpError(404, "找不到指定欄位", "DEV_AI_TARGET_FIELD_NOT_FOUND");
    }
    const currentFormula =
      detail.formulas.find(
        (formula) =>
          formula.fieldId === request.fieldId &&
          formula.formulaKind === request.formulaKind
      ) ?? null;

    const fieldsById = new Map(detail.fields.map((field) => [field.fieldId, field]));
    const positions = new Set(detail.fields.map((field) => field.position));
    const targetFormulaFirst = [
      ...(currentFormula ? [currentFormula] : []),
      ...detail.formulas.filter(
        (formula) =>
          formula.fieldId !== request.fieldId ||
          formula.formulaKind !== request.formulaKind
      ),
    ].slice(0, 30);

    let siblings: RagicFormulaSiblingInfo[] = [];
    if (request.includeSiblings !== false) {
      try {
        siblings = (
          await siblingsService.listSiblings({
            formPath: request.formPath,
            fieldId: request.fieldId,
            formulaKind: request.formulaKind,
            newFormula: currentFormula?.nuiFormula ?? undefined,
            includeFreshness: false,
            includeCurrent: true,
            signal: options.signal,
          })
        ).siblings.slice(0, 12);
      } catch {
        siblings = [];
      }
    }

    let similarItems: RagicDefinitionSearchItem[] = [];
    if (request.includeSimilarFormulas !== false && targetField.fieldName.trim()) {
      try {
        similarItems = (
          await definitionsService.search({
            q: targetField.fieldName,
            type: "formula",
            limit: 12,
          })
        ).data.filter(
          (item) =>
            item.formPath !== request.formPath ||
            item.fieldId !== request.fieldId ||
            item.formulaKind !== request.formulaKind
        );
      } catch {
        similarItems = [];
      }
    }

    const contextObject = {
      instruction:
        "Use only this context. Do not invent fields. Return one Ragic .nui formula for the target field.",
      form: detail.form,
      targetField: compactField(targetField),
      currentFormula: currentFormula ? compactFormula(currentFormula) : null,
      fields: detail.fields.slice(0, 100).map(compactField),
      formulas: targetFormulaFirst.map(compactFormula),
      siblings: siblings.map(compactSibling),
      similarFormulas: similarItems.map(compactSimilar),
    };
    const promptContext = trimContext(
      maskSecrets(JSON.stringify(contextObject, null, 2)),
      maxContextChars
    );

    return {
      promptContext,
      preview: {
        fields: detail.fields.length,
        formulas: targetFormulaFirst.length,
        siblings: siblings.length,
        similarItems: similarItems.length,
        chars: promptContext.length,
      },
      fieldsById,
      positions,
    };
  }

  return { buildContext };
}

export type RagicFormulaAiContextBuilder = ReturnType<
  typeof createRagicFormulaAiContextBuilder
>;
