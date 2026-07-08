import type {
  RagicFormulaAiSuggestResult,
  RagicFormulaPatchDryRunInput,
} from "../../../api/devRagicDefinitions";
import type { DevAiSpeedMode } from "@shared-types/ragicDefinitions";

export function isAiSuggestionForDraft(
  result: Pick<RagicFormulaAiSuggestResult, "formPath" | "fieldId" | "formulaKind"> | null,
  draft: Pick<RagicFormulaPatchDryRunInput, "formPath" | "fieldId" | "formulaKind">
): boolean {
  return Boolean(
    result &&
      result.formPath === draft.formPath.trim() &&
      result.fieldId === draft.fieldId.trim() &&
      result.formulaKind === draft.formulaKind
  );
}

export interface DevAiContextStatusInput {
  formPath?: string;
  fieldId?: string;
  includeKnowledge: boolean;
  includeDefinitions: boolean;
  speedMode: DevAiSpeedMode;
}

export function shouldDefaultIncludeDefinitions(formPath: string | undefined): boolean {
  return Boolean(formPath?.trim());
}

export function devAiContextStatusLabel(input: DevAiContextStatusInput): string {
  const speed = input.speedMode === "deep"
    ? "Deep"
    : input.speedMode === "balanced"
      ? "Balanced"
      : "Fast";
  const scope = input.formPath?.trim()
    ? input.fieldId?.trim()
      ? "已帶入目前欄位"
      : "已帶入目前表單"
    : "自動選擇脈絡";
  const sources = [
    input.includeKnowledge ? "本地知識" : "不查知識",
    input.includeDefinitions || input.formPath?.trim() ? "definitions" : "需要時查 definitions",
  ];
  return `${speed} · ${scope} · ${sources.join(" + ")}`;
}
