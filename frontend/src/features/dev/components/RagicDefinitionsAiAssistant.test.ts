import { describe, expect, it } from "vitest";
import {
  devAiContextStatusLabel,
  isAiSuggestionForDraft,
  shouldDefaultIncludeDefinitions,
} from "./RagicDefinitionsAiAssistantUtils";

describe("isAiSuggestionForDraft", () => {
  it("只允許目前欄位對應的 AI suggestion 被顯示或帶入", () => {
    const result = {
      formPath: "default/devtest/51",
      fieldId: "1036641",
      formulaKind: "formula" as const,
    };

    expect(
      isAiSuggestionForDraft(result, {
        formPath: " default/devtest/51 ",
        fieldId: " 1036641 ",
        formulaKind: "formula",
      })
    ).toBe(true);
    expect(
      isAiSuggestionForDraft(result, {
        formPath: "default/devtest/51",
        fieldId: "1036621",
        formulaKind: "formula",
      })
    ).toBe(false);
    expect(
      isAiSuggestionForDraft(result, {
        formPath: "default/devtest/51",
        fieldId: "1036641",
        formulaKind: "defaultFormula",
      })
    ).toBe(false);
  });

  it("沒有 suggestion 時不可帶入", () => {
    expect(
      isAiSuggestionForDraft(null, {
        formPath: "default/devtest/51",
        fieldId: "1036641",
        formulaKind: "formula",
      })
    ).toBe(false);
  });
});

describe("Dev AI context defaults", () => {
  it("definitions 頁面有表單脈絡時預設帶 definitions", () => {
    expect(shouldDefaultIncludeDefinitions("default/devtest/51")).toBe(true);
    expect(shouldDefaultIncludeDefinitions("   ")).toBe(false);
  });

  it("主畫面顯示自動脈絡狀態，不暴露成必選 debug checkbox", () => {
    expect(
      devAiContextStatusLabel({
        formPath: "default/devtest/51",
        fieldId: "1036621",
        includeKnowledge: true,
        includeDefinitions: true,
        speedMode: "fast",
      })
    ).toBe("Fast · 已帶入目前欄位 · 本地知識 + definitions");
    expect(
      devAiContextStatusLabel({
        includeKnowledge: true,
        includeDefinitions: false,
        speedMode: "balanced",
      })
    ).toBe("Balanced · 自動選擇脈絡 · 本地知識 + 需要時查 definitions");
  });
});
