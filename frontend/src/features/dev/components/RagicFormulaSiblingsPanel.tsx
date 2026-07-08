import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dryRunRagicFormulaPatch,
  type RagicFormulaPatchDryRunInput,
  type RagicFormulaPatchDryRunResult,
  type RagicFormulaSiblingInfo,
  fetchRagicFormulaSiblings,
} from "../../../api/devRagicDefinitions";
import { FormulaSyntax } from "./ragicDefinitionsSyntax";
import {
  readCachedFormulaSiblings,
} from "./ragicFormulaSiblingsCache";

/**
 * 公式跨版本連動面板：顯示「目前 dry-run 目標欄位」在同 mainKey 多版本表單上
 * 的足跡，提供自動推估（位置翻譯）預填與逐張試算。套用不在這裡——勾選的
 * targets 上報給上層，由「套用表單」對主表+勾選版本走一次批次 apply
 * （逐張 apply 會被 git-clean blocker 卡死：第一張套完 definitions 即 dirty）。
 */

const SIBLING_DRY_RUN_DEBOUNCE_MS = 800;

export interface SiblingApplyTarget {
  formPath: string;
  fieldId: string;
  formulaKind: RagicFormulaPatchDryRunInput["formulaKind"];
  newFormula: string;
}

export interface SiblingSelectionState {
  selectedCount: number;
  readyCount: number;
  pendingCount: number;
  blockedCount: number;
}

interface SiblingRowState {
  formula: string;
  /** 使用者改過輸入框後，推估結果不再覆蓋 */
  touched: boolean;
  dryRun: RagicFormulaPatchDryRunResult | null;
  error: string | null;
  loading: boolean;
}

const EMPTY_ROW: SiblingRowState = {
  formula: "",
  touched: false,
  dryRun: null,
  error: null,
  loading: false,
};

const EMPTY_SELECTION_STATE: SiblingSelectionState = {
  selectedCount: 0,
  readyCount: 0,
  pendingCount: 0,
  blockedCount: 0,
};

function canSelectSibling(sibling: RagicFormulaSiblingInfo): boolean {
  return (
    sibling.hasField &&
    !sibling.definitionsMissing &&
    (!sibling.freshness.checked || sibling.freshness.fresh)
  );
}

function dryRunMatchesTarget(
  dryRun: RagicFormulaPatchDryRunResult | null,
  target: SiblingApplyTarget
): boolean {
  return (
    dryRun !== null &&
    dryRun.formPath === target.formPath &&
    dryRun.fieldId === target.fieldId &&
    dryRun.formulaKind === target.formulaKind &&
    dryRun.newFormula === target.newFormula
  );
}

function hasSyncBlocker(dryRun: RagicFormulaPatchDryRunResult | null): boolean {
  return Boolean(
    dryRun?.blockers.some((blocker) =>
      /Ragic 現況已不同步|請先按重新匯入|sourceLine fieldId 不一致|實際 \.nui 沒有第|sourceLine attrs 找不到/.test(
        blocker
      )
    )
  );
}

