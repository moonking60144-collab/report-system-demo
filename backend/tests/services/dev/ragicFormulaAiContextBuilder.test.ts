import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../../src/utils/httpError";
import { createRagicFormulaAiContextBuilder } from "../../../src/services/dev/ai/ragicFormulaAiContextBuilder";
import type { RagicDefinitionFormDetail } from "@shared-types/ragicDefinitions";

function duplicateOccurrenceForm(): RagicDefinitionFormDetail {
  return {
    form: {
      schemaVersion: 1,
      formPath: "default/devtest/51",
      formName: "Occurrence Test",
      nuiFile: "51.nui",
      sourceRelativePath: "default/devtest/51.nui",
      sourceEncoding: "utf-8",
      counts: { fields: 2, formulas: 2, workflows: 0 },
    },
    fields: [
      { fieldId: "9001108", fieldName: "測試一", kind: "D", position: "A1", sourceLine: 10, attrs: {} },
      { fieldId: "9001108", fieldName: "測試二", kind: "D", position: "C3", sourceLine: 24, attrs: {} },
    ],
    formulas: [
      { fieldId: "9001108", fieldName: "測試一", position: "A1", formulaKind: "formula", nuiFormula: "B1", displayFormula: "B1", sourceLine: 10 },
      { fieldId: "9001108", fieldName: "測試二", position: "C3", formulaKind: "formula", nuiFormula: "D3", displayFormula: "D3", sourceLine: 24 },
    ],
    workflows: [],
  };
}

function builder() {
  const detail = duplicateOccurrenceForm();
  return createRagicFormulaAiContextBuilder({
    definitionsService: {
      async readForm() { return detail; },
      async search() {
        return {
          data: [],
          meta: {
            count: 0,
            q: "",
            type: "formula" as const,
            formPath: "",
            fieldId: "",
            limit: 12,
            revision: "fixture",
            truncated: false,
          },
        };
      },
    },
    formulaSiblingsService: { async listSiblings() { return { siblings: [] }; } },
  });
}

test("公式 context 對重複 Field ID 要求精確 occurrence", async () => {
  await assert.rejects(
    () => builder().buildContext({
      formPath: "default/devtest/51",
      fieldId: "9001108",
      formulaKind: "formula",
      objective: "修改公式",
      includeSiblings: false,
      includeSimilarFormulas: false,
    }),
    (error) =>
      error instanceof HttpError &&
      error.code === "DEV_AI_TARGET_OCCURRENCE_AMBIGUOUS",
    "FORMULA_CONTEXT_OCCURRENCE_CONTRACT"
  );
});

test("公式 context 以 position 與 sourceLine 命中正確 occurrence", async () => {
  const result = await builder().buildContext({
    formPath: "default/devtest/51",
    fieldId: "9001108",
    position: "C3",
    sourceLine: 24,
    formulaKind: "formula",
    objective: "修改公式",
    includeSiblings: false,
    includeSimilarFormulas: false,
  });

  assert.equal(result.targetPosition, "C3");
  assert.equal(result.targetSourceLine, 24);
  assert.match(result.promptContext, /"position": "C3"/);
  assert.match(result.promptContext, /"formula": "D3"/);
});
