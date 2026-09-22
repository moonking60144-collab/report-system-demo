import type { Dispatch, SetStateAction } from "react";
import {
  CloseOutlined,
  FullscreenOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type {
  RagicDefinitionFormula,
  RagicDefinitionFormDetail,
  RagicFormulaPatchApplyResult,
  RagicFormulaPatchBatchApplyResult,
  RagicFormulaPatchDryRunInput,
  RagicFormulaPatchDryRunResult,
} from "../../../api/devRagicDefinitions";
import { ResultList } from "./RagicDefinitionsVersionPanel";
import {
  FORMULA_KIND_LABELS,
  type WorkflowOutline,
} from "./ragicDefinitionsExplorerUtils";
import type { FormField, FormWorkflow } from "./ragicDefinitionsExplorerTypes";
import { FormulaSyntax } from "./ragicDefinitionsSyntax";
import {
  FormulaSiblingsPanel,
  type SiblingApplyTarget,
  type SiblingSelectionState,
} from "./RagicFormulaSiblingsPanel";

export function InspectorPanel({
  token,
  detail,
  selectedFormula,
  selectedField,
  selectedWorkflow,
  workflowOutline,
  dryRunDraft,
  dryRunResult,
  dryRunError,
  dryRunLoading,
  applyResult,
  batchApplyResult,
  applyError,
  applyLoading,
  canApply,
  siblingTargetCount,
  siblingSelectionState,
  siblingsRefreshNonce,
  onDryRunChange,
  onApply,
  onSiblingsTargetsChange,
  onSiblingsSelectionStateChange,
  onSiblingsError,
  modal = false,
  onOpenModal,
  onCloseModal,
}: {
  token: string;
  detail: RagicDefinitionFormDetail;
  selectedFormula: RagicDefinitionFormula | null;
  selectedField: FormField | null;
  selectedWorkflow: FormWorkflow | null;
  workflowOutline: WorkflowOutline;
  dryRunDraft: RagicFormulaPatchDryRunInput;
  dryRunResult: RagicFormulaPatchDryRunResult | null;
  dryRunError: string | null;
  dryRunLoading: boolean;
  applyResult: RagicFormulaPatchApplyResult | null;
  batchApplyResult: RagicFormulaPatchBatchApplyResult | null;
  applyError: string | null;
  applyLoading: boolean;
  canApply: boolean;
  /** 跨版本面板勾選的張數（套用按鈕顯示「含 N 張版本」） */
  siblingTargetCount: number;
  /** 跨版本面板勾選列的檢查狀態，用來避免 pending/blocked 時套用 */
  siblingSelectionState: SiblingSelectionState;
  /** 批次套用成功後 bump，讓跨版本面板重查足跡 */
  siblingsRefreshNonce: number;
  onDryRunChange: Dispatch<SetStateAction<RagicFormulaPatchDryRunInput>>;
  onApply: () => void;
  onSiblingsTargetsChange: (targets: SiblingApplyTarget[]) => void;
  onSiblingsSelectionStateChange: (state: SiblingSelectionState) => void;
  /** 與 Explorer 共用的統一錯誤處理（401 → 重新登入） */
  onSiblingsError: (err: unknown, fallback: string) => string | null;
  modal?: boolean;
  onOpenModal?: () => void;
  onCloseModal?: () => void;
}) {
  const isFormulaSelected = selectedFormula !== null;
  const metaPanel = (
    <InspectorMetaPanel
      detail={detail}
      modal={modal}
      onOpenModal={onOpenModal}
      onCloseModal={onCloseModal}
    />
  );
  const selectedTargetPanel = (
    <SelectedTargetPanel
      formula={selectedFormula}
      field={selectedField}
      workflow={selectedWorkflow}
      outline={workflowOutline}
    />
  );

  return (
    <aside
      className={`ragic-defs__inspector${
        modal
          ? " ragic-defs__inspector--modal ragic-defs__inspector--wide"
          : " ragic-defs__inspector--inline"
      }`}
      aria-label="definition inspector"
    >
      {modal ? (
        <>
          {metaPanel}
          {selectedTargetPanel}

          <FormulaDryRunPanel
            draft={dryRunDraft}
            result={dryRunResult}
            error={dryRunError}
            loading={dryRunLoading}
            applyResult={applyResult}
            batchApplyResult={batchApplyResult}
            applyError={applyError}
            applyLoading={applyLoading}
            canApply={canApply}
            siblingTargetCount={siblingTargetCount}
            siblingSelectionState={siblingSelectionState}
            onChange={onDryRunChange}
            onApply={onApply}
          />

          <FormulaSiblingsPanel
            token={token}
            draft={dryRunDraft}
            refreshNonce={siblingsRefreshNonce}
            onTargetsChange={onSiblingsTargetsChange}
            onSelectionStateChange={onSiblingsSelectionStateChange}
            onError={onSiblingsError}
          />
        </>
      ) : (
        <>
          <div className="ragic-defs__inspector-scroll">
            {metaPanel}
            {selectedTargetPanel}
          </div>
          <InspectorInlineAction
            canEdit={isFormulaSelected}
            result={dryRunResult}
            loading={dryRunLoading || applyLoading}
            onOpenModal={onOpenModal}
          />
        </>
      )}
    </aside>
  );
}

function InspectorMetaPanel({
  detail,
  modal,
  onOpenModal,
  onCloseModal,
}: {
  detail: RagicDefinitionFormDetail;
  modal: boolean;
  onOpenModal?: () => void;
  onCloseModal?: () => void;
}) {
  return (
    <section className="ragic-defs__inspector-section ragic-defs__inspector-section--meta">
      <div className="ragic-defs__inspector-head">
        <strong>{modal ? "完整檢查器" : "檢查器"}</strong>
        <div className="ragic-defs__inspector-actions">
          {modal ? (
            <button
              type="button"
              className="ragic-defs__inspector-icon ragic-defs__inspector-icon--close"
              onClick={onCloseModal}
              aria-label="關閉獨立檢查器"
              title="關閉獨立檢查器"
            >
              <CloseOutlined />
            </button>
          ) : (
            <button
              type="button"
              className="ragic-defs__inspector-icon ragic-defs__inspector-icon--open"
              onClick={onOpenModal}
              aria-label="打開獨立檢查器"
              title="打開獨立檢查器"
            >
              <FullscreenOutlined />
            </button>
          )}
        </div>
      </div>
      <dl className="ragic-defs__kv">
        <div>
          <dt>表單</dt>
          <dd>{detail.form.formName || "(未命名)"}</dd>
        </div>
        <div>
          <dt>路徑</dt>
          <dd>
            <code>{detail.form.formPath}</code>
          </dd>
        </div>
        {modal ? (
          <>
            <div>
              <dt>NUI</dt>
              <dd>
                <code>{detail.form.sourceRelativePath}</code>
              </dd>
            </div>
            <div>
              <dt>編碼</dt>
              <dd>{detail.form.sourceEncoding}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {!modal ? (
        <details className="ragic-defs__inspector-meta-more">
          <summary>來源 metadata</summary>
          <dl className="ragic-defs__kv">
            <div>
              <dt>NUI</dt>
              <dd>
                <code>{detail.form.sourceRelativePath}</code>
              </dd>
            </div>
            <div>
              <dt>編碼</dt>
              <dd>{detail.form.sourceEncoding}</dd>
            </div>
          </dl>
        </details>
      ) : null}
    </section>
  );
}

function InspectorInlineAction({
  canEdit,
  result,
  loading,
  onOpenModal,
}: {
  canEdit: boolean;
  result: RagicFormulaPatchDryRunResult | null;
  loading: boolean;
  onOpenModal?: () => void;
}) {
  const blocked = (result?.blockers.length ?? 0) > 0;
  const status = !canEdit
    ? "請先選取公式"
    : loading
      ? "處理中"
      : result
        ? blocked
          ? "試算已阻擋"
          : "試算可套用"
        : "等待自動檢查";

  return (
    <section className="ragic-defs__inspector-section ragic-defs__inspector-section--action">
      <div className="ragic-defs__inspector-action-copy">
        <strong>公式編修</strong>
        <span
          className={
            loading
              ? "ragic-loading-inline"
              : blocked
                ? "is-blocked"
                : result && canEdit
                  ? "is-ok"
                  : ""
          }
        >
          {status}
        </span>
      </div>
      <button
        type="button"
        className="dev-mode-btn dev-mode-btn--primary ragic-defs__inspector-open-editor"
        disabled={!canEdit || !onOpenModal}
        onClick={onOpenModal}
      >
        <SearchOutlined />
        修改與套用
      </button>
    </section>
  );
}

function FormulaDryRunPanel({
  draft,
  result,
  error,
  loading,
  applyResult,
  batchApplyResult,
  applyError,
  applyLoading,
  canApply,
  siblingTargetCount,
  siblingSelectionState,
  onChange,
  onApply,
}: {
  draft: RagicFormulaPatchDryRunInput;
  result: RagicFormulaPatchDryRunResult | null;
  error: string | null;
  loading: boolean;
  applyResult: RagicFormulaPatchApplyResult | null;
  batchApplyResult: RagicFormulaPatchBatchApplyResult | null;
  applyError: string | null;
  applyLoading: boolean;
  canApply: boolean;
  siblingTargetCount: number;
  siblingSelectionState: SiblingSelectionState;
  onChange: Dispatch<SetStateAction<RagicFormulaPatchDryRunInput>>;
  onApply: () => void;
}) {
  const statusLabel = result
      ? result.allowed
        ? "可套用"
        : "已阻擋"
    : loading
      ? "檢查中…"
      : draft.newFormula.trim()
        ? "等待自動檢查"
        : "尚未輸入";

  return (
    <section className="ragic-defs__block ragic-defs__dryrun ragic-defs__inspector-section ragic-defs__inspector-section--dryrun">
      <div className="ragic-defs__panel-head">
        <strong>公式自動檢查</strong>
        <span className={loading ? "ragic-loading-inline" : undefined}>{statusLabel}</span>
      </div>
      <form
        className="ragic-defs__dryrun-form"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label>
          <span>表單路徑</span>
          <input
            className="ragic-inline__search"
            value={draft.formPath}
            onChange={(event) =>
              onChange((current) => ({ ...current, formPath: event.target.value }))
            }
          />
        </label>
        <label>
          <span>欄位 ID</span>
          <input
            className="ragic-inline__search"
            value={draft.fieldId}
            onChange={(event) =>
              onChange((current) => ({ ...current, fieldId: event.target.value }))
            }
          />
        </label>
        <label>
          <span>公式類型</span>
          <select
            className="ragic-inline__search"
            value={draft.formulaKind}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                formulaKind: event.target.value as RagicDefinitionFormula["formulaKind"],
              }))
            }
          >
            <option value="formula">{FORMULA_KIND_LABELS.formula}</option>
            <option value="defaultFormula">{FORMULA_KIND_LABELS.defaultFormula}</option>
          </select>
        </label>
        <label className="ragic-defs__dryrun-formula">
          <span>新公式</span>
          <textarea
            className="ragic-inline__search"
            rows={3}
            placeholder="貼上或輸入新公式"
            value={draft.newFormula}
            onChange={(event) =>
              onChange((current) => ({ ...current, newFormula: event.target.value }))
            }
          />
          <div className="ragic-defs__formula-preview">
            <span>語法預覽</span>
            <FormulaSyntax value={draft.newFormula} block />
          </div>
        </label>
        <div className="ragic-defs__dryrun-actions">
          <button
            type="button"
            className="dev-mode-btn dev-mode-btn--primary ragic-defs__dryrun-submit"
            disabled={!canApply}
            onClick={onApply}
          >
            {applyLoading
              ? "套用中…"
              : siblingTargetCount > 0
                ? `套用表單（含 ${siblingTargetCount} 張版本）`
                : "套用表單"}
          </button>
        </div>
      </form>
      {error ? <p className="dev-mode-error">{error}</p> : null}
        {applyError ? <p className="dev-mode-error">{applyError}</p> : null}
        {siblingSelectionState.pendingCount > 0 ? (
          <p className="ragic-inline__hint">
            跨版本表單尚有 {siblingSelectionState.pendingCount} 張等待自動檢查；通過後才能套用。
          </p>
        ) : null}
        {siblingSelectionState.blockedCount > 0 ? (
          <p className="dev-mode-error">
            跨版本表單有 {siblingSelectionState.blockedCount} 張不可套用；請先依下方提示處理。
          </p>
        ) : null}
        {result ? <FormulaDryRunResultView result={result} /> : null}
      {applyResult ? <FormulaApplyResultView result={applyResult} /> : null}
      {batchApplyResult ? <FormulaBatchApplyResultView result={batchApplyResult} /> : null}
    </section>
  );
}

