import type {
  RagicDefinitionField,
  RagicDefinitionFormula,
  RagicDefinitionFormDetail,
} from "@shared-types/ragicDefinitions";

export type RagicFormulaOccurrenceErrorCode =
  | "RAGIC_FORMULA_OCCURRENCE_AMBIGUOUS"
  | "RAGIC_FORMULA_OCCURRENCE_STALE";

export class RagicFormulaOccurrenceError extends Error {
  readonly code: RagicFormulaOccurrenceErrorCode;

  constructor(code: RagicFormulaOccurrenceErrorCode, message: string) {
    super(message);
    this.name = "RagicFormulaOccurrenceError";
    this.code = code;
  }
}

export interface RagicFormulaOccurrenceLocator {
  fieldId: string;
  formulaKind: RagicDefinitionFormula["formulaKind"];
  position?: string | null;
  sourceLine?: number | null;
}

export function ragicFormulaOccurrenceKey(
  target: RagicFormulaOccurrenceLocator & { formPath: string }
): string {
  return [
    target.formPath.trim(),
    target.fieldId.trim(),
    target.formulaKind,
    normalizedPosition(target.position) ?? "legacy",
  ].join("::");
}

export interface ResolvedRagicFormulaOccurrence {
  formula: RagicDefinitionFormula | null;
  field: RagicDefinitionField | null;
  position: string;
  sourceLine: number;
}

function normalizedPosition(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || null;
}

function normalizedSourceLine(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function ambiguous(locator: RagicFormulaOccurrenceLocator, count: number): never {
  throw new RagicFormulaOccurrenceError(
    "RAGIC_FORMULA_OCCURRENCE_AMBIGUOUS",
    `同一 fieldId / formulaKind 找到 ${count} 個 occurrence；請提供 position 與 sourceLine`
  );
}

export function resolveRagicFormulaOccurrence(
  detail: Pick<RagicDefinitionFormDetail, "fields" | "formulas">,
  locator: RagicFormulaOccurrenceLocator
): ResolvedRagicFormulaOccurrence | null {
  const requestedPosition = normalizedPosition(locator.position);
  const requestedSourceLine = normalizedSourceLine(locator.sourceLine);
  const formulaCandidates = detail.formulas.filter(
    (formula) =>
      formula.fieldId === locator.fieldId &&
      formula.formulaKind === locator.formulaKind &&
      (!requestedPosition || normalizedPosition(formula.position) === requestedPosition)
  );

  if (formulaCandidates.length > 1) {
    ambiguous(locator, formulaCandidates.length);
  }

  const formula = formulaCandidates[0] ?? null;
  const occurrencePosition = requestedPosition ?? normalizedPosition(formula?.position);
  const fieldCandidates = detail.fields.filter(
    (field) =>
      field.fieldId === locator.fieldId &&
      (!occurrencePosition || normalizedPosition(field.position) === occurrencePosition)
  );

  if (!formula && fieldCandidates.length > 1) {
    ambiguous(locator, fieldCandidates.length);
  }

  const field =
    fieldCandidates.find(
      (candidate) => normalizedPosition(candidate.position) === normalizedPosition(formula?.position)
    ) ??
    fieldCandidates[0] ??
    null;
  if (!formula && !field) return null;

  const position = normalizedPosition(formula?.position ?? field?.position);
  const sourceLine = formula?.sourceLine ?? field?.sourceLine ?? 0;
  if (!position || sourceLine <= 0) return null;

  if (requestedSourceLine !== null && sourceLine !== requestedSourceLine) {
    throw new RagicFormulaOccurrenceError(
      "RAGIC_FORMULA_OCCURRENCE_STALE",
      `公式 occurrence 已變更：expected sourceLine=${requestedSourceLine}，actual=${sourceLine}`
    );
  }

  return { formula, field, position, sourceLine };
}

export function resolveRagicFormulaFromList(
  formulas: readonly RagicDefinitionFormula[],
  locator: RagicFormulaOccurrenceLocator
): RagicDefinitionFormula | null {
  return (
    resolveRagicFormulaOccurrence(
      { fields: [], formulas: [...formulas] },
      locator
    )?.formula ?? null
  );
}
