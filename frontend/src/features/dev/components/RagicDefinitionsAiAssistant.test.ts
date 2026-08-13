import { describe, expect, it } from "vitest";
import {
  clampDevAiLauncherPosition,
  devAiContextStatusLabel,
  devAiKnowledgeSourceLabel,
  devAiKnowledgeSourcesFromUnknown,
  getDevAiPanelPosition,
  isAiSuggestionForDraft,
  parseDevAiLauncherPosition,
  readDevAiLauncherPosition,
  shouldDefaultIncludeDefinitions,
  writeDevAiLauncherPosition,
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

describe("Dev AI source evidence", () => {
  it("definitions 來源會顯示表單、Field ID 與短版 revision", () => {
    expect(
      devAiKnowledgeSourceLabel({
        sourceId: "definitions:default/devtest/7:field:1040347:L6",
        title: "TestForm1 · Name",
        kind: "definitions",
        excerpt: "欄位設定：{\"l\":\"1040341\"}",
        score: 10,
        path: "default/devtest/7",
        revision: `sha256:${"a".repeat(64)}`,
        sourceType: "field",
        formPath: "default/devtest/7",
        fieldId: "1040347",
      })
    ).toContain("[default/devtest/7 · Field 1040347 · 欄位 · rev aaaaaaaa]");
  });

  it("只接受可辨識的 persisted source payload", () => {
    expect(
      devAiKnowledgeSourcesFromUnknown([
        {
          sourceId: "curated:test",
          title: "測試",
          kind: "curated",
          excerpt: "內容",
          score: 1,
        },
        { sourceId: "broken" },
      ])
    ).toHaveLength(1);
  });
});

describe("Dev AI 浮動入口位置", () => {
  it("拖曳位置保持在 viewport 安全邊界內", () => {
    const viewport = { width: 1280, height: 720 };
    const launcher = { width: 64, height: 48 };

    expect(clampDevAiLauncherPosition({ x: -100, y: 900 }, viewport, launcher, 12)).toEqual({
      x: 12,
      y: 660,
    });
    expect(clampDevAiLauncherPosition({ x: 420, y: 240 }, viewport, launcher, 12)).toEqual({
      x: 420,
      y: 240,
    });
  });

  it("只讀取有效的本機位置資料", () => {
    expect(parseDevAiLauncherPosition('{"x":120,"y":240}')).toEqual({ x: 120, y: 240 });
    expect(parseDevAiLauncherPosition('{"x":"120","y":240}')).toBeNull();
    expect(parseDevAiLauncherPosition("broken-json")).toBeNull();
  });

  it("瀏覽器拒絕 storage 時仍可使用預設位置並繼續拖曳", () => {
    const blockedStorage = {
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem() {
        throw new DOMException("blocked", "SecurityError");
      },
    };

    expect(readDevAiLauncherPosition(() => blockedStorage)).toBeNull();
    expect(() =>
      writeDevAiLauncherPosition({ x: 120, y: 240 }, () => blockedStorage)
    ).not.toThrow();
    expect(readDevAiLauncherPosition(() => {
      throw new DOMException("storage unavailable", "SecurityError");
    })).toBeNull();
    expect(() =>
      writeDevAiLauncherPosition({ x: 120, y: 240 }, () => {
        throw new DOMException("storage unavailable", "SecurityError");
      })
    ).not.toThrow();
  });

  it("面板依 launcher 所在象限向畫面內側展開", () => {
    const viewport = { width: 1280, height: 800 };
    const launcher = { width: 68, height: 48 };
    const panel = { width: 600, height: 640 };

    expect(
      getDevAiPanelPosition({ x: 28, y: 726 }, viewport, launcher, panel, 12, 12)
    ).toEqual({ x: 28, y: 74 });
    expect(
      getDevAiPanelPosition({ x: 1188, y: 726 }, viewport, launcher, panel, 12, 12)
    ).toEqual({ x: 656, y: 74 });
    expect(
      getDevAiPanelPosition({ x: 28, y: 12 }, viewport, launcher, panel, 12, 12)
    ).toEqual({ x: 28, y: 72 });
  });
});
