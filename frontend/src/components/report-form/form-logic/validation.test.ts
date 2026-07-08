import { describe, expect, it } from "vitest";
import { EMPTY_FORM } from "../constants";
import { validate } from "./validation";
import type { FormState, TranslateFunction } from "../types";

const tr: TranslateFunction = (key, options) => {
  if (key === "workReport:reportForm.validation.requiredField") {
    return `required:${String(options?.field ?? "")}`;
  }
  return key;
};

function createValidState(): FormState {
  return {
    ...EMPTY_FORM,
    date: "2026/07/01",
    processCode: "TI",
    machineId: "P10",
    operatorId: "RA004",
    startTime: "08:00",
    endTime: "17:00",
    productionQty: "10",
  };
}

describe("report form validation", () => {
  it("requires processCode before submit", () => {
    expect(validate({ ...createValidState(), processCode: "" }, tr)).toBe(
      "required:workReport:reportForm.fields.processCodeRequired"
    );
  });
});
