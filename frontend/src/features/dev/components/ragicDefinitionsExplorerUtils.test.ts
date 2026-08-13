import { describe, expect, it } from "vitest";
import {
  canPushBaselineWithAutoSync,
  createFormulaDryRunDraft,
  createFormulaPatchErrorDialogContext,
  createWorkflowOutline,
  extractRagicFormPath,
  formatRemoteDelta,
  isCompleteFormPath,
} from "./ragicDefinitionsExplorerUtils";
import type {
  RagicDefinitionFormDetail,
  RagicDefinitionFormula,
  RagicDefinitionsVersionControlStatus,
} from "../../../api/devRagicDefinitions";

function status(
  patch: Partial<RagicDefinitionsVersionControlStatus>
): RagicDefinitionsVersionControlStatus {
  return {
    gitAvailable: true,
    repoRoot: "/repo",
    definitionsRoot: "/repo/ragic-definitions",
    definitionsPathspec: "ragic-definitions",
    branch: "main",
    lastCommit: "abcdef1",
    remoteTrackingBranch: "origin/main",
    ahead: 0,
    behind: 0,
    clean: true,
    definitionsClean: true,
    canCommit: false,
    canPush: false,
    canAutoSyncPush: false,
    entries: [],
    definitionsEntries: [],
    outsideEntries: [],
    blockers: [],
    warnings: [],
    error: null,
    ...patch,
  };
}

