import { useEffect, useRef, useState } from "react";
import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import type {
  RagicDefinitionFormula,
  RagicDefinitionFormDetail,
} from "../../../api/devRagicDefinitions";
import { DependencyList } from "./RagicDefinitionsInspector";
import {
  FORMULA_KIND_LABELS,
  type WorkflowOutline,
} from "./ragicDefinitionsExplorerUtils";
import type { FormWorkflow } from "./ragicDefinitionsExplorerTypes";
import { FormulaSyntax, JavaScriptSyntax } from "./ragicDefinitionsSyntax";

export function FormulaTable({
  formulas,
  emptyText,
  selectedFormula,
  onSelectFormula,
  versionFamilyAvailable = false,
  onShowVersions,
}: {
  formulas: RagicDefinitionFormDetail["formulas"];
  emptyText: string;
  selectedFormula: RagicDefinitionFormula | null;
  onSelectFormula: (formula: RagicDefinitionFormula) => void;
  /** 此表單存在多版本家族時顯示「版本」操作 */
  versionFamilyAvailable?: boolean;
  onShowVersions?: (formula: RagicDefinitionFormula) => void;
}) {
  return (
    <section className="ragic-defs__block">
      <div className="ragic-defs__panel-head">
        <strong>公式</strong>
        <span>{formulas.length}</span>
      </div>
      {formulas.length === 0 ? (
        <p className="ragic-inline__hint">{emptyText}</p>
      ) : (
        <div className="ragic-defs__table-wrap">
          <table className="ragic-defs__table ragic-defs__formula-table">
            <thead>
              <tr>
                <th>欄位</th>
                <th>類型</th>
                <th>公式</th>
                <th>行號</th>
                <th className="ragic-defs__action-col">操作</th>
              </tr>
            </thead>
            <tbody>
              {formulas.map((formula) => (
                <tr
                  key={`${formula.fieldId}:${formula.formulaKind}`}
                  className={
                    selectedFormula?.fieldId === formula.fieldId &&
                    selectedFormula?.formulaKind === formula.formulaKind
                      ? "is-selected"
                      : ""
                  }
                  onClick={() => onSelectFormula(formula)}
                >
                  <td className="ragic-defs__field-cell">
                    <strong>{formula.fieldName}</strong>
                    <code>
                      {formula.fieldId} · {formula.position}
                    </code>
                  </td>
                  <td>{FORMULA_KIND_LABELS[formula.formulaKind]}</td>
                  <td className="ragic-defs__formula-cell">
                    <FormulaSyntax value={formula.displayFormula} title={formula.displayFormula} />
                  </td>
                  <td>{formula.sourceLine}</td>
                  <td className="ragic-defs__action-col">
                    {versionFamilyAvailable && onShowVersions ? (
                      <button
                        type="button"
                        className="dev-mode-btn ragic-defs__table-action"
                        title="此欄位存在於多版本表單，查看各版本設定"
                        onClick={(event) => {
                          event.stopPropagation();
                          onShowVersions(formula);
                        }}
                      >
                        版本↗
                      </button>
                    ) : (
                      <span className="ragic-defs__action-placeholder">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function WorkflowPanel({
  workflows,
  activeScope,
  activeWorkflow,
  outline,
  onSelectScope,
}: {
  workflows: RagicDefinitionFormDetail["workflows"];
  activeScope: string | null;
  activeWorkflow: FormWorkflow | null;
  outline: WorkflowOutline;
  onSelectScope: (scope: string) => void;
}) {
  return (
    <section className="ragic-defs__block ragic-defs__workflow-shell">
      <div className="ragic-defs__panel-head">
        <strong>Workflow 依賴</strong>
        <span>{workflows.length}</span>
      </div>
      {workflows.length === 0 ? (
        <p className="ragic-inline__hint">沒有 Workflow 依賴</p>
      ) : (
        <>
          <div className="ragic-defs__workflow-tabs">
            {workflows.map((workflow) => (
              <button
                key={workflow.scope}
                type="button"
                className={activeScope === workflow.scope ? "is-active" : ""}
                onClick={() => onSelectScope(workflow.scope)}
              >
                {workflow.scope}
              </button>
            ))}
          </div>
          <div className="ragic-defs__workflow-grid">
            <CodeViewer
              title={activeScope ?? "workflow"}
              source={activeWorkflow?.fileName ?? "workflow.js"}
              content={activeWorkflow?.content ?? ""}
            />
            <WorkflowOutlinePanel outline={outline} />
          </div>
        </>
      )}
    </section>
  );
}

function CodeViewer({
  title,
  source,
  content,
}: {
  title: string;
  source: string;
  content: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<number | null>(null);
  const lines = content ? content.split(/\r?\n/) : [""];

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    },
    []
  );

  const scheduleCopyStateReset = () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1500);
  };

  const handleCopyWorkflow = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    } finally {
      scheduleCopyStateReset();
    }
  };

  return (
    <div className="ragic-defs__code-viewer">
      <div className="ragic-defs__code-head">
        <strong>{title}</strong>
        <span>{lines.length.toLocaleString()} 行</span>
        <code>{source}</code>
        <button
          type="button"
          className={`dev-mode-btn ragic-defs__code-copy${
            copyState === "copied"
              ? " is-copied"
              : copyState === "failed"
                ? " is-failed"
                : ""
          }`}
          disabled={!content}
          onClick={handleCopyWorkflow}
          title="複製目前 workflow 完整原文"
        >
          {copyState === "copied" ? <CheckOutlined /> : <CopyOutlined />}
          {copyState === "copied" ? "已複製" : copyState === "failed" ? "失敗" : "複製"}
        </button>
      </div>
      <ol className="ragic-defs__code-lines">
        {lines.map((line, index) => (
          <li key={`${index}:${line}`}>
            <JavaScriptSyntax value={line || " "} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function WorkflowOutlinePanel({ outline }: { outline: WorkflowOutline }) {
  return (
    <aside className="ragic-defs__workflow-outline">
      <div className="ragic-defs__inspector-section">
        <strong>依賴摘要</strong>
        <dl className="ragic-defs__kv">
          <div>
            <dt>行數</dt>
            <dd>{outline.lineCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>目標表單</dt>
            <dd>{outline.targetSheets.length.toLocaleString()}</dd>
          </div>
        </dl>
      </div>
      <DependencyList
        title="引用欄位"
        emptyText="沒有在 workflow 內找到目前表單欄位 ID"
        items={outline.referencedFields.slice(0, 12).map((field) => ({
          key: field.fieldId,
          title: field.fieldName,
          meta: `${field.fieldId} · ${field.position}`,
        }))}
        overflowCount={Math.max(0, outline.referencedFields.length - 12)}
      />
      <DependencyList
        title="未知欄位 ID"
        emptyText="沒有未知欄位 ID"
        items={outline.unknownFieldIds.slice(0, 10).map((fieldId) => ({
          key: fieldId,
          title: fieldId,
          meta: "未在目前表單定義找到",
        }))}
        overflowCount={Math.max(0, outline.unknownFieldIds.length - 10)}
      />
      <DependencyList
        title="目標表單"
        emptyText="沒有偵測到表單路徑"
        items={outline.targetSheets.slice(0, 8).map((sheet) => ({
          key: sheet,
          title: sheet,
        }))}
        overflowCount={Math.max(0, outline.targetSheets.length - 8)}
      />
    </aside>
  );
}

export function FieldTable({
  fields,
  emptyText,
  selectedField,
  onSelectField,
}: {
  fields: RagicDefinitionFormDetail["fields"];
  emptyText: string;
  selectedField: RagicDefinitionFormDetail["fields"][number] | null;
  onSelectField: (field: RagicDefinitionFormDetail["fields"][number]) => void;
}) {
  return (
    <section className="ragic-defs__block">
      <div className="ragic-defs__panel-head">
        <strong>欄位</strong>
        <span>{fields.length}</span>
      </div>
      {fields.length === 0 ? (
        <p className="ragic-inline__hint">{emptyText}</p>
      ) : (
        <div className="ragic-defs__table-wrap">
          <table className="ragic-defs__table">
            <thead>
              <tr>
                <th>欄位</th>
                <th>類型</th>
                <th>行號</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr
                  key={field.fieldId}
                  className={selectedField?.fieldId === field.fieldId ? "is-selected" : ""}
                  onClick={() => onSelectField(field)}
                >
                  <td className="ragic-defs__field-cell">
                    <strong>{field.fieldName}</strong>
                    <code>
                      {field.fieldId} · {field.position}
                    </code>
                  </td>
                  <td>{field.kind}</td>
                  <td>{field.sourceLine}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
