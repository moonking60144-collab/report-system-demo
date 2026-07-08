import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CloseOutlined, ExportOutlined } from "@ant-design/icons";
import {
  fetchRagicFormulaSiblings,
  type RagicDefinitionFormula,
  type RagicFormulaSiblingInfo,
} from "../../../api/devRagicDefinitions";
import { FormulaSyntax } from "./ragicDefinitionsSyntax";

/**
 * 欄位跨版本資訊彈窗：列出選定公式欄位（fieldId）在同實體所有多版本表單上
 * 的設定對照——哪張是原始、各版本目前的公式與位置。
 *
 * 「原始」判定：家族中 form id 最小者（多版本表單由原始複製衍生，id 必然較大）。
 */

interface VersionRow {
  formPath: string;
  formName: string;
  isCurrent: boolean;
  hasField: boolean;
  formula: string | null;
  position: string | null;
  definitionsMissing: boolean;
  freshness: RagicFormulaSiblingInfo["freshness"] | null;
}

const RAGIC_BASE_URL = String(import.meta.env.VITE_RAGIC_BASE_URL ?? "https://fdtw.app")
  .trim()
  .replace(/\/+$/, "");

function ragicFormUrl(formPath: string): string {
  return `${RAGIC_BASE_URL}/${formPath}`;
}

function formIdOf(formPath: string): number {
  const last = formPath.split("/").pop() ?? "";
  const id = Number.parseInt(last, 10);
  return Number.isFinite(id) ? id : Number.MAX_SAFE_INTEGER;
}

export function RagicFieldVersionsModal({
  token,
  formPath,
  formName,
  formula,
  onClose,
  onError,
}: {
  token: string;
  formPath: string;
  formName: string;
  formula: RagicDefinitionFormula;
  onClose: () => void;
  onError: (err: unknown, fallback: string) => string | null;
}) {
  // detail modal 才真的讀 live .nui 做 freshness（外層列表維持輕量 includeFreshness=false）。
  // 不走快取：freshness 反映 live .nui 當下狀態，快取住會在重開時顯示過期的同步判定。
  const query = useMemo(
    () => ({
      formPath,
      fieldId: formula.fieldId,
      formulaKind: formula.formulaKind,
      includeFreshness: true,
      includeCurrent: true,
    }),
    [formPath, formula.fieldId, formula.formulaKind]
  );
  const [siblings, setSiblings] = useState<RagicFormulaSiblingInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // modal 生命週期 = 開→查→關，deps 不會中途變，初始 loading=true 即可，
  // effect 內不做同步 setState
  useEffect(() => {
    const controller = new AbortController();
    fetchRagicFormulaSiblings(
      token,
      query,
      { signal: controller.signal }
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setSiblings(result.siblings);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(onError(err, "跨版本資訊查詢失敗"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, query, onError]);

  const siblingRows: VersionRow[] = (siblings ?? []).map((sibling) => ({
    formPath: sibling.formPath,
    formName: sibling.formName,
    isCurrent: sibling.formPath === formPath,
    hasField: sibling.hasField,
    formula: sibling.currentFormula,
    position: sibling.freshness.baselinePosition ?? sibling.fieldPosition,
    definitionsMissing: sibling.definitionsMissing,
    freshness: sibling.freshness,
  }));
  const fallbackCurrentRow: VersionRow = {
    formPath,
    formName,
    isCurrent: true,
    hasField: true,
    formula: formula.displayFormula,
    position: formula.position,
    definitionsMissing: false,
    freshness: null,
  };
  const rows: VersionRow[] = [
    ...(siblingRows.some((row) => row.formPath === formPath) ? [] : [fallbackCurrentRow]),
    ...siblingRows,
  ].sort((left, right) => formIdOf(left.formPath) - formIdOf(right.formPath));

  const originPath = rows[0]?.formPath;

  return createPortal(
    <div
      className="ragic-defs__picker-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="ragic-defs__versions-modal"
        role="dialog"
        aria-modal="true"
        aria-label="欄位跨版本資訊"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="ragic-defs__versions-head">
          <strong>欄位跨版本資訊</strong>
          <code>
            {formula.fieldName} · {formula.fieldId}
          </code>
          <button
            type="button"
            className="ragic-defs__inspector-icon"
            onClick={onClose}
            aria-label="關閉"
          >
            <CloseOutlined />
          </button>
        </div>
        {loading ? (
          <p className="ragic-inline__hint ragic-loading-inline">查詢中…</p>
        ) : error ? (
          <p className="dev-mode-error">{error}</p>
        ) : (
          <div className="ragic-defs__table-wrap">
            <table className="ragic-defs__table">
              <thead>
                <tr>
                  <th>表單</th>
                  <th>角色</th>
                  <th>位置</th>
                  <th>公式</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.formPath} className={row.isCurrent ? "is-selected" : ""}>
                    <td className="ragic-defs__field-cell">
                      <strong>
                        {row.formName}
                        <a
                          className="ragic-defs__versions-link"
                          href={ragicFormUrl(row.formPath)}
                          target="_blank"
                          rel="noreferrer"
                          title="在 Ragic 開啟此表單"
                        >
                          <ExportOutlined />
                        </a>
                      </strong>
                      <code>{row.formPath}</code>
                    </td>
                    <td>
                      <span
                        className={
                          row.formPath === originPath
                            ? "ragic-defs__versions-origin"
                            : "ragic-defs__versions-variant"
                        }
                      >
                        {row.formPath === originPath ? "原始" : "版本"}
                      </span>
                      {row.isCurrent ? (
                        <span className="ragic-defs__versions-current">目前開啟</span>
                      ) : null}
                    </td>
                    <td>
                      {row.hasField ? row.position ?? "—" : "—"}
                      {row.freshness?.checked && !row.freshness.fresh ? (
                        <div>
                          <em>不同步，請重新匯入</em>
                        </div>
                      ) : row.freshness && !row.freshness.checked ? (
                        <div>
                          <em>未確認 live .nui</em>
                        </div>
                      ) : null}
                    </td>
                    <td className="ragic-defs__formula-cell">
                      {row.definitionsMissing ? (
                        <em>definitions 缺檔，請先重新匯入</em>
                      ) : !row.hasField ? (
                        <em>此版本沒有這個欄位</em>
                      ) : row.formula ? (
                        <FormulaSyntax value={row.formula} title={row.formula} />
                      ) : (
                        <em>（無公式）</em>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>,
    document.body
  );
}