export function FormulaSiblingsPanel({
  token,
  draft,
  refreshNonce = 0,
  onTargetsChange,
  onSelectionStateChange,
  onError,
}: {
  token: string;
  draft: RagicFormulaPatchDryRunInput;
  /** 批次套用成功後 bump：面板重查足跡並清掉勾選/試算結果 */
  refreshNonce?: number;
  /** 勾選且有新公式的版本表單清單；「套用表單」會把它們跟主表一起批次套用 */
  onTargetsChange: (targets: SiblingApplyTarget[]) => void;
  /** 勾選版本的檢查狀態；上層用來避免在 sibling 尚未通過 dry-run 前送出 batch */
  onSelectionStateChange?: (state: SiblingSelectionState) => void;
  /** 統一錯誤處理（與 Explorer 同一套）：401 觸發重新登入並回 null，其餘回顯示訊息 */
  onError: (err: unknown, fallback: string) => string | null;
}) {
  const formPath = draft.formPath.trim();
  const fieldId = draft.fieldId.trim();
  const formulaKind = draft.formulaKind;

  const [siblings, setSiblings] = useState<RagicFormulaSiblingInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [translating, setTranslating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Record<string, SiblingRowState>>({});
  const translateAbortRef = useRef<AbortController | null>(null);
  const dryRunAbortRef = useRef<AbortController | null>(null);
  const dryRunSeqRef = useRef(0);
  const queryIdentityRef = useRef("");

  // 目標欄位變更 → 重查足跡、清掉勾選與逐張結果；同欄位背景刷新保留草稿。
  useEffect(() => {
    if (!formPath || !fieldId) {
      translateAbortRef.current?.abort();
      dryRunAbortRef.current?.abort();
      dryRunSeqRef.current += 1;
      setTranslating(false);
      setSelected(new Set());
      setRows({});
      setSiblings(null);
      queryIdentityRef.current = "";
      return;
    }
    const queryIdentity = JSON.stringify([formPath, fieldId, formulaKind]);
    const sameQuery = queryIdentityRef.current === queryIdentity;
    queryIdentityRef.current = queryIdentity;
    if (!sameQuery) {
      translateAbortRef.current?.abort();
      dryRunAbortRef.current?.abort();
      dryRunSeqRef.current += 1;
      setTranslating(false);
      setExpanded(true);
      setSelected(new Set());
      setRows({});
    }
    const query = { formPath, fieldId, formulaKind, includeFreshness: true };
    const cached = readCachedFormulaSiblings(query);
    if (cached && !sameQuery) {
      setSiblings(cached);
    } else if (!sameQuery) {
      setSiblings(null);
    }
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    let cancelled = false;
    fetchRagicFormulaSiblings(token, query, { signal: controller.signal })
      .then((result) => {
        const nextSiblings = result.siblings;
        if (cancelled || controller.signal.aborted) return;
        setSiblings(nextSiblings);
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        if (!cached && !sameQuery) setSiblings(null);
        setError(onError(err, "跨版本表單查詢失敗"));
      })
      .finally(() => {
        if (!cancelled && !controller.signal.aborted) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [token, formPath, fieldId, formulaKind, onError, refreshNonce]);

  useEffect(() => {
    if (!siblings) return;
    const selectable = new Set(
      siblings.filter(canSelectSibling).map((sibling) => sibling.formPath)
    );
    setSelected((current) => {
      const next = new Set<string>();
      for (const path of current) {
        if (selectable.has(path)) next.add(path);
      }
      return next.size === current.size ? current : next;
    });
  }, [siblings]);

  // 勾選或公式變動 → 上報可套用 targets 給上層（「套用表單」批次用）。
  // 內容沒變就跳過（每 keystroke 都 setState 新 array 會讓 Explorer 整棵重渲染）。
  const lastReportedRef = useRef("");
  useEffect(() => {
    const targets: SiblingApplyTarget[] = (siblings ?? [])
      .filter(
        (sibling) =>
          selected.has(sibling.formPath) &&
          canSelectSibling(sibling) &&
          (rows[sibling.formPath]?.formula ?? "").trim() !== ""
      )
      .map((sibling) => ({
        formPath: sibling.formPath,
        fieldId,
        formulaKind,
        newFormula: rows[sibling.formPath].formula,
      }))
      .filter((target) =>
        dryRunMatchesTarget(rows[target.formPath]?.dryRun ?? null, target)
      )
      .filter((target) => {
        const dryRun = rows[target.formPath]?.dryRun ?? null;
        return Boolean(
          dryRun && dryRun.allowed && dryRun.blockers.length === 0
        );
      });
    const serialized = JSON.stringify(targets);
    if (serialized === lastReportedRef.current) return;
    lastReportedRef.current = serialized;
    onTargetsChange(targets);
  }, [siblings, selected, rows, fieldId, formulaKind, onTargetsChange]);

  const selectedDryRunTargets = useMemo(
    () =>
      (siblings ?? [])
        .filter(
          (sibling) =>
            selected.has(sibling.formPath) &&
            canSelectSibling(sibling) &&
            (rows[sibling.formPath]?.formula ?? "").trim() !== ""
        )
        .map((sibling) => ({
          formPath: sibling.formPath,
          fieldId,
          formulaKind,
          newFormula: rows[sibling.formPath].formula,
        })),
    [siblings, selected, rows, fieldId, formulaKind]
  );
  const selectedDryRunTargetsKey = JSON.stringify(selectedDryRunTargets);
  const selectionState = useMemo(() => {
    const state = { ...EMPTY_SELECTION_STATE };
    for (const sibling of siblings ?? []) {
      if (!selected.has(sibling.formPath)) continue;
      state.selectedCount += 1;
      if (!canSelectSibling(sibling)) {
        state.blockedCount += 1;
        continue;
      }
      const formula = (rows[sibling.formPath]?.formula ?? "").trim();
      if (!formula) {
        state.pendingCount += 1;
        continue;
      }
      const target = {
        formPath: sibling.formPath,
        fieldId,
        formulaKind,
        newFormula: rows[sibling.formPath].formula,
      };
      const row = rows[sibling.formPath] ?? EMPTY_ROW;
      if (
        row.loading ||
        row.dryRun === null ||
        !dryRunMatchesTarget(row.dryRun, target)
      ) {
        state.pendingCount += 1;
        continue;
      }
      if (row.dryRun.allowed && row.dryRun.blockers.length === 0) {
        state.readyCount += 1;
      } else {
        state.blockedCount += 1;
      }
    }
    return state;
  }, [siblings, selected, rows, fieldId, formulaKind]);
  const selectableSiblingPaths = useMemo(
    () =>
      (siblings ?? [])
        .filter(canSelectSibling)
        .map((sibling) => sibling.formPath),
    [siblings]
  );
  const allSelectableSelected =
    selectableSiblingPaths.length > 0 &&
    selectableSiblingPaths.every((path) => selected.has(path));

  // 雙實例防護（inline + 獨立檢查器各一份面板共用同一個上層 targets state）：
  // unmount 時清空上報，避免看不見的實例留下「畫面上沒勾、實際會送出」的 targets
  const onTargetsChangeRef = useRef(onTargetsChange);
  onTargetsChangeRef.current = onTargetsChange;
  const onSelectionStateChangeRef = useRef(onSelectionStateChange);
  onSelectionStateChangeRef.current = onSelectionStateChange;
  useEffect(() => {
    return () => {
      translateAbortRef.current?.abort();
      dryRunAbortRef.current?.abort();
      dryRunSeqRef.current += 1;
      onTargetsChangeRef.current([]);
      onSelectionStateChangeRef.current?.(EMPTY_SELECTION_STATE);
    };
  }, []);

  useEffect(() => {
    onSelectionStateChange?.(selectionState);
  }, [onSelectionStateChange, selectionState]);

  const updateRow = useCallback(
    (path: string, patch: Partial<SiblingRowState>) => {
      setRows((current) => ({
        ...current,
        [path]: { ...(current[path] ?? EMPTY_ROW), ...patch },
      }));
    },
    []
  );

  useEffect(() => {
    dryRunAbortRef.current?.abort();
    const runSeq = dryRunSeqRef.current + 1;
    dryRunSeqRef.current = runSeq;
    if (selectedDryRunTargetsKey === "[]") return;

    const timeoutId = window.setTimeout(async () => {
      const controller = new AbortController();
      dryRunAbortRef.current = controller;
      const targets = JSON.parse(selectedDryRunTargetsKey) as SiblingApplyTarget[];
      for (const target of targets) {
        if (controller.signal.aborted || dryRunSeqRef.current !== runSeq) return;
        updateRow(target.formPath, { loading: true, error: null });
        try {
          const result = await dryRunRagicFormulaPatch(token, target, {
            signal: controller.signal,
          });
          if (controller.signal.aborted || dryRunSeqRef.current !== runSeq) return;
          updateRow(target.formPath, {
            dryRun: result,
            formula: result.newFormula,
            loading: false,
          });
        } catch (err) {
          if (controller.signal.aborted || dryRunSeqRef.current !== runSeq) return;
          const message = onError(err, "試算失敗");
          updateRow(target.formPath, {
            loading: false,
            dryRun: null,
            error: message,
          });
          if (message === null) return;
        }
      }
      if (dryRunAbortRef.current === controller) dryRunAbortRef.current = null;
    }, SIBLING_DRY_RUN_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
      dryRunAbortRef.current?.abort();
    };
  }, [onError, selectedDryRunTargetsKey, token, updateRow]);

  async function handleTranslate() {
    if (!formPath || !fieldId || !draft.newFormula.trim() || translating) return;
    if (selected.size === 0) {
      setError("請先勾選要推估的版本表單");
      return;
    }
    translateAbortRef.current?.abort();
    const controller = new AbortController();
    translateAbortRef.current = controller;
    setTranslating(true);
    setError(null);
    const query = {
      formPath,
      fieldId,
      formulaKind,
      newFormula: draft.newFormula,
      includeFreshness: true,
    };
    try {
      const { siblings: siblingsResult } = await fetchRagicFormulaSiblings(token, query);
      if (controller.signal.aborted) return;
      const freshByPath = new Map(
        siblingsResult.map((sibling) => [sibling.formPath, sibling])
      );
      const selectedPaths = new Set(
        Array.from(selected).filter((path) => {
          const sibling = freshByPath.get(path);
          return Boolean(sibling && canSelectSibling(sibling));
        })
      );
      setSiblings((current) => {
        return (current ?? siblingsResult).map((sibling) =>
          freshByPath.get(sibling.formPath) ?? sibling
        );
      });
      setSelected(selectedPaths);
      // 推估結果只預填已勾選且尚未手動修改的列
      setRows((current) => {
        const next = { ...current };
        for (const sibling of siblingsResult) {
          if (!selectedPaths.has(sibling.formPath)) continue;
          const row = next[sibling.formPath] ?? EMPTY_ROW;
          if (!row.touched && sibling.translation?.translated) {
            next[sibling.formPath] = {
              ...row,
              formula: sibling.translation.translated,
            };
          }
        }
        return next;
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(onError(err, "推估對應公式失敗"));
    } finally {
      if (!controller.signal.aborted) setTranslating(false);
      if (translateAbortRef.current === controller) translateAbortRef.current = null;
    }
  }

  function toggleSelected(path: string) {
    const wasSelected = selected.has(path);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    if (wasSelected) {
      updateRow(path, { loading: false, error: null, dryRun: null });
      setSiblings((current) =>
        current?.map((sibling) =>
          sibling.formPath === path ? { ...sibling, translation: null } : sibling
        ) ?? current
      );
    }
  }

  function selectAllSiblingsForApply() {
    if (selectableSiblingPaths.length === 0) return;
    setError(null);
    setSelected(new Set(selectableSiblingPaths));
  }

  if (!formPath || !fieldId) return null;
  if (!loading && !error && (siblings?.length ?? 0) === 0) return null;

  const count = siblings?.length ?? 0;
  const selectedCount = selectionState.selectedCount;

  return (
    <section className="ragic-defs__block ragic-defs__inspector-section ragic-defs__siblings">
      <button
        type="button"
        className="ragic-defs__siblings-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <strong>跨版本表單</strong>
        <span className={loading ? "ragic-loading-inline" : undefined}>
          {loading ? "查詢中…" : `${count} 張${selectedCount ? `，已勾 ${selectedCount}` : ""}`}
        </span>
        <span className="ragic-defs__siblings-caret">{expanded ? "▾" : "▸"}</span>
      </button>
      {error ? <p className="dev-mode-error">{error}</p> : null}
      {expanded && siblings ? (
        <div className="ragic-defs__siblings-body">
          <div className="ragic-defs__siblings-actions">
            <button
              type="button"
              className="dev-mode-btn"
              disabled={selectableSiblingPaths.length === 0 || allSelectableSelected}
              onClick={selectAllSiblingsForApply}
              title="勾選所有可套用版本；真正寫入仍需按上方「套用表單」"
            >
              {allSelectableSelected ? "已全選" : "全部套用"}
            </button>
            <button
              type="button"
              className="dev-mode-btn"
              disabled={translating || selectedCount === 0 || !draft.newFormula.trim()}
              onClick={handleTranslate}
              title="把上方新公式的欄位位置翻譯成已勾選版本表單的對應位置"
            >
              {translating ? "推估中…" : "推估對應公式"}
            </button>
            <span className="ragic-defs__siblings-help">
              勾選或輸入後自動檢查；全部通過後按「套用表單」一次套用主表與勾選版本
            </span>
          </div>
          <ul className="ragic-defs__siblings-list">
            {siblings.map((sibling) => (
              <SiblingRow
                key={sibling.formPath}
                sibling={sibling}
                row={rows[sibling.formPath] ?? EMPTY_ROW}
                checked={selected.has(sibling.formPath)}
                onToggle={() => toggleSelected(sibling.formPath)}
                onFormulaChange={(value) =>
                  updateRow(sibling.formPath, {
                    formula: value,
                    touched: true,
                    dryRun: null,
                    error: null,
                  })
                }
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function SiblingRow({
  sibling,
  row,
  checked,
  onToggle,
  onFormulaChange,
}: {
  sibling: RagicFormulaSiblingInfo;
  row: SiblingRowState;
  checked: boolean;
  onToggle: () => void;
  onFormulaChange: (value: string) => void;
}) {
  const selectable = canSelectSibling(sibling);
  const dryRunOk =
    row.dryRun !== null && row.dryRun.allowed && row.dryRun.blockers.length === 0;
  const dryRunSyncBlocked = hasSyncBlocker(row.dryRun);
  const stale = sibling.freshness.checked && !sibling.freshness.fresh;
  const unchecked = !sibling.freshness.checked;
  const showLiveUncheckedHint =
    unchecked && selectable && !checked && !row.loading && row.dryRun === null;
  const statusLabel = stale
    ? "不同步"
    : row.loading
      ? "檢查中"
      : row.dryRun
        ? dryRunOk
          ? "可套用"
          : dryRunSyncBlocked
            ? "不同步"
            : "已阻擋"
        : checked && row.formula.trim()
          ? "待檢查"
          : !sibling.currentNuiFormula && selectable
            ? "可新增公式"
            : unchecked && checked
              ? "待檢查"
              : unchecked
                ? null
                : null;
  const statusTone =
    stale || row.dryRun
      ? dryRunOk && !stale
        ? "is-ok"
        : "is-blocked"
      : "";

  return (
    <li className="ragic-defs__siblings-row">
      <label className="ragic-defs__siblings-row-head">
        <input
          type="checkbox"
          checked={checked}
          disabled={!selectable}
          onChange={onToggle}
        />
        <span className="ragic-defs__siblings-name">{sibling.formName}</span>
        <code className="ragic-defs__siblings-path">{sibling.formPath}</code>
        {row.loading ? <span className="ragic-loading-inline">處理中…</span> : null}
        {statusLabel ? <span className={statusTone}>{statusLabel}</span> : null}
      </label>
      <div className="ragic-defs__siblings-current">
        <span>{unchecked ? "baseline" : "現行"}</span>
        {sibling.definitionsMissing ? (
          <em>definitions 缺這張表，請先重新匯入</em>
        ) : !sibling.hasField ? (
          <em>此版本沒有這個欄位</em>
        ) : sibling.currentFormula ? (
          <FormulaSyntax value={sibling.currentFormula} />
        ) : (
          <em>（無公式）</em>
        )}
      </div>
      {showLiveUncheckedHint ? (
        <div className="ragic-defs__siblings-mapping">
          <span>live</span>
          <code>尚未確認 live .nui；勾選或套用前會自動試算檢查。</code>
        </div>
      ) : null}
      {stale ? (
        <div className="ragic-defs__siblings-mapping ragic-defs__siblings-mapping--blocked">
          <span>下一步</span>
          <code>
            請關閉檢查器，在頁面右上按「重新匯入」同步 definitions，再重新推估 / 套用。
            {sibling.freshness.baselinePosition && sibling.freshness.actualPosition
              ? ` 位置 baseline=${sibling.freshness.baselinePosition} / live=${sibling.freshness.actualPosition}`
              : ""}
          </code>
        </div>
      ) : null}
      {unchecked && sibling.freshness.warnings.length ? (
        <ul className="ragic-defs__siblings-blockers">
          {sibling.freshness.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {stale && sibling.freshness.staleReasons.length ? (
        <ul className="ragic-defs__siblings-blockers">
          {sibling.freshness.staleReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {selectable ? (
        <>
          {sibling.translation ? (
            sibling.translation.translated ? (
              <div className="ragic-defs__siblings-mapping">
                <span>對照</span>
                <code>
                  {sibling.translation.mapping
                    .map((item) => `${item.from}→${item.to}`)
                    .join("、") || "（公式沒有欄位引用）"}
                </code>
              </div>
            ) : (
              <div className="ragic-defs__siblings-mapping ragic-defs__siblings-mapping--blocked">
                <span>無法推估</span>
                <code>
                  {sibling.translation.untranslatable
                    .map((item) => item.reason)
                    .join("；")}
                </code>
              </div>
            )
          ) : null}
          <label className="ragic-defs__siblings-formula">
            <span>新公式</span>
            <textarea
              className="ragic-inline__search"
              rows={2}
              value={row.formula}
              onChange={(event) => onFormulaChange(event.target.value)}
              placeholder="按「推估對應公式」自動帶入，或手動輸入"
            />
          </label>
          {row.error ? <p className="dev-mode-error">{row.error}</p> : null}
          {row.dryRun && row.dryRun.blockers.length ? (
            <ul className="ragic-defs__siblings-blockers">
              {row.dryRun.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </li>
  );
}
