import { describe, expect, it } from "vitest";
import { EMPTY_FORM } from "../../../components/report-form/constants";
import { isInlineFieldEmpty } from "../hooks/detail/inlineControllerUtils";
import {
  BATCH_CREATE_FILLABLE_KEYS,
  buildBatchCreateFieldErrors,
  resolveBatchCreateFillKeys,
} from "./detailBatchCreateUtils";
import type { FormState } from "../../../components/report-form/types";

function createValidDraft(): FormState {
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

describe("detail batch create validation", () => {
  it("blocks rows without processCode", () => {
    const errors = buildBatchCreateFieldErrors(
      { ...createValidDraft(), processCode: "" },
      (_key, options) => `required:${String(options?.field ?? "")}`
    );

    expect(errors.processCode).toBe("required:processCode");
  });

  it("keeps plannedIdle editable in batch create fill flow", () => {
    expect(BATCH_CREATE_FILLABLE_KEYS.has("plannedIdle")).toBe(true);
    expect(resolveBatchCreateFillKeys("date", "processCode")).toEqual([
      "date",
      "plannedIdle",
      "processCode",
    ]);
  });

  it("includes blank plannedIdle in enter navigation so the dash option can be confirmed", () => {
    expect(isInlineFieldEmpty("plannedIdle", EMPTY_FORM)).toBe(true);
    expect(isInlineFieldEmpty("plannedIdle", { ...EMPTY_FORM, plannedIdle: "No" })).toBe(false);
  });
});