function FormulaBatchApplyResultView({
  result,
}: {
  result: RagicFormulaPatchBatchApplyResult;
}) {
  const statusClass = result.applied
    ? "ragic-defs__inspector-result--ok"
    : "ragic-defs__inspector-result--blocked";
  return (
    <div className={`ragic-defs__apply-result ragic-defs__inspector-result ${statusClass}`}>
      <div className="ragic-defs__dryrun-summary">
        <span className={result.applied ? "is-ok" : "is-blocked"}>
          {result.applied
            ? `已套用 ${result.results.length} 張`
            : result.rolledBack
              ? "已整批回滾"
              : "整批未套用"}
        </span>
        <small>all-or-nothing：任一張被擋整批不動</small>
      </div>
      <ul className="ragic-defs__batch-list">
        {result.results.map((target) => (
          <li key={`${target.formPath}:${target.fieldId}`}>
            <span className={target.applied ? "is-ok" : "is-blocked"}>
              {target.applied ? "成功" : "未套用"}
            </span>
            <code>{target.formPath}</code>
            <FormulaSyntax value={target.newFormula} />
            {target.blockers.length ? (
              <ul className="ragic-defs__siblings-blockers">
                {target.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      {result.exportOutput ? (
        <div className="ragic-defs__apply-meta">
          <strong>重新匯出</strong>
          <pre>{result.exportOutput}</pre>
        </div>
      ) : null}
    </div>
  );
}

function FormulaDryRunResultView({ result }: { result: RagicFormulaPatchDryRunResult }) {
  const blocked = result.blockers.length > 0;
  return (
    <div
      className={`ragic-defs__dryrun-result ragic-defs__inspector-result ${
        blocked ? "ragic-defs__inspector-result--blocked" : "ragic-defs__inspector-result--ok"
      }`}
    >
      <div className="ragic-defs__dryrun-summary">
        <span className={blocked ? "is-blocked" : "is-ok"}>
          {blocked ? "已阻擋" : "可套用"}
        </span>
        <code>
          {result.formPath} · {result.fieldId} ·{" "}
          {result.sourceLine !== null ? `第 ${result.sourceLine} 行` : "尚未定位"}
        </code>
        <small>{result.builderFilePath ?? "（無 .nui 檔案路徑）"}</small>
      </div>
      <div className="ragic-defs__dryrun-lines">
        <div>
          <strong>原公式</strong>
          {result.oldFormula !== null ? (
            <FormulaSyntax value={result.oldFormula} />
          ) : (
            <p className="ragic-inline__hint">無既有公式，將新增公式設定</p>
          )}
        </div>
        <div>
          <strong>新公式</strong>
          <FormulaSyntax value={result.newFormula} />
        </div>
        <div>
          <strong>原始 .nui 行預覽</strong>
          {result.oldLinePreview !== null ? (
            <pre>{result.oldLinePreview}</pre>
          ) : (
            <p className="ragic-inline__hint">無法產生預覽</p>
          )}
        </div>
        <div>
          <strong>更新後 .nui 行預覽</strong>
          {result.newLinePreview !== null ? (
            <pre>{result.newLinePreview}</pre>
          ) : (
            <p className="ragic-inline__hint">無法產生預覽</p>
          )}
        </div>
      </div>
      {result.warnings.length ? (
        <ResultList title="警告" items={result.warnings} tone="warn" />
      ) : null}
      {result.blockers.length ? (
        <ResultList title="阻擋原因" items={result.blockers} tone="danger" />
      ) : null}
    </div>
  );
}

function FormulaApplyResultView({ result }: { result: RagicFormulaPatchApplyResult }) {
  const statusClass = result.applied
    ? "ragic-defs__inspector-result--ok"
    : "ragic-defs__inspector-result--blocked";
  return (
    <div className={`ragic-defs__apply-result ragic-defs__inspector-result ${statusClass}`}>
      <div className="ragic-defs__dryrun-summary">
        <span className={result.applied ? "is-ok" : "is-blocked"}>
          {result.applied ? "已套用" : result.rolledBack ? "已回滾" : "未套用"}
        </span>
        <FormulaSyntax value={result.verifiedFormula?.nuiFormula ?? result.dryRun.newFormula} />
        <small>{result.backupFilePath ?? "沒有備份檔"}</small>
      </div>
      {result.auditFilePath ? (
        <div className="ragic-defs__apply-meta">
          <strong>稽核紀錄</strong>
          <code>{result.auditFilePath}</code>
        </div>
      ) : null}
      {result.exportOutput ? (
        <div className="ragic-defs__apply-meta">
          <strong>重新匯出</strong>
          <pre>{result.exportOutput}</pre>
        </div>
      ) : null}
      {result.warnings.length ? (
        <ResultList title="套用警告" items={result.warnings} tone="warn" />
      ) : null}
      {result.blockers.length ? (
        <ResultList title="套用阻擋" items={result.blockers} tone="danger" />
      ) : null}
    </div>
  );
}

function SelectedTargetPanel({
  formula,
  field,
  workflow,
  outline,
}: {
  formula: RagicDefinitionFormula | null;
  field: FormField | null;
  workflow: FormWorkflow | null;
  outline: WorkflowOutline;
}) {
  if (formula) {
    return (
      <section className="ragic-defs__inspector-section ragic-defs__inspector-section--formula">
        <strong>選取的公式欄位</strong>
        <dl className="ragic-defs__kv">
          <div>
            <dt>欄位</dt>
            <dd>{formula.fieldName}</dd>
          </div>
          <div>
            <dt>ID</dt>
            <dd>{formula.fieldId}</dd>
          </div>
          <div>
            <dt>位置</dt>
            <dd>{formula.position}</dd>
          </div>
          <div>
            <dt>類型</dt>
            <dd>{FORMULA_KIND_LABELS[formula.formulaKind]}</dd>
          </div>
          <div>
            <dt>行號</dt>
            <dd>{formula.sourceLine}</dd>
          </div>
        </dl>
        <div className="ragic-defs__inspector-code">
          <span>公式</span>
          <FormulaSyntax value={formula.displayFormula} block />
        </div>
      </section>
    );
  }

  if (field) {
    const attrs = Object.entries(field.attrs);
    return (
      <section className="ragic-defs__inspector-section ragic-defs__inspector-section--field">
        <strong>選取的欄位</strong>
        <dl className="ragic-defs__kv">
          <div>
            <dt>欄位</dt>
            <dd>{field.fieldName}</dd>
          </div>
          <div>
            <dt>ID</dt>
            <dd>{field.fieldId}</dd>
          </div>
          <div>
            <dt>位置</dt>
            <dd>{field.position}</dd>
          </div>
          <div>
            <dt>類型</dt>
            <dd>{field.kind}</dd>
          </div>
          <div>
            <dt>行號</dt>
            <dd>{field.sourceLine}</dd>
          </div>
        </dl>
        {attrs.length ? (
          <DependencyList
            title="欄位屬性"
            emptyText="沒有屬性"
            items={attrs.slice(0, 8).map(([key, value]) => ({
              key,
              title: key,
              meta: value,
            }))}
            overflowCount={Math.max(0, attrs.length - 8)}
          />
        ) : null}
      </section>
    );
  }

  if (workflow) {
    return (
      <section className="ragic-defs__inspector-section ragic-defs__inspector-section--workflow">
        <strong>選取的 Workflow</strong>
        <dl className="ragic-defs__kv">
          <div>
            <dt>範圍</dt>
            <dd>{workflow.scope}</dd>
          </div>
          <div>
            <dt>來源</dt>
            <dd>
              <code>{workflow.fileName}</code>
            </dd>
          </div>
          <div>
            <dt>行數</dt>
            <dd>{outline.lineCount.toLocaleString()}</dd>
          </div>
          <div>
            <dt>引用欄位</dt>
            <dd>{outline.referencedFields.length.toLocaleString()}</dd>
          </div>
        </dl>
      </section>
    );
  }

  return (
    <section className="ragic-defs__inspector-section ragic-defs__inspector-section--empty">
      <strong>尚未選取項目</strong>
      <p className="ragic-inline__hint">點擊公式、欄位或 workflow tab 查看細節。</p>
    </section>
  );
}

export function DependencyList({
  title,
  emptyText,
  items,
  overflowCount = 0,
}: {
  title: string;
  emptyText: string;
  items: Array<{ key: string; title: string; meta?: string }>;
  overflowCount?: number;
}) {
  return (
    <div className="ragic-defs__dependency-list">
      <strong>{title}</strong>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.key}>
              <span>{item.title}</span>
              {item.meta ? <code>{item.meta}</code> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>{emptyText}</p>
      )}
      {overflowCount > 0 ? <small>還有 {overflowCount.toLocaleString()} 筆</small> : null}
    </div>
  );
}