describe("ragicDefinitionsExplorerUtils", () => {
  it("可從 Ragic URL 解析表單路徑", () => {
    expect(
      extractRagicFormPath("https://demo.local/default/forms8/92/1?PAGEID=abc")
    ).toBe("default/forms8/92");
    expect(extractRagicFormPath("/default/devtest/51/1")).toBe(
      "default/devtest/51"
    );
    expect(isCompleteFormPath("default/devtest/51")).toBe(true);
  });

  it("建立公式 dry-run 草稿時同步表單、欄位與公式類型", () => {
    const formula: RagicDefinitionFormula = {
      fieldId: "1006410",
      fieldName: "測試公式",
      position: "B131",
      formulaKind: "formula",
      nuiFormula: "IF(E4.RAW==\"委外\"`B5+\"-\"+D29+\"-DEFAULT\"`\"\")",
      displayFormula: "IF(E4.RAW==\"委外\",B5+\"-\"+D29+\"-DEFAULT\",\"\")",
      sourceLine: 850,
    };

    expect(createFormulaDryRunDraft("default/forms8/92", formula)).toEqual({
      formPath: "default/forms8/92",
      fieldId: "1006410",
      formulaKind: "formula",
      newFormula: formula.nuiFormula,
    });
  });

  it("格式化 origin/main ahead behind 狀態", () => {
    expect(formatRemoteDelta(status({ ahead: 0, behind: 0 }))).toBe(
      "與 origin/main 同步"
    );
    expect(formatRemoteDelta(status({ ahead: 2, behind: 0 }))).toBe("領先 2");
    expect(formatRemoteDelta(status({ ahead: 1, behind: 3 }))).toBe(
      "領先 1 · 落後 3"
    );
    expect(formatRemoteDelta(status({ ahead: null, behind: null }))).toBe(
      "remote 狀態未知"
    );
  });

  it("ahead/behind 且只有 remote behind blocker 時可交給 push 自動同步", () => {
    expect(
      canPushBaselineWithAutoSync(
        status({
          ahead: 1,
          behind: 1,
          canAutoSyncPush: true,
          blockers: ["origin/main 有 1 個新提交，先同步後再操作 baseline"],
        })
      )
    ).toBe(true);
    expect(
      canPushBaselineWithAutoSync(
        status({
          ahead: 1,
          behind: 1,
          blockers: ["origin/main 有 1 個新提交，先同步後再操作 baseline"],
        })
      )
    ).toBe(true);
    expect(canPushBaselineWithAutoSync(status({ canPush: true, ahead: 1 }))).toBe(
      true
    );
    expect(
      canPushBaselineWithAutoSync(
        status({
          ahead: 1,
          behind: 1,
          blockers: ["origin/main 有 1 個新提交，先同步後再操作 baseline"],
          entries: [
            {
              raw: " M ragic-definitions/forms/default/devtest/51/formulas.json",
              status: "M",
              path: "ragic-definitions/forms/default/devtest/51/formulas.json",
              inDefinitions: true,
              formPath: "default/devtest/51",
            },
          ],
        })
      )
    ).toBe(false);
  });

  it("workflow outline 區分已知欄位、未知 fieldId 與引用的 target sheet", () => {
    const detail: RagicDefinitionFormDetail = {
      form: {
        schemaVersion: 1,
        formPath: "default/forms8/92",
        formName: "工令單",
        nuiFile: "92.nui",
        sourceEncoding: "UTF-8",
        sourceRelativePath: "default/forms8/92",
        counts: { fields: 2, formulas: 0, workflows: 0 },
      },
      fields: [
        { fieldId: "1006410", fieldName: "件號", kind: "text", position: "B5", sourceLine: 10, attrs: {} },
        { fieldId: "1006411", fieldName: "數量", kind: "number", position: "C5", sourceLine: 11, attrs: {} },
      ],
      formulas: [],
      workflows: [],
    };
    const content =
      "rows.get('1006410'); rows.get('9999999');\n" +
      "linkTo('default/forms8/92'); linkTo('default/forms12/8');";
    const outline = createWorkflowOutline(content, detail);
    expect(outline.referencedFields).toEqual([
      { fieldId: "1006410", fieldName: "件號", position: "B5" },
    ]);
    expect(outline.unknownFieldIds).toEqual(["9999999"]);
    expect(outline.targetSheets).toEqual([
      "default/forms8/92",
      "default/forms12/8",
    ]);
  });

  it("可建立 formula patch 錯誤彈窗 context 並萃取關鍵欄位", () => {
    const context = createFormulaPatchErrorDialogContext({
      title: "套用失敗",
      message: "有阻擋原因",
      blockers: ["  blocker-a  ", "", "blocker-b", "blocker-a"],
      warnings: ["warning-a", 10, "warning-b"],
      fatalValidationErrors: ["fatal-a", "fatal-a", "  fatal-b  "],
      payload: {
        formPath: "default/forms8/92",
        sourceEncoding: "UTF-8",
        requestId: "req-001",
        traceId: "trace-001",
        nested: {
          form: {
            sourceEncoding: "UTF-8-Alt",
          },
          builderFilePath: "default/forms8/92.nui",
          formPaths: ["should-not-collect"],
          sourceRelativePath: "default/forms8/92",
          validationErrors: ["payload-validation"],
          extra: {
            fatalValidationErrors: ["extra-fatal"],
            formPath: "default/forms12/8",
          },
          results: [
            {
              formPath: "default/forms99/1",
              sourceEncoding: "UTF-16",
              sheetPath: "sheet/9",
            },
          ],
        },
      },
    });

    expect(context.title).toBe("套用失敗");
    expect(context.message).toBe("有阻擋原因");
    expect(context.blockers).toEqual(["blocker-a", "blocker-b", "blocker-a"]);
    expect(context.warnings).toEqual(["warning-a", "warning-b"]);
    expect(context.fatalValidationErrors).toHaveLength(4);
    expect(context.fatalValidationErrors).toEqual(
      expect.arrayContaining([
        "fatal-a",
        "fatal-b",
        "payload-validation",
        "extra-fatal",
      ])
    );
    expect(context.formPaths).toHaveLength(3);
    expect(context.formPaths).toEqual(
      expect.arrayContaining([
        "default/forms8/92",
        "default/forms99/1",
        "default/forms12/8",
      ])
    );
    expect(context.sheetPath).toBe("sheet/9");
    expect(context.sourceEncoding).toBe("UTF-8");
    expect(context.requestId).toBe("req-001");
    expect(context.traceId).toBe("trace-001");
    expect(context.raw).toContain("\"traceId\": \"trace-001\"");
  });

  it("空 payload 也要回傳可安全複製的 raw", () => {
    const context = createFormulaPatchErrorDialogContext({
      title: "試算失敗",
      message: "無回傳",
      payload: undefined,
    });
    expect(context.raw).toBe("（無原始回應可顯示）");
    expect(context.formPaths).toEqual([]);
    expect(context.fatalValidationErrors).toEqual([]);
  });
});
