import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  CloseOutlined,
  CopyOutlined,
  DownOutlined,
  SearchOutlined,
  UpOutlined,
} from "@ant-design/icons";
import {
  applyRagicFormulaPatch,
  applyRagicFormulaPatchBatch,
  commitRagicDefinitionsBaseline,
  dryRunRagicFormulaPatch,
  fetchRagicDefinitionFormDetail,
  fetchRagicDefinitionForms,
  fetchRagicDefinitionsState,
  fetchRagicDefinitionsVersionControlStatus,
  pushRagicDefinitionsBaseline,
  reExportRagicDefinitions,
  rollbackLatestRagicFormulaPatch,
  type RagicDefinitionFormula,
  type RagicDefinitionForm,
  type RagicDefinitionFormDetail,
  type RagicDefinitionsState,
  type RagicDefinitionsVersionControlStatus,
  type RagicFormulaPatchApplyResult,
  type RagicFormulaPatchBatchApplyResult,
  type RagicFormulaPatchDryRunInput,
  type RagicFormulaPatchDryRunResult,
  type RagicFormulaSiblingInfo,
} from "../../../api/devRagicDefinitions";
import { extractErrorMessage, isUnauthorized } from "../../../api/apiErrors";
import {
  FieldTable,
  FormulaTable,
  WorkflowPanel,
} from "./RagicDefinitionsDataPanels";
import { FormPickerModal } from "./RagicDefinitionsFormPicker";
import { RagicFieldVersionsModal } from "./RagicFieldVersionsModal";
import type {
  SiblingApplyTarget,
  SiblingSelectionState,
} from "./RagicFormulaSiblingsPanel";
import { InspectorPanel } from "./RagicDefinitionsInspector";
import { FormulaSyntax } from "./ragicDefinitionsSyntax";
import { DefinitionsExplorerScrollButtons } from "./definitions-explorer/DefinitionsExplorerScrollButtons";
import { DefinitionsExplorerDetailStateBlock } from "./definitions-explorer/DefinitionsExplorerDetailStateBlock";
import { OperationNoticeStack } from "./definitions-explorer/OperationNoticeStack";
import { RagicDefinitionsAiAssistant } from "./RagicDefinitionsAiAssistant";
import type {
  OperationNotice,
  OperationNoticeTone,
} from "./definitions-explorer/operationNoticeTypes";
import {
  clearCachedFormulaSiblings,
  loadCachedFormulaSiblings,
  readCachedFormulaSiblings,
} from "./ragicFormulaSiblingsCache";
import {
  BaselineStatusBar,
  DevCommandBar,
  type VersionActionResult,
} from "./RagicDefinitionsVersionPanel";
import {
  useRagicDefinitionsRealtime,
  type RagicDefinitionsRealtimePayload,
} from "../hooks/useRagicDefinitionsRealtime";
import { useDevDefinitionsPresence } from "../hooks/useDevDefinitionsPresence";
import { useDevScrollShortcuts } from "../hooks/useDevScrollShortcuts";
import {
  createFormulaDryRunDraft,
  createWorkflowOutline,
  DEFAULT_BASELINE_COMMIT_MESSAGE,
  EMPTY_DRY_RUN_DRAFT,
  extractRagicFormPath,
  type FormulaPatchErrorDialogContext,
  createFormulaPatchErrorDialogContext,
  FORMULA_KIND_LABELS,
  includesQuery,
  isCompleteFormPath,
  looksLikeFormLookup,
  readStoredSelectedFormPath,
  SEARCH_DEBOUNCE_MS,
  writeStoredSelectedFormPath,
} from "./ragicDefinitionsExplorerUtils";
import type {
  DetailSearchType,
  SelectedTarget,
} from "./ragicDefinitionsExplorerTypes";

interface Props {
  token: string;
  username: string;
  onAuthFailure: () => void;
}

interface FormulaApplySuccessDialogState {
  title: string;
  message: string;
  appliedCount: number;
  formPaths: string[];
}

const FORMULA_DRY_RUN_DEBOUNCE_MS = 800;
const FORMULA_APPLY_SUCCESS_NOTICE_MS = 6000;
const VERSION_PREVIEW_EXPANDED_STORAGE_KEY = "ragic-defs.version-preview-expanded.v1";

type DefinitionsReloadMode = "foreground" | "background";

const OPERATION_NOTICE_TIMEOUT_MS: Record<OperationNoticeTone, number> = {
  info: 0,
  success: 5000,
  warning: 8000,
  error: 10000,
};

function mergeFormPathScope(current: string[], next: string[]): string[] {
  const merged = new Set(current);
  for (const item of next) {
    const formPath = item.trim();
    if (formPath) merged.add(formPath);
  }
  return Array.from(merged);
}

function formulaDryRunMatchesDraft(
  dryRun: RagicFormulaPatchDryRunResult,
  draft: RagicFormulaPatchDryRunInput
): boolean {
  return (
    dryRun.formPath === draft.formPath.trim() &&
    dryRun.fieldId === draft.fieldId.trim() &&
    dryRun.formulaKind === draft.formulaKind &&
    dryRun.newFormula === draft.newFormula
  );
}

function firstMessage(items: string[], fallback: string): string {
  return items[0] ?? fallback;
}

function formatDryRunNoticeMessage(result: RagicFormulaPatchDryRunResult): string {
  const target = [
    result.formName ?? result.formPath,
    result.fieldName ?? result.fieldId,
    result.sourceLine ? `第 ${result.sourceLine} 行` : null,
  ].filter(Boolean).join(" · ");
  if (result.allowed && result.blockers.length === 0) {
    return target || "公式試算完成，可套用。";
  }
  return firstMessage(result.blockers, "公式試算完成，但目前不可套用。");
}

function createFormulaPatchErrorDialogContextFromPayload(
  params: {
    title: string;
    message: string;
    blockers: unknown;
    warnings?: unknown;
    fatalValidationErrors?: unknown;
    payload: unknown;
  }
): {
  context: FormulaPatchErrorDialogContext;
  isCritical: boolean;
} {
  const context = createFormulaPatchErrorDialogContext(params);
  const isCritical =
    context.blockers.length > 0 ||
    context.fatalValidationErrors.length > 0;
  return { context, isCritical };
}

function formatReExportNoticeMessage(
  result: Awaited<ReturnType<typeof reExportRagicDefinitions>>
): string {
  const changed = result.versionStatus.definitionsEntries.length;
  const diffText = changed > 0
    ? `definitions 有差異 ${changed} 筆`
    : "baseline 無差異";
  return [
    `${result.summary.forms.toLocaleString()} 表單`,
    `${result.summary.fields.toLocaleString()} 欄`,
    `${result.summary.formulas.toLocaleString()} 公式`,
    diffText,
  ].join(" · ");
}

function readStoredVersionPreviewExpanded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(VERSION_PREVIEW_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredVersionPreviewExpanded(expanded: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      VERSION_PREVIEW_EXPANDED_STORAGE_KEY,
      expanded ? "true" : "false"
    );
  } catch {
    // localStorage 不可用時只保留本次 UI 狀態。
  }
}

export function RagicDefinitionsExplorer({ token, username, onAuthFailure }: Props) {
  const [state, setState] = useState<RagicDefinitionsState | null>(null);
  const [forms, setForms] = useState<RagicDefinitionForm[]>([]);
  const [formQuery, setFormQuery] = useState("");
  const [formRailExpanded, setFormRailExpanded] = useState(false);
  const [formPickerOpen, setFormPickerOpen] = useState(false);
  const [inspectorModalOpen, setInspectorModalOpen] = useState(false);
  const [versionFamilyAvailable, setVersionFamilyAvailable] = useState(false);
  const [versionsModalFormula, setVersionsModalFormula] =
    useState<RagicDefinitionFormula | null>(null);
  const [detailQuery, setDetailQuery] = useState("");
  const [detailSearchType, setDetailSearchType] = useState<DetailSearchType>("formula");
  const [selectedPath, setSelectedPath] = useState<string | null>(
    readStoredSelectedFormPath
  );
  const [detail, setDetail] = useState<RagicDefinitionFormDetail | null>(null);
  const [activeWorkflow, setActiveWorkflow] = useState<string | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget | null>(null);
  const [dryRunDraft, setDryRunDraft] =
    useState<RagicFormulaPatchDryRunInput>(EMPTY_DRY_RUN_DRAFT);
  const [dryRunResult, setDryRunResult] =
    useState<RagicFormulaPatchDryRunResult | null>(null);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [applyResult, setApplyResult] =
    useState<RagicFormulaPatchApplyResult | null>(null);
  const [batchApplyResult, setBatchApplyResult] =
    useState<RagicFormulaPatchBatchApplyResult | null>(null);
  const [siblingApplyTargets, setSiblingApplyTargets] = useState<SiblingApplyTarget[]>([]);
  const [siblingSelectionState, setSiblingSelectionState] =
    useState<SiblingSelectionState>({
      selectedCount: 0,
      readyCount: 0,
      pendingCount: 0,
      blockedCount: 0,
    });
  const [siblingsRefreshNonce, setSiblingsRefreshNonce] = useState(0);
  const [baselineCommitScopeFormPaths, setBaselineCommitScopeFormPaths] = useState<string[]>([]);
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [versionStatus, setVersionStatus] =
    useState<RagicDefinitionsVersionControlStatus | null>(null);
  const [versionMessage, setVersionMessage] = useState(DEFAULT_BASELINE_COMMIT_MESSAGE);
  const [versionLoading, setVersionLoading] =
    useState<"refresh" | "rollback" | "commit" | "push" | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionActionResult, setVersionActionResult] =
    useState<VersionActionResult | null>(null);
  const [operationNotices, setOperationNotices] = useState<OperationNotice[]>([]);
  const [formulaApplySuccessDialog, setFormulaApplySuccessDialog] =
    useState<FormulaApplySuccessDialogState | null>(null);
  const [formulaPatchErrorDialog, setFormulaPatchErrorDialog] =
    useState<FormulaPatchErrorDialogContext | null>(null);
  const [formulaPatchErrorCopyState, setFormulaPatchErrorCopyState] =
    useState<"idle" | "copied" | "failed">("idle");
  const [realtimeSync, setRealtimeSync] =
    useState<RagicDefinitionsRealtimePayload | null>(null);
  const [realtimeReloading, setRealtimeReloading] = useState(false);
  const [contextHeight, setContextHeight] = useState(66);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const formAbortRef = useRef<AbortController | null>(null);
  const dryRunAbortRef = useRef<AbortController | null>(null);
  const dryRunRequestSeqRef = useRef(0);
  const realtimeReloadEventIdRef = useRef("");
  const applyRequestSeqRef = useRef(0);
  const definitionsReloadRequestSeqRef = useRef(0);
  const operationNoticeTimersRef = useRef<Map<string, number>>(new Map());
  const formulaPatchErrorCopyTimerRef = useRef<number | null>(null);
  const selectedPathRef = useRef(selectedPath);
  const selectedTargetRef = useRef(selectedTarget);
  const detailRef = useRef(detail);
  const contextRef = useRef<HTMLElement | null>(null);
  const scrollShortcutLayoutVersion = useMemo(
    () =>
      [
        detail?.form.formPath ?? "",
        detail?.fields.length ?? "",
        detail?.formulas.length ?? "",
        detail?.workflows.length ?? "",
        detailQuery,
        detailSearchType,
        formRailExpanded ? "expanded" : "collapsed",
        forms.length,
        versionFamilyAvailable ? "versions" : "single",
      ].join("|"),
    [
      detail?.fields.length,
      detail?.formulas.length,
      detail?.form.formPath,
      detail?.workflows.length,
      detailQuery,
      detailSearchType,
      formRailExpanded,
      forms.length,
      versionFamilyAvailable,
    ]
  );
  const {
    scrollHint,
    scrollShortcutClassName,
    scrollShortcutExpanded,
    handleScrollShortcutHoverStart,
    handleScrollShortcutHoverEnd,
    handleScrollShortcut,
  } = useDevScrollShortcuts(scrollShortcutLayoutVersion);

  const handleError = useCallback((err: unknown, fallback: string) => {
    if (isUnauthorized(err)) {
      onAuthFailure();
      return null;
    }
    return extractErrorMessage(err, fallback);
  }, [onAuthFailure]);

  const closeFormulaApplySuccessDialog = useCallback(() => {
    setFormulaApplySuccessDialog(null);
  }, []);

  const closeFormulaPatchErrorDialog = useCallback(() => {
    if (formulaPatchErrorCopyTimerRef.current !== null) {
      window.clearTimeout(formulaPatchErrorCopyTimerRef.current);
      formulaPatchErrorCopyTimerRef.current = null;
    }
    setFormulaPatchErrorCopyState("idle");
    setFormulaPatchErrorDialog(null);
  }, []);

  const openFormulaPatchErrorDialog = useCallback((context: FormulaPatchErrorDialogContext) => {
    if (formulaPatchErrorCopyTimerRef.current !== null) {
      window.clearTimeout(formulaPatchErrorCopyTimerRef.current);
      formulaPatchErrorCopyTimerRef.current = null;
    }
    setFormulaPatchErrorCopyState("idle");
    setFormulaPatchErrorDialog(context);
  }, []);

  const copyFormulaPatchErrorDetails = useCallback(async () => {
    if (!formulaPatchErrorDialog) return;

    const scheduleReset = () => {
      if (formulaPatchErrorCopyTimerRef.current !== null) {
        window.clearTimeout(formulaPatchErrorCopyTimerRef.current);
      }
      formulaPatchErrorCopyTimerRef.current = window.setTimeout(() => {
        setFormulaPatchErrorCopyState("idle");
        formulaPatchErrorCopyTimerRef.current = null;
      }, 1400);
    };

    try {
      await navigator.clipboard.writeText(formulaPatchErrorDialog.raw);
      setFormulaPatchErrorCopyState("copied");
    } catch {
      setFormulaPatchErrorCopyState("failed");
    }
    scheduleReset();
  }, [formulaPatchErrorDialog]);

  const dismissOperationNotice = useCallback((key: string) => {
    const timer = operationNoticeTimersRef.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      operationNoticeTimersRef.current.delete(key);
    }
    setOperationNotices((current) =>
      current.filter((notice) => notice.key !== key)
    );
  }, []);

  const showOperationNotice = useCallback((
    notice: OperationNotice,
    options: { timeoutMs?: number } = {}
  ) => {
    const previousTimer = operationNoticeTimersRef.current.get(notice.key);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
      operationNoticeTimersRef.current.delete(notice.key);
    }
    setOperationNotices((current) => [
      notice,
      ...current.filter((item) => item.key !== notice.key),
    ].slice(0, 5));
    const timeoutMs =
      options.timeoutMs ?? OPERATION_NOTICE_TIMEOUT_MS[notice.tone];
    if (timeoutMs > 0) {
      const timer = window.setTimeout(() => {
        operationNoticeTimersRef.current.delete(notice.key);
        setOperationNotices((current) =>
          current.filter((item) => item.key !== notice.key)
        );
      }, timeoutMs);
      operationNoticeTimersRef.current.set(notice.key, timer);
    }
  }, []);

  useEffect(() => {
    const timers = operationNoticeTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  useEffect(() => () => {
    if (formulaPatchErrorCopyTimerRef.current !== null) {
      window.clearTimeout(formulaPatchErrorCopyTimerRef.current);
    }
  }, []);

  const applyLoadedDetail = useCallback((
    next: RagicDefinitionFormDetail,
    options: {
      preserveTarget?: SelectedTarget | null;
      resetPatchState?: boolean;
      preserveDraft?: boolean;
    } = {}
  ) => {
    const preferredTarget = options.preserveTarget ?? null;
    let nextTarget: SelectedTarget | null = null;

    if (
      preferredTarget?.type === "formula" &&
      next.formulas.some(
        (formula) =>
          formula.fieldId === preferredTarget.fieldId &&
          formula.formulaKind === preferredTarget.formulaKind
      )
    ) {
      nextTarget = preferredTarget;
    } else if (
      preferredTarget?.type === "field" &&
      next.fields.some((field) => field.fieldId === preferredTarget.fieldId)
    ) {
      nextTarget = preferredTarget;
    } else if (
      preferredTarget?.type === "workflow" &&
      next.workflows.some((workflow) => workflow.scope === preferredTarget.scope)
    ) {
      nextTarget = preferredTarget;
    }

    const fallbackFormula = next.formulas[0] ?? null;
    if (!nextTarget) {
      nextTarget = fallbackFormula
        ? {
            type: "formula",
            fieldId: fallbackFormula.fieldId,
            formulaKind: fallbackFormula.formulaKind,
          }
        : next.fields[0]
          ? { type: "field", fieldId: next.fields[0].fieldId }
          : next.workflows[0]
            ? { type: "workflow", scope: next.workflows[0].scope }
            : null;
    }

    const draftFormula =
      nextTarget?.type === "formula"
        ? next.formulas.find(
            (formula) =>
              formula.fieldId === nextTarget.fieldId &&
              formula.formulaKind === nextTarget.formulaKind
          ) ?? fallbackFormula
        : fallbackFormula;

    setDetail(next);
    setActiveWorkflow(
      nextTarget?.type === "workflow"
        ? nextTarget.scope
        : next.workflows[0]?.scope ?? null
    );
    setSelectedTarget(nextTarget);
    if (!options.preserveDraft) {
      setDryRunDraft((current) =>
        draftFormula
          ? createFormulaDryRunDraft(next.form.formPath, draftFormula)
          : {
              ...current,
              formPath: next.form.formPath,
              fieldId: "",
              newFormula: "",
            }
      );
    }
    if (options.resetPatchState !== false) {
      setDryRunResult(null);
      setDryRunError(null);
      setApplyResult(null);
      setBatchApplyResult(null);
      setApplyError(null);
    }
  }, []);

  const refreshDefinitionsState = useCallback(async () => {
    const next = await fetchRagicDefinitionsState(token);
    setState(next);
    return next;
  }, [token]);
  const formLookupPath = useMemo(() => extractRagicFormPath(formQuery), [formQuery]);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    selectedTargetRef.current = selectedTarget;
  }, [selectedTarget]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  const refreshVersionControlStatus = useCallback(async (
    options: { silent?: boolean } = {}
  ) => {
    if (!options.silent) setVersionLoading("refresh");
    try {
      const next = await fetchRagicDefinitionsVersionControlStatus(token);
      setVersionStatus(next);
      setVersionError(null);
      return next;
    } catch (err) {
      setVersionError(handleError(err, "definitions 版控狀態載入失敗"));
      return null;
    } finally {
      if (!options.silent) {
        setVersionLoading((current) => (current === "refresh" ? null : current));
      }
    }
  }, [handleError, token]);

  const reloadDefinitionsViewFromServer = useCallback(async (
    options: {
      mode?: DefinitionsReloadMode;
      resetPatchState?: boolean;
      refreshDetail?: boolean;
    } = {}
  ) => {
    const mode = options.mode ?? "foreground";
    const isBackground = mode === "background";
    const requestedPath = selectedPath;
    const shouldRefreshDetail = options.refreshDetail !== false && Boolean(requestedPath);
    const requestSeq = definitionsReloadRequestSeqRef.current + 1;
    definitionsReloadRequestSeqRef.current = requestSeq;
    const isStaleReload = () => definitionsReloadRequestSeqRef.current !== requestSeq;
    if (shouldRefreshDetail && !isBackground) setDetailLoading(true);
    try {
      const [nextState, nextStatus, formResult] = await Promise.all([
        fetchRagicDefinitionsState(token),
        fetchRagicDefinitionsVersionControlStatus(token),
        fetchRagicDefinitionForms(token, { q: formLookupPath, limit: 300 }),
      ]);
      if (isStaleReload()) return;
      setState(nextState);
      setVersionStatus(nextStatus);
      setForms(formResult.data);
      setVersionError(null);
      setError(null);

      if (!shouldRefreshDetail || !requestedPath) return;
      try {
        const nextDetail = await fetchRagicDefinitionFormDetail(token, requestedPath);
        if (isStaleReload()) return;
        if (selectedPathRef.current !== requestedPath) return;
        const currentTarget = selectedTargetRef.current;
        const selectedFormulaChanged =
          isBackground &&
          currentTarget?.type === "formula" &&
          (() => {
            const previousFormula = detailRef.current?.formulas.find(
              (formula) =>
                formula.fieldId === currentTarget.fieldId &&
                formula.formulaKind === currentTarget.formulaKind
            );
            const nextFormula = nextDetail.formulas.find(
              (formula) =>
                formula.fieldId === currentTarget.fieldId &&
                formula.formulaKind === currentTarget.formulaKind
            );
            return previousFormula?.nuiFormula !== nextFormula?.nuiFormula;
          })();
        if (isBackground) {
          applyLoadedDetail(nextDetail, {
            preserveTarget: currentTarget,
            preserveDraft: true,
            resetPatchState: false,
          });
          if (selectedFormulaChanged) {
            dryRunAbortRef.current?.abort();
            dryRunRequestSeqRef.current += 1;
            setDryRunLoading(false);
            setDryRunResult(null);
            setDryRunError("目前公式 baseline 已背景更新，請按重新匯入後再套用。");
            setApplyResult(null);
            setBatchApplyResult(null);
            setApplyError(null);
          }
          setDetailError(null);
          return;
        }
        applyLoadedDetail(nextDetail, {
          preserveTarget: currentTarget,
          resetPatchState: options.resetPatchState,
        });
        setDetailError(null);
      } catch (reloadError) {
        if (isStaleReload()) return;
        const message = handleError(reloadError, "同步後表單 definition 載入失敗");
        if (isBackground) {
          setVersionError(message);
          return;
        }
        setDetailError(message);
      }
    } catch (err) {
      if (isStaleReload()) return;
      setVersionError(handleError(err, "definitions 狀態重新載入失敗"));
    } finally {
      if (!isStaleReload() && shouldRefreshDetail && !isBackground) {
        setDetailLoading(false);
      }
    }
  }, [
    applyLoadedDetail,
    formLookupPath,
    handleError,
    selectedPath,
    token,
  ]);

  useEffect(() => {
    const contextElement = contextRef.current;
    if (!contextElement) return;

    const updateContextHeight = () => {
      setContextHeight(Math.ceil(contextElement.getBoundingClientRect().height));
    };
    updateContextHeight();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateContextHeight);
    resizeObserver?.observe(contextElement);
    window.addEventListener("resize", updateContextHeight);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateContextHeight);
    };
  }, [detail, detailQuery, detailSearchType]);

  const handleRealtimeSyncStatus = useCallback(
    (payload: RagicDefinitionsRealtimePayload) => {
      setRealtimeSync(payload);
      if (payload.status === "error") {
        setVersionError(payload.message || "definitions 自動重新匯入失敗");
        return;
      }
      if (payload.status === "syncing") {
        setVersionError(null);
        return;
      }
      if (payload.status !== "synced") {
        return;
      }

      const eventId = payload.id.trim();
      if (eventId && realtimeReloadEventIdRef.current === eventId) {
        return;
      }
      if (payload.changedCount === 0) {
        if (eventId) realtimeReloadEventIdRef.current = eventId;
        return;
      }

      if (eventId) realtimeReloadEventIdRef.current = eventId;
      clearCachedFormulaSiblings();
      setSiblingsRefreshNonce((nonce) => nonce + 1);
      setRealtimeReloading(true);
      void reloadDefinitionsViewFromServer({
        mode: "background",
        resetPatchState: false,
        refreshDetail: !applyLoading,
      })
        .finally(() => {
          setRealtimeReloading(false);
        });
    },
    [applyLoading, reloadDefinitionsViewFromServer]
  );

  const {
    connected: realtimeConnected,
    disconnectedSince: realtimeDisconnectedSince,
  } = useRagicDefinitionsRealtime({
    enabled: Boolean(token),
    onSyncStatus: handleRealtimeSyncStatus,
  });
  const devPresence = useDevDefinitionsPresence({
    token,
    enabled: Boolean(token),
    displayName: username,
    selectedFormPath: selectedPath || null,
    operation: applyLoading ? "apply" : versionLoading ?? "viewing",
    realtimeConnected,
    onForceSessionExpired: onAuthFailure,
  });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      try {
        const [nextState, formResult] = await Promise.all([
          fetchRagicDefinitionsState(token, { signal: controller.signal }),
          fetchRagicDefinitionForms(token, { limit: 300 }, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setState(nextState);
        setForms(formResult.data);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(handleError(err, "definitions baseline 載入失敗"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [handleError, token]);

  useEffect(() => {
    void refreshVersionControlStatus();
  }, [refreshVersionControlStatus]);

  useEffect(() => {
    formAbortRef.current?.abort();
    const controller = new AbortController();
    formAbortRef.current = controller;
    const q = extractRagicFormPath(formQuery);
    const id = window.setTimeout(async () => {
      try {
        const result = await fetchRagicDefinitionForms(
          token,
          { q, limit: 300 },
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        setForms(result.data);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(handleError(err, "表單清單載入失敗"));
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(id);
      controller.abort();
    };
  }, [formQuery, handleError, token]);

  useEffect(() => {
    if (!selectedPath) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    (async () => {
      try {
        const next = await fetchRagicDefinitionFormDetail(token, selectedPath, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        applyLoadedDetail(next);
        setDetailError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setDetail(null);
        setDetailError(handleError(err, "表單 definition 載入失敗"));
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [applyLoadedDetail, handleError, selectedPath, token]);

  const currentDetail =
    detail?.form.formPath === selectedPath ? detail : null;

  // 表單級多版本家族判定：detail 換了查一次（fieldId 只影響 hasField，
  // 家族清單與 fieldId 無關，借第一個欄位來查），決定公式列表是否顯示「版本」操作
  useEffect(() => {
    setVersionFamilyAvailable(false);
    setVersionsModalFormula(null);
    const probeFieldId =
      currentDetail?.formulas[0]?.fieldId ?? currentDetail?.fields[0]?.fieldId ?? null;
    const probeFormPath = currentDetail?.form.formPath ?? null;
    if (!probeFormPath || !probeFieldId) return;
    const controller = new AbortController();
    let cancelled = false;
    loadCachedFormulaSiblings(
      token,
      {
        formPath: probeFormPath,
        fieldId: probeFieldId,
        formulaKind: "formula",
        includeFreshness: false,
      },
      { signal: controller.signal }
    )
      .then((result) => {
        if (cancelled || controller.signal.aborted) return;
        setVersionFamilyAvailable(result.length > 0);
      })
      .catch(() => {
        // 家族判定失敗只是少顯示一顆按鈕，不打擾使用者
        if (!cancelled && !controller.signal.aborted) setVersionFamilyAvailable(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [currentDetail, token]);

  const activeWorkflowContent = useMemo(
    () => currentDetail?.workflows.find((workflow) => workflow.scope === activeWorkflow) ?? null,
    [activeWorkflow, currentDetail]
  );
  const selectedFormula = useMemo(() => {
    if (!currentDetail || selectedTarget?.type !== "formula") return null;
    return currentDetail.formulas.find(
      (formula) =>
        formula.fieldId === selectedTarget.fieldId &&
        formula.formulaKind === selectedTarget.formulaKind
    ) ?? null;
  }, [currentDetail, selectedTarget]);
  const selectedField = useMemo(() => {
    if (!currentDetail || selectedTarget?.type !== "field") return null;
    return currentDetail.fields.find((field) => field.fieldId === selectedTarget.fieldId) ?? null;
  }, [currentDetail, selectedTarget]);
  const selectedWorkflow = useMemo(() => {
    if (!currentDetail || selectedTarget?.type !== "workflow") return activeWorkflowContent;
    return currentDetail.workflows.find((workflow) => workflow.scope === selectedTarget.scope) ?? null;
  }, [activeWorkflowContent, currentDetail, selectedTarget]);
  const workflowOutline = useMemo(
    () => createWorkflowOutline(selectedWorkflow?.content, currentDetail),
    [currentDetail, selectedWorkflow]
  );
  const selectedFormSummary = useMemo(
    () => forms.find((form) => form.formPath === selectedPath) ?? currentDetail?.form ?? null,
    [currentDetail, forms, selectedPath]
  );
  const filteredFormulas = useMemo(() => {
    if (!currentDetail || detailSearchType === "field" || detailSearchType === "workflow") return [];
    return currentDetail.formulas.filter((formula) =>
      includesQuery(
        [
          formula.fieldId,
          formula.fieldName,
          formula.position,
          formula.sourceLine,
          FORMULA_KIND_LABELS[formula.formulaKind],
          formula.formulaKind,
          formula.displayFormula,
          formula.nuiFormula,
        ],
        detailQuery
      )
    );
  }, [currentDetail, detailQuery, detailSearchType]);
  const filteredFields = useMemo(() => {
    if (!currentDetail || detailSearchType === "formula" || detailSearchType === "workflow") return [];
    return currentDetail.fields.filter((field) =>
      includesQuery(
        [
          field.fieldId,
          field.fieldName,
          field.position,
          field.kind,
          field.sourceLine,
          ...Object.entries(field.attrs).flat(),
        ],
        detailQuery
      )
    );
  }, [currentDetail, detailQuery, detailSearchType]);
  const filteredWorkflows = useMemo(() => {
    if (!currentDetail || detailSearchType === "field" || detailSearchType === "formula") return [];
    return currentDetail.workflows.filter((workflow) =>
      includesQuery([workflow.scope, workflow.fileName, workflow.content], detailQuery)
    );
  }, [currentDetail, detailQuery, detailSearchType]);
  const visibleWorkflow = useMemo(
    () =>
      filteredWorkflows.find((workflow) => workflow.scope === activeWorkflow) ??
      filteredWorkflows[0] ??
      null,
    [activeWorkflow, filteredWorkflows]
  );
  const visibleWorkflowOutline = useMemo(
    () => createWorkflowOutline(visibleWorkflow?.content, currentDetail),
    [currentDetail, visibleWorkflow]
  );
  const isDetailFiltering = detailQuery.trim().length > 0;
  const detailQueryLooksLikeFormLookup = looksLikeFormLookup(detailQuery);

  const dryRunMatchesDraft =
    dryRunResult !== null &&
    dryRunResult.formPath === dryRunDraft.formPath.trim() &&
    dryRunResult.fieldId === dryRunDraft.fieldId.trim() &&
    dryRunResult.formulaKind === dryRunDraft.formulaKind &&
    dryRunResult.newFormula === dryRunDraft.newFormula;
  const canApply =
    dryRunMatchesDraft &&
    dryRunResult.allowed &&
    dryRunResult.blockers.length === 0 &&
    siblingSelectionState.pendingCount === 0 &&
    siblingSelectionState.blockedCount === 0 &&
    !devPresence.blocked &&
    !applyLoading;

  const handleDryRunDraftChange: React.Dispatch<
    React.SetStateAction<RagicFormulaPatchDryRunInput>
  > = useCallback((action) => {
    dryRunAbortRef.current?.abort();
    dryRunRequestSeqRef.current += 1;
    setDryRunLoading(false);
    setDryRunDraft((current) =>
      typeof action === "function" ? action(current) : action
    );
    setDryRunResult(null);
    setDryRunError(null);
    setApplyResult(null);
    setBatchApplyResult(null);
    setApplyError(null);
  }, []);

  const handleSelectFormPath = useCallback((formPath: string) => {
    setSelectedPath(formPath);
    writeStoredSelectedFormPath(formPath);
    setDetailQuery("");
    setDetailSearchType("formula");
    setFormPickerOpen(false);
  }, []);

  const handleOpenFormLookupFromDetailSearch = useCallback(() => {
    setFormQuery(detailQuery.trim());
    setFormPickerOpen(true);
  }, [detailQuery]);

  useEffect(() => {
    if (!formPickerOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setFormPickerOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [formPickerOpen]);

  useEffect(() => {
    if (!inspectorModalOpen) return;
    // 鎖背景捲動但保住位置：記住 scrollY、把 body 釘成 fixed（top 補回位移量），
    // 關閉時還原 style 再捲回原處。先前對 <html> 設 overflow:hidden 會在當下把
    // scroll 位置丟掉（一開就跳頂、關了也回不去），改用標準 body-scroll-lock。
    const scrollY = window.scrollY;
    const body = document.body;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setInspectorModalOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.left = previous.left;
      body.style.right = previous.right;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [inspectorModalOpen]);

  const runFormulaDryRun = useCallback(async (draft: RagicFormulaPatchDryRunInput) => {
    if (!draft.formPath.trim() || !draft.fieldId.trim()) {
      const message = "表單路徑 / 欄位 ID 必填";
      setDryRunError(message);
      showOperationNotice({
        key: "formula-dry-run",
        tone: "warning",
        title: "公式試算未執行",
        message,
      });
      return;
    }
    if (!draft.newFormula.trim()) {
      const message = "新公式必填";
      setDryRunError(message);
      showOperationNotice({
        key: "formula-dry-run",
        tone: "warning",
        title: "公式試算未執行",
        message,
      });
      return;
    }
    setDryRunLoading(true);
    setDryRunError(null);
    setApplyResult(null);
    setBatchApplyResult(null);
    setApplyError(null);
    dryRunAbortRef.current?.abort();
    const controller = new AbortController();
    dryRunAbortRef.current = controller;
    const requestSeq = dryRunRequestSeqRef.current + 1;
    dryRunRequestSeqRef.current = requestSeq;
    const requestDraft = {
      ...draft,
      formPath: draft.formPath.trim(),
      fieldId: draft.fieldId.trim(),
    };
    try {
      const result = await dryRunRagicFormulaPatch(token, requestDraft, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || dryRunRequestSeqRef.current !== requestSeq) return;
      setDryRunResult(result);
      const isDryRunBlocked = !result.allowed || result.blockers.length > 0;
      const formattedMessage = formatDryRunNoticeMessage(result);
      const { context, isCritical } = createFormulaPatchErrorDialogContextFromPayload({
        title: isDryRunBlocked
          ? result.allowed
            ? "公式試算被阻擋"
            : "公式試算失敗"
          : "公式試算可套用",
        message: formattedMessage,
        blockers: result.blockers,
        warnings: result.warnings,
        payload: result,
      });
      showOperationNotice({
        key: "formula-dry-run",
        tone: isDryRunBlocked ? "warning" : "success",
        title: isDryRunBlocked ? "公式試算被阻擋" : "公式試算可套用",
        message: formattedMessage,
      });
      if (isCritical || isDryRunBlocked) {
        openFormulaPatchErrorDialog(context);
      }
      setDryRunDraft((current) =>
        current.formPath.trim() === requestDraft.formPath &&
        current.fieldId.trim() === requestDraft.fieldId &&
        current.formulaKind === requestDraft.formulaKind &&
        current.newFormula === requestDraft.newFormula &&
        current.newFormula !== result.newFormula
          ? { ...current, newFormula: result.newFormula }
          : current
      );
    } catch (err) {
      if (controller.signal.aborted || dryRunRequestSeqRef.current !== requestSeq) return;
      setDryRunResult(null);
      const message = handleError(err, "公式 dry-run 失敗");
      setDryRunError(message);
      if (message) {
        const { context } = createFormulaPatchErrorDialogContextFromPayload({
          title: "公式試算失敗",
          message,
          blockers: [],
          payload: {
            message,
            ...(typeof err === "object" && err !== null ? err : {}),
          },
        });
        openFormulaPatchErrorDialog(context);
        showOperationNotice({
          key: "formula-dry-run",
          tone: "error",
          title: "公式試算失敗",
          message,
        });
      }
    } finally {
      if (dryRunRequestSeqRef.current === requestSeq) {
        setDryRunLoading(false);
        if (dryRunAbortRef.current === controller) dryRunAbortRef.current = null;
      }
    }
  }, [handleError, openFormulaPatchErrorDialog, showOperationNotice, token]);

  useEffect(() => {
    dryRunAbortRef.current?.abort();
    dryRunRequestSeqRef.current += 1;
    if (!inspectorModalOpen) {
      setDryRunLoading(false);
      return;
    }
    if (
      !dryRunDraft.formPath.trim() ||
      !dryRunDraft.fieldId.trim() ||
      !dryRunDraft.newFormula.trim()
    ) {
      setDryRunLoading(false);
      return;
    }
    const appliedResultStillCurrent =
      (applyResult?.applied &&
        formulaDryRunMatchesDraft(applyResult.dryRun, dryRunDraft)) ||
      (batchApplyResult?.applied &&
        batchApplyResult.results.some((result) =>
          formulaDryRunMatchesDraft(result.dryRun, dryRunDraft)
        ));
    if (appliedResultStillCurrent) {
      setDryRunLoading(false);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void runFormulaDryRun(dryRunDraft);
    }, FORMULA_DRY_RUN_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [
    applyResult,
    batchApplyResult,
    dryRunDraft,
    inspectorModalOpen,
    runFormulaDryRun,
  ]);

  function handleSelectFormulaForDryRun(formula: RagicDefinitionFormula) {
    if (!currentDetail) return;
    dryRunAbortRef.current?.abort();
    dryRunRequestSeqRef.current += 1;
    setDryRunLoading(false);
    setSelectedTarget({
      type: "formula",
      fieldId: formula.fieldId,
      formulaKind: formula.formulaKind,
    });
    setDryRunDraft(createFormulaDryRunDraft(currentDetail.form.formPath, formula));
    setDryRunResult(null);
    setDryRunError(null);
    setApplyResult(null);
    setBatchApplyResult(null);
    setApplyError(null);
  }

  const handleSelectWorkflow = useCallback((scope: string) => {
    setActiveWorkflow(scope);
    setSelectedTarget({ type: "workflow", scope });
  }, []);

  async function handleApplySubmit() {
    if (!canApply || applyLoading) return;
    setApplyLoading(true);
    setApplyError(null);
    const requestSeq = applyRequestSeqRef.current + 1;
    applyRequestSeqRef.current = requestSeq;
    const applyNoticeKey = `formula-apply:${requestSeq}`;
    showOperationNotice({
      key: `${applyNoticeKey}:start`,
      tone: "info",
      title: "公式套用中",
      message:
        siblingApplyTargets.length > 0
          ? `主表 + ${siblingApplyTargets.length} 張版本，套用前會重新檢查。`
          : "套用前會重新檢查目前公式狀態。",
    });

    const mainTarget = {
      ...dryRunDraft,
      formPath: dryRunDraft.formPath.trim(),
      fieldId: dryRunDraft.fieldId.trim(),
      newFormula: dryRunResult?.newFormula ?? dryRunDraft.newFormula,
    };
    const isCurrentApplyTarget = () =>
      applyRequestSeqRef.current === requestSeq &&
      selectedPathRef.current === mainTarget.formPath;
    try {
      dryRunAbortRef.current?.abort();
      const dryRunController = new AbortController();
      dryRunAbortRef.current = dryRunController;
      const dryRunSeq = dryRunRequestSeqRef.current + 1;
      dryRunRequestSeqRef.current = dryRunSeq;
      setDryRunLoading(true);
      const finalDryRun = await dryRunRagicFormulaPatch(token, mainTarget, {
        signal: dryRunController.signal,
      });
      if (
        dryRunController.signal.aborted ||
        dryRunRequestSeqRef.current !== dryRunSeq ||
        !isCurrentApplyTarget()
      ) {
        return;
      }
      setDryRunResult(finalDryRun);
      setDryRunDraft((current) =>
        current.formPath.trim() === mainTarget.formPath &&
        current.fieldId.trim() === mainTarget.fieldId &&
        current.formulaKind === mainTarget.formulaKind &&
        current.newFormula === mainTarget.newFormula &&
        current.newFormula !== finalDryRun.newFormula
          ? { ...current, newFormula: finalDryRun.newFormula }
          : current
      );
      if (!finalDryRun.allowed || finalDryRun.blockers.length > 0) {
        setApplyResult(null);
        setBatchApplyResult(null);
        const message = firstMessage(
          finalDryRun.blockers,
          "公式套用前檢查未通過，未寫入 .nui。"
        );
        openFormulaPatchErrorDialog(
          createFormulaPatchErrorDialogContext({
            title: "套用前檢查被阻擋",
            message,
            blockers: finalDryRun.blockers,
            warnings: finalDryRun.warnings,
            payload: finalDryRun,
          })
        );
        showOperationNotice({
          key: `${applyNoticeKey}:blocked`,
          tone: "warning",
          title: "套用前檢查被阻擋",
          message,
        });
        return;
      }
      mainTarget.newFormula = finalDryRun.newFormula;

      if (siblingApplyTargets.length > 0) {
        // 主表 + 勾選版本一次批次套用（all-or-nothing；逐張會被 git-clean
        // blocker 卡死：第一張套完 definitions 即 dirty）
        const batch = await applyRagicFormulaPatchBatch(token, [
          mainTarget,
          ...siblingApplyTargets,
        ]);
        if (!isCurrentApplyTarget()) return;
        setBatchApplyResult(batch);
        setApplyResult(null);
        if (batch.applied) {
          setBaselineCommitScopeFormPaths((current) =>
            mergeFormPathScope(current, [
              mainTarget.formPath,
              ...siblingApplyTargets.map((target) => target.formPath),
            ])
          );
          // 這輪結束：清試算結果（避免 canApply 殘留 true 連按兩次），
          // bump nonce 讓 SiblingsPanel 重查足跡並清掉勾選/舊「現行公式」
          setDryRunResult(null);
          setSiblingsRefreshNonce((nonce) => nonce + 1);
          const successMessage =
            `已套用主表與 ${siblingApplyTargets.length} 張版本；下一步請確認差異後提交 baseline。`;
          showOperationNotice({
            key: `${applyNoticeKey}:success`,
            tone: "success",
            title: "公式已套用",
            message: successMessage,
          }, {
            timeoutMs: FORMULA_APPLY_SUCCESS_NOTICE_MS,
          });
          setFormulaApplySuccessDialog({
            title: "公式已套用",
            message: successMessage,
            appliedCount: siblingApplyTargets.length + 1,
            formPaths: [
              mainTarget.formPath,
              ...siblingApplyTargets.map((target) => target.formPath),
            ],
          });
        } else {
          setDryRunResult(null);
          const blockers = batch.results.flatMap((item) => item.blockers);
          openFormulaPatchErrorDialog(
            createFormulaPatchErrorDialogContext({
              title: batch.rolledBack ? "已整批回滾" : "批次套用被阻擋",
              message: firstMessage(blockers, "沒有寫入任何表單。"),
              blockers,
              warnings: batch.results.flatMap((item) => item.warnings),
              payload: batch,
            })
          );
          showOperationNotice({
            key: `${applyNoticeKey}:blocked`,
            tone: "warning",
            title: batch.rolledBack ? "批次套用未完成，已回滾" : "批次套用被阻擋",
            message: firstMessage(blockers, "沒有寫入任何表單。"),
          });
        }
        if (batch.applied) {
          clearCachedFormulaSiblings();
          const [nextState, nextDetail] = await Promise.all([
            fetchRagicDefinitionsState(token),
            fetchRagicDefinitionFormDetail(token, mainTarget.formPath),
            refreshVersionControlStatus({ silent: true }),
          ]);
          if (!isCurrentApplyTarget()) return;
          setState(nextState);
          applyLoadedDetail(nextDetail, {
            preserveTarget: selectedTarget,
            preserveDraft: true,
            resetPatchState: false,
          });
        }
        return;
      }
      const result = await applyRagicFormulaPatch(token, mainTarget);
      if (!isCurrentApplyTarget()) return;
      setApplyResult(result);
      setBatchApplyResult(null);
      setDryRunResult(result.applied ? null : result.dryRun);
      if (result.applied) {
        clearCachedFormulaSiblings();
        const successMessage = "已更新 definitions baseline；下一步請確認差異後提交 baseline。";
        showOperationNotice({
          key: `${applyNoticeKey}:success`,
          tone: "success",
          title: "公式已套用",
          message: successMessage,
        }, {
          timeoutMs: FORMULA_APPLY_SUCCESS_NOTICE_MS,
        });
        setFormulaApplySuccessDialog({
          title: "公式已套用",
          message: successMessage,
          appliedCount: 1,
          formPaths: [result.dryRun.formPath],
        });
        setBaselineCommitScopeFormPaths((current) =>
          mergeFormPathScope(current, [result.dryRun.formPath])
        );
        const [nextState, nextDetail] = await Promise.all([
          fetchRagicDefinitionsState(token),
          fetchRagicDefinitionFormDetail(token, result.dryRun.formPath),
          refreshVersionControlStatus({ silent: true }),
        ]);
        if (!isCurrentApplyTarget()) return;
        setState(nextState);
        applyLoadedDetail(nextDetail, {
          preserveTarget: selectedTarget,
          preserveDraft: true,
          resetPatchState: false,
        });
      } else {
        const blockers = [...result.blockers, ...result.dryRun.blockers];
        openFormulaPatchErrorDialog(
          createFormulaPatchErrorDialogContext({
            title: result.rolledBack ? "公式套用失敗，已回滾" : "公式套用被阻擋",
            message: firstMessage(
              blockers,
              "沒有寫入任何表單。"
            ),
            blockers,
            warnings: [...result.warnings, ...result.dryRun.warnings],
            payload: result,
          })
        );
        showOperationNotice({
          key: `${applyNoticeKey}:blocked`,
          tone: "warning",
          title: "公式套用被阻擋",
          message: firstMessage(
            [...result.blockers, ...result.dryRun.blockers],
            "沒有寫入任何表單。"
          ),
        });
      }
    } catch (err) {
      if (!isCurrentApplyTarget()) return;
      setApplyResult(null);
      setBatchApplyResult(null);
      const message = handleError(err, "公式套用失敗");
      setApplyError(message);
      if (message) {
        openFormulaPatchErrorDialog(
          createFormulaPatchErrorDialogContext({
            title: "公式套用失敗",
            message,
            payload: {
              message,
              ...(typeof err === "object" && err !== null ? err : {}),
            },
          })
        );
        showOperationNotice({
          key: `${applyNoticeKey}:error`,
          tone: "error",
          title: "公式套用失敗",
          message,
        });
      }
    } finally {
      if (applyRequestSeqRef.current === requestSeq) {
        setApplyLoading(false);
        setDryRunLoading(false);
      }
    }
  }

  // useCallback 必要：它進 SiblingsPanel 的上報 effect deps，
  // 每 render 新 function 會造成上報→setState→re-render 無限循環
  const handleSiblingsTargetsChange = useCallback((targets: SiblingApplyTarget[]) => {
    setSiblingApplyTargets(targets);
  }, []);

  async function handleVersionRefresh() {
    if (versionLoading) return;
    setVersionLoading("refresh");
    setVersionError(null);
    setVersionActionResult(null);
    showOperationNotice({
      key: "version-refresh",
      tone: "info",
      title: "重新匯入中",
      message: "正在同步 Ragic Builder .nui 並重新載入 definitions。",
    });
    try {
      const result = await reExportRagicDefinitions(token);
      setState(result.state);
      setVersionStatus(result.versionStatus);
      setVersionActionResult({ type: "refresh", result });
      showOperationNotice({
        key: "version-refresh",
        tone: result.versionStatus.definitionsEntries.length > 0 ? "warning" : "success",
        title:
          result.versionStatus.definitionsEntries.length > 0
            ? "重新匯入完成，baseline 有差異"
            : "重新匯入完成",
        message: formatReExportNoticeMessage(result),
      });
      clearCachedFormulaSiblings();

      try {
        const formResult = await fetchRagicDefinitionForms(token, {
          q: formLookupPath,
          limit: 300,
        });
        setForms(formResult.data);
        setError(null);
      } catch (reloadError) {
        const message = handleError(reloadError, "同步後表單清單載入失敗");
        setError(message);
        if (message) {
          showOperationNotice({
            key: "version-refresh-list",
            tone: "warning",
            title: "表單清單重新載入失敗",
            message,
          });
        }
      }

      if (selectedPath) {
        try {
          const nextDetail = await fetchRagicDefinitionFormDetail(token, selectedPath);
          applyLoadedDetail(nextDetail, { preserveTarget: selectedTarget });
          setSiblingsRefreshNonce((nonce) => nonce + 1);
          setDetailError(null);
        } catch (reloadError) {
          const message = handleError(reloadError, "同步後表單 definition 載入失敗");
          setDetailError(message);
          if (message) {
            showOperationNotice({
              key: "version-refresh-detail",
              tone: "warning",
              title: "表單明細重新載入失敗",
              message,
            });
          }
        }
      }
    } catch (err) {
      const message = handleError(err, "definitions 同步失敗");
      setVersionError(message);
      if (message) {
        showOperationNotice({
          key: "version-refresh",
          tone: "error",
          title: "重新匯入失敗",
          message,
        });
      }
    } finally {
      setVersionLoading(null);
    }
  }

  async function handleRollbackLatestFormulaPatch() {
    if (versionLoading) return;
    const confirmed = window.confirm(
      [
        "確定要回復最近一次公式套用前的 .nui？",
        "",
        "這會用 .data 裡的公式套用備份覆寫 Ragic Builder .nui，然後重新匯入 definitions。",
        "不會建立 Git commit，也不會推送 main。",
      ].join("\n")
    );
    if (!confirmed) return;

    setVersionLoading("rollback");
    setVersionError(null);
    setVersionActionResult(null);
    showOperationNotice({
      key: "version-rollback",
      tone: "info",
      title: "回復套用前中",
      message: "正在用最近一次公式套用備份回復 .nui，並重新匯入 definitions。",
    });

    try {
      const result = await rollbackLatestRagicFormulaPatch(token);
      setState(result.state);
      setVersionStatus(result.versionStatus);
      setVersionActionResult({ type: "rollback", result });
      clearCachedFormulaSiblings();
      setSiblingsRefreshNonce((nonce) => nonce + 1);

      if (result.rolledBack) {
        setBaselineCommitScopeFormPaths([]);
        setDryRunResult(null);
        setDryRunError(null);
        setApplyResult(null);
        setBatchApplyResult(null);
        setApplyError(null);
        showOperationNotice({
          key: "version-rollback",
          tone: "success",
          title: "已回復套用前",
          message: `已回復 ${result.restoredCount} 張 .nui；請確認 baseline 差異。`,
        });

        try {
          const [formResult, nextDetail] = await Promise.all([
            fetchRagicDefinitionForms(token, {
              q: formLookupPath,
              limit: 300,
            }),
            selectedPath ? fetchRagicDefinitionFormDetail(token, selectedPath) : null,
          ]);
          setForms(formResult.data);
          if (nextDetail) {
            applyLoadedDetail(nextDetail, {
              preserveTarget: selectedTarget,
              resetPatchState: true,
            });
            setDetailError(null);
          }
        } catch (reloadError) {
          const message = handleError(reloadError, "回復後 definitions 畫面重新載入失敗");
          if (message) {
            showOperationNotice({
              key: "version-rollback-reload",
              tone: "warning",
              title: "回復後畫面重新載入失敗",
              message,
            });
          }
        }
      } else {
        const blockers = result.blockers;
        const message = firstMessage(blockers, "沒有覆寫任何 .nui。");
        openFormulaPatchErrorDialog(
          createFormulaPatchErrorDialogContext({
            title: "回復套用前被阻擋",
            message,
            blockers,
            warnings: result.warnings,
            payload: result,
          })
        );
        showOperationNotice({
          key: "version-rollback",
          tone: "warning",
          title: "回復套用前被阻擋",
          message,
        });
      }
    } catch (err) {
      const message = handleError(err, "回復套用前失敗");
      setVersionError(message);
      if (message) {
        openFormulaPatchErrorDialog(
          createFormulaPatchErrorDialogContext({
            title: "回復套用前失敗",
            message,
            payload: {
              message,
              ...(typeof err === "object" && err !== null ? err : {}),
            },
          })
        );
        showOperationNotice({
          key: "version-rollback",
          tone: "error",
          title: "回復套用前失敗",
          message,
        });
      }
    } finally {
      setVersionLoading(null);
    }
  }

  async function handleCommitBaseline() {
    if (versionLoading) return;
    setVersionLoading("commit");
    setVersionError(null);
    setVersionActionResult(null);
    showOperationNotice({
      key: "version-commit",
      tone: "info",
      title: "baseline 提交中",
      message:
        baselineCommitScopeFormPaths.length > 0
          ? `只提交 ${baselineCommitScopeFormPaths.length} 張本次套用表單。`
          : "正在提交 ragic-definitions baseline。",
    });
    try {
      const result = await commitRagicDefinitionsBaseline(token, versionMessage, {
        formPaths:
          baselineCommitScopeFormPaths.length > 0
            ? baselineCommitScopeFormPaths
            : undefined,
      });
      setVersionStatus(result.status);
      setVersionActionResult({ type: "commit", result });
      if (result.committed) {
        showOperationNotice({
          key: "version-commit",
          tone: "success",
          title: "baseline 已提交",
          message: result.commit
            ? `${result.commit.slice(0, 7)} · 下一步請推送 main。`
            : "下一步請推送 main。",
        });
        setBaselineCommitScopeFormPaths([]);
      } else {
        showOperationNotice({
          key: "version-commit",
          tone: "warning",
          title: "baseline 提交被阻擋",
          message: firstMessage(result.blockers, "沒有建立 commit。"),
        });
      }
      await refreshDefinitionsState();
    } catch (err) {
      const message = handleError(err, "definitions baseline 提交失敗");
      setVersionError(message);
      if (message) {
        showOperationNotice({
          key: "version-commit",
          tone: "error",
          title: "baseline 提交失敗",
          message,
        });
      }
    } finally {
      setVersionLoading(null);
    }
  }

  async function handlePushBaseline() {
    if (versionLoading) return;
    setVersionLoading("push");
    setVersionError(null);
    setVersionActionResult(null);
    showOperationNotice({
      key: "version-push",
      tone: "info",
      title: "推送中",
      message: "正在推送 main 到 origin。",
    });
    try {
      const result = await pushRagicDefinitionsBaseline(token);
      setVersionStatus(result.status);
      setVersionActionResult({ type: "push", result });
      showOperationNotice({
        key: "version-push",
        tone: result.pushed ? "success" : "warning",
        title: result.pushed ? "已推送 main" : "推送被阻擋",
        message: result.pushed
          ? "origin/main 已更新。"
          : firstMessage(result.blockers, "沒有推送任何 commit。"),
      });
      await refreshDefinitionsState();
    } catch (err) {
      const message = handleError(err, "definitions baseline 推送失敗");
      setVersionError(message);
      if (message) {
        showOperationNotice({
          key: "version-push",
          tone: "error",
          title: "推送失敗",
          message,
        });
      }
    } finally {
      setVersionLoading(null);
    }
  }

  const inspectorPanelProps = currentDetail
    ? {
        token,
        detail: currentDetail,
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
        siblingTargetCount: siblingApplyTargets.length,
        siblingSelectionState,
        siblingsRefreshNonce,
        onDryRunChange: handleDryRunDraftChange,
        onApply: handleApplySubmit,
        onSiblingsTargetsChange: handleSiblingsTargetsChange,
        onSiblingsSelectionStateChange: setSiblingSelectionState,
        onSiblingsError: handleError,
      }
    : null;
  const definitionsStyle = {
    "--ragic-defs-context-height": `${contextHeight}px`,
  } as CSSProperties;

  return (
    <div className="ragic-defs" style={definitionsStyle}>
      <DevCommandBar
        state={state}
        detail={currentDetail}
        selectedForm={selectedFormSummary}
        loading={loading}
        status={versionStatus}
        versionLoading={versionLoading}
        realtime={{
          connected: realtimeConnected,
          disconnectedSince: realtimeDisconnectedSince,
          status: realtimeSync?.status ?? null,
          message: realtimeSync?.message ?? null,
          reloading: realtimeReloading,
        }}
        presence={devPresence}
        onRefresh={handleVersionRefresh}
        onRollback={handleRollbackLatestFormulaPatch}
        onCommit={handleCommitBaseline}
        onPush={handlePushBaseline}
        rollbackAvailable={Boolean(versionStatus?.definitionsEntries.length)}
        commitScopeFormPaths={baselineCommitScopeFormPaths}
      />
      <BaselineStatusBar
        status={versionStatus}
        message={versionMessage}
        commitScopeFormPaths={baselineCommitScopeFormPaths}
        loading={versionLoading}
        error={versionError}
        actionResult={versionActionResult}
        onMessageChange={setVersionMessage}
      />
      <OperationNoticeStack notices={operationNotices} onDismiss={dismissOperationNotice} />
      {devPresence.maintenanceMessage ? (
        <p className="dev-mode-warning">{devPresence.maintenanceMessage}</p>
      ) : null}
      {devPresence.blocked ? (
        <p className="dev-mode-error">
          {devPresence.blockedReason || "此 Dev definitions tab 已被管理端暫時停用"}
        </p>
      ) : null}
      {error ? <p className="dev-mode-error">{error}</p> : null}

      <div
        className={`ragic-defs__grid${
          formRailExpanded ? "" : " ragic-defs__grid--form-rail-collapsed"
        }`}
      >
        <DefinitionsFormRail
          forms={forms}
          query={formQuery}
          lookupPath={formLookupPath}
          selectedPath={selectedPath}
          loading={loading}
          expanded={formRailExpanded}
          onQueryChange={setFormQuery}
          onSelect={handleSelectFormPath}
          onExpandedChange={setFormRailExpanded}
          onOpenPicker={() => setFormPickerOpen(true)}
        />
        <main className="ragic-defs__main">
          <FormContextBar
            contextRef={contextRef}
            detail={currentDetail}
            selectedPath={selectedPath}
            selectedForm={selectedFormSummary}
            detailQuery={detailQuery}
            detailSearchType={detailSearchType}
            filteredFieldCount={filteredFields.length}
            filteredFormulaCount={filteredFormulas.length}
            filteredWorkflowCount={filteredWorkflows.length}
            isDetailFiltering={isDetailFiltering}
            looksLikeFormLookup={detailQueryLooksLikeFormLookup}
            onQueryChange={setDetailQuery}
            onSearchTypeChange={setDetailSearchType}
            onOpenFormLookupFromDetailSearch={handleOpenFormLookupFromDetailSearch}
          />

          <section className="ragic-defs__detail">
            <DefinitionsExplorerDetailStateBlock
              detailError={detailError}
              detailLoading={detailLoading}
              hasDetail={Boolean(currentDetail)}
            />
            {currentDetail ? (
              <div className="ragic-defs__workspace">
                <div className="ragic-defs__content">
                  {detailSearchType === "formula" ? (
                    <FormulaTable
                      formulas={filteredFormulas}
                      emptyText={isDetailFiltering ? "沒有符合條件的公式" : "沒有公式"}
                      selectedFormula={selectedFormula}
                      onSelectFormula={handleSelectFormulaForDryRun}
                      versionFamilyAvailable={versionFamilyAvailable}
                      onShowVersions={setVersionsModalFormula}
                    />
                  ) : null}
                  {detailSearchType === "formula" ? (
                    <FormulaVersionPreviewPanel
                      token={token}
                      detail={currentDetail}
                      formula={selectedFormula}
                      enabled={versionFamilyAvailable}
                      onOpenVersions={setVersionsModalFormula}
                      onError={handleError}
                    />
                  ) : null}
                  {detailSearchType === "workflow" ? (
                    <WorkflowPanel
                      workflows={filteredWorkflows}
                      activeScope={visibleWorkflow?.scope ?? null}
                      activeWorkflow={visibleWorkflow}
                      outline={visibleWorkflowOutline}
                      onSelectScope={handleSelectWorkflow}
                    />
                  ) : null}
                  {detailSearchType === "field" ? (
                    <FieldTable
                      fields={filteredFields}
                      emptyText={isDetailFiltering ? "沒有符合條件的欄位" : "沒有欄位"}
                      selectedField={selectedField}
                      onSelectField={(field) =>
                        setSelectedTarget({ type: "field", fieldId: field.fieldId })
                      }
                    />
                  ) : null}
                </div>
                {/* modal 開著時不掛 inline 檢查器：兩個 SiblingsPanel 實例會
                    互相覆寫批次 targets（看得見的勾選 ≠ 實際送出） */}
                {inspectorPanelProps && !inspectorModalOpen ? (
                  <InspectorPanel
                    {...inspectorPanelProps}
                    onOpenModal={() => setInspectorModalOpen(true)}
                  />
                ) : null}
              </div>
            ) : detailLoading ? (
              <p className="ragic-inline__hint ragic-loading-inline">載入中…</p>
            ) : (
              <p className="ragic-inline__hint">請選擇一張表單。</p>
            )}
          </section>
        </main>
      </div>

      {versionsModalFormula && currentDetail ? (
        <RagicFieldVersionsModal
          key={`${currentDetail.form.formPath}:${versionsModalFormula.fieldId}:${versionsModalFormula.formulaKind}:${siblingsRefreshNonce}`}
          token={token}
          formPath={currentDetail.form.formPath}
          formName={currentDetail.form.formName}
          formula={
            currentDetail.formulas.find(
              (formula) =>
                formula.fieldId === versionsModalFormula.fieldId &&
                formula.formulaKind === versionsModalFormula.formulaKind
            ) ?? versionsModalFormula
          }
          onClose={() => setVersionsModalFormula(null)}
          onError={handleError}
        />
      ) : null}
      {formPickerOpen ? (
        <FormPickerModal
          forms={forms}
          query={formQuery}
          lookupPath={formLookupPath}
          selectedPath={selectedPath}
          onQueryChange={setFormQuery}
          onSelect={handleSelectFormPath}
          onClose={() => setFormPickerOpen(false)}
        />
      ) : null}
      {formulaPatchErrorDialog ? createPortal(
        <FormulaPatchErrorDialog
          context={formulaPatchErrorDialog}
          copyState={formulaPatchErrorCopyState}
          onCopy={copyFormulaPatchErrorDetails}
          onClose={closeFormulaPatchErrorDialog}
        />,
        document.body
      ) : null}
      {formulaApplySuccessDialog ? createPortal(
        <FormulaApplySuccessDialog
          state={formulaApplySuccessDialog}
          onClose={closeFormulaApplySuccessDialog}
        />,
        document.body
      ) : null}
      {inspectorModalOpen && inspectorPanelProps
        ? createPortal(
            <div
              className="ragic-defs__inspector-backdrop"
              role="presentation"
              onMouseDown={() => setInspectorModalOpen(false)}
            >
              <section
                className="ragic-defs__inspector-modal"
                role="dialog"
                aria-modal="true"
                aria-label="獨立檢查器"
                onMouseDown={(event) => event.stopPropagation()}
              >
                <InspectorPanel
                  {...inspectorPanelProps}
                  modal
                  onCloseModal={() => setInspectorModalOpen(false)}
                />
              </section>
            </div>,
            document.body
          )
        : null}
      <RagicDefinitionsAiAssistant
        token={token}
        draft={dryRunDraft}
        onDraftChange={handleDryRunDraftChange}
        onOpenFormulaEditor={() => setInspectorModalOpen(true)}
        onError={handleError}
      />
      {scrollHint ? (
        <DefinitionsExplorerScrollButtons
          scrollHint={scrollHint}
          scrollShortcutClassName={scrollShortcutClassName}
          scrollShortcutExpanded={scrollShortcutExpanded}
          onScrollShortcutHoverStart={handleScrollShortcutHoverStart}
          onScrollShortcutHoverEnd={handleScrollShortcutHoverEnd}
          onScrollShortcut={handleScrollShortcut}
        />
      ) : null}
    </div>
  );
}

function DefinitionsFormRail({
  forms,
  query,
  lookupPath,
  selectedPath,
  loading,
  expanded,
  onQueryChange,
  onSelect,
  onExpandedChange,
  onOpenPicker,
}: {
  forms: RagicDefinitionForm[];
  query: string;
  lookupPath: string;
  selectedPath: string | null;
  loading: boolean;
  expanded: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (formPath: string) => void;
  onExpandedChange: (expanded: boolean) => void;
  onOpenPicker: () => void;
}) {
  const canOpenLookup = isCompleteFormPath(lookupPath);
  const listId = "ragic-defs-form-rail-list";
  const groups = useMemo(() => {
    const groupMap = new Map<string, RagicDefinitionForm[]>();
    for (const form of forms) {
      const [namespace, category] = form.formPath.split("/");
      const key = category ? `${namespace}/${category}` : namespace || "未分類";
      const current = groupMap.get(key);
      if (current) {
        current.push(form);
      } else {
        groupMap.set(key, [form]);
      }
    }
    return Array.from(groupMap.entries())
      .map(([name, groupForms]) => ({
        name,
        forms: groupForms.sort((a, b) => a.formPath.localeCompare(b.formPath)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [forms]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canOpenLookup) {
      onSelect(lookupPath);
      return;
    }
    onOpenPicker();
  }

  return (
    <aside
      className={`ragic-defs__form-rail${expanded ? "" : " is-collapsed"}`}
      aria-label="definition forms"
    >
      <div className="ragic-defs__form-rail-head">
        <div>
          <strong>表單探索</strong>
          <span className={loading ? "ragic-loading-inline" : undefined}>
            {loading ? "載入中" : `${forms.length.toLocaleString()} 筆`}
          </span>
        </div>
        <div className="ragic-defs__form-rail-actions">
          <button
            type="button"
            className="dev-mode-btn"
            onClick={onOpenPicker}
            aria-label="開啟表單選擇器"
            title="開啟表單選擇器"
          >
            <SearchOutlined />
          </button>
          <button
            type="button"
            className="dev-mode-btn ragic-defs__form-rail-toggle"
            onClick={() => onExpandedChange(!expanded)}
            aria-expanded={expanded}
            aria-controls={listId}
            title={expanded ? "收合表單清單" : "展開表單清單"}
          >
            {expanded ? <UpOutlined /> : <DownOutlined />}
            <span>{expanded ? "收合" : "展開"}</span>
          </button>
        </div>
      </div>
      <form className="ragic-defs__form-rail-search" onSubmit={handleSubmit}>
        <input
          type="search"
          className="ragic-inline__search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜尋表單 / 路徑 / URL"
          aria-label="搜尋 definitions 表單"
        />
      </form>
      {canOpenLookup && lookupPath !== query.trim() ? (
        <button
          type="button"
          className="ragic-defs__form-rail-lookup"
          onClick={() => onSelect(lookupPath)}
        >
          開啟 <code>{lookupPath}</code>
        </button>
      ) : null}
      <div id={listId} className="ragic-defs__form-rail-list" hidden={!expanded}>
        {groups.length ? (
          groups.map((group) => (
            <section key={group.name} className="ragic-defs__form-rail-group">
              <div className="ragic-defs__form-rail-group-head">
                <strong>{group.name}</strong>
                <span>{group.forms.length}</span>
              </div>
              {group.forms.map((form) => (
                <button
                  key={form.formPath}
                  type="button"
                  className={`ragic-defs__form-rail-row${
                    selectedPath === form.formPath ? " is-active" : ""
                  }`}
                  onClick={() => onSelect(form.formPath)}
                >
                  <span>{form.formName || "(未命名)"}</span>
                  <code>{form.formPath}</code>
                  <small>
                    {form.counts.fields.toLocaleString()} 欄 ·{" "}
                    {form.counts.formulas.toLocaleString()} 公式 ·{" "}
                    {form.counts.workflows.toLocaleString()} workflow
                  </small>
                </button>
              ))}
            </section>
          ))
        ) : (
          <p className={`ragic-inline__hint${loading ? " ragic-loading-inline" : ""}`}>
            {loading ? "表單清單載入中…" : "沒有符合條件的表單"}
          </p>
        )}
      </div>
    </aside>
  );
}

interface FormulaVersionPreviewRow {
  formPath: string;
  formName: string;
  role: "current" | "version";
  hasField: boolean;
  formula: string | null;
  position: string | null;
  definitionsMissing: boolean;
}

function FormulaVersionPreviewPanel({
  token,
  detail,
  formula,
  enabled,
  onOpenVersions,
  onError,
}: {
  token: string;
  detail: RagicDefinitionFormDetail;
  formula: RagicDefinitionFormula | null;
  enabled: boolean;
  onOpenVersions: (formula: RagicDefinitionFormula) => void;
  onError: (err: unknown, fallback: string) => string | null;
}) {
  const [expanded, setExpanded] = useState(readStoredVersionPreviewExpanded);
  const requestKey =
    enabled && expanded && formula
      ? `${detail.form.formPath}:${formula.fieldId}:${formula.formulaKind}:${formula.position}:${formula.nuiFormula}`
      : "";
  const [previewState, setPreviewState] = useState<{
    key: string;
    siblings: RagicFormulaSiblingInfo[];
    error: string | null;
  }>({ key: "", siblings: [], error: null });
  const cachedSiblings = useMemo(() => {
    if (!requestKey || !formula) return null;
    return readCachedFormulaSiblings({
      formPath: detail.form.formPath,
      fieldId: formula.fieldId,
      formulaKind: formula.formulaKind,
      includeFreshness: false,
    });
  }, [detail.form.formPath, formula, requestKey]);
  const stateMatchesRequest = previewState.key === requestKey;
  const siblings = stateMatchesRequest ? previewState.siblings : cachedSiblings;
  const error = stateMatchesRequest ? previewState.error : null;
  const loading = Boolean(requestKey && !stateMatchesRequest);

  useEffect(() => {
    writeStoredVersionPreviewExpanded(expanded);
  }, [expanded]);

  useEffect(() => {
    if (!requestKey || !formula) return;
    const controller = new AbortController();
    let cancelled = false;
    const query = {
      formPath: detail.form.formPath,
      fieldId: formula.fieldId,
      formulaKind: formula.formulaKind,
      includeFreshness: false,
    };
    loadCachedFormulaSiblings(token, query, { signal: controller.signal })
      .then((siblingsResult) => {
        if (cancelled || controller.signal.aborted) return;
        setPreviewState({ key: requestKey, siblings: siblingsResult, error: null });
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        const message = onError(err, "跨版本公式載入失敗");
        if (message !== null) {
          setPreviewState({ key: requestKey, siblings: [], error: message });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    detail.form.formPath,
    formula,
    formula?.fieldId,
    formula?.formulaKind,
    onError,
    requestKey,
    token,
  ]);

  if (!enabled || !formula) return null;

  const rows: FormulaVersionPreviewRow[] = expanded
    ? [
        {
          formPath: detail.form.formPath,
          formName: detail.form.formName || "(未命名)",
          role: "current",
          hasField: true,
          formula: formula.displayFormula,
          position: formula.position,
          definitionsMissing: false,
        },
        ...(siblings ?? []).map((sibling) => ({
          formPath: sibling.formPath,
          formName: sibling.formName || "(未命名)",
          role: "version" as const,
          hasField: sibling.hasField,
          formula: sibling.currentFormula,
          position: sibling.freshness.baselinePosition ?? sibling.fieldPosition,
          definitionsMissing: sibling.definitionsMissing,
        })),
      ]
    : [];

  return (
    <section className={`ragic-defs__block ragic-defs__version-preview${
      expanded ? " is-expanded" : " is-collapsed"
    }`}>
      <div className="ragic-defs__panel-head">
        <strong>跨版本該欄位公式</strong>
        <div className="ragic-defs__version-preview-head-actions">
          <span className={expanded && loading ? "ragic-loading-inline" : undefined}>
            {expanded ? (loading ? "查詢中…" : `${Math.max(0, rows.length - 1)} 張版本`) : "已收合"}
          </span>
          <button
            type="button"
            className="dev-mode-btn ragic-defs__version-preview-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <UpOutlined /> : <DownOutlined />}
            {expanded ? "收合" : "展開"}
          </button>
        </div>
      </div>
      {!expanded ? (
        <p className="ragic-inline__hint">展開後查看目前表單與各版本表單的同欄位公式。</p>
      ) : (
        <>
          {error ? <p className="dev-mode-error">{error}</p> : null}
          <div className="ragic-defs__version-preview-list">
            {rows.map((row) => (
              <div
                key={row.formPath}
                className={`ragic-defs__version-preview-row${
                  row.role === "current" ? " is-current" : ""
                }`}
              >
                <div className="ragic-defs__version-preview-meta">
                  <strong>{row.formName}</strong>
                  <code>{row.formPath}</code>
                  <span>{row.role === "current" ? "目前表單" : "版本表單"}</span>
                  <small>{row.hasField ? row.position ?? "無位置" : "欄位不存在"}</small>
                </div>
                <div className="ragic-defs__version-preview-formula">
                  {row.definitionsMissing ? (
                    <em>definitions 缺檔，請先重新匯入</em>
                  ) : !row.hasField ? (
                    <em>此版本沒有這個欄位</em>
                  ) : row.formula ? (
                    <FormulaSyntax value={row.formula} title={row.formula} />
                  ) : (
                    <em>（無公式）</em>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="dev-mode-btn ragic-defs__version-preview-action"
            onClick={() => onOpenVersions(formula)}
          >
            開啟跨版本詳細
          </button>
        </>
      )}
    </section>
  );
}

function FormulaPatchErrorDialog({
  context,
  copyState,
  onCopy,
  onClose,
}: {
  context: FormulaPatchErrorDialogContext;
  copyState: "idle" | "copied" | "failed";
  onCopy: () => void;
  onClose: () => void;
}) {
  const copyStateText =
    copyState === "copied" ? "已複製" : copyState === "failed" ? "複製失敗" : "複製診斷資訊";

  return (
    <div
      className="ragic-defs__formula-patch-error-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="ragic-defs__formula-patch-error-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label="公式套用錯誤"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ragic-defs__formula-patch-error-header">
          <h3>{context.title}</h3>
          <button
            type="button"
            className="ragic-defs__formula-patch-error-close"
            onClick={onClose}
            aria-label="關閉錯誤訊息"
          >
            <CloseOutlined />
          </button>
        </header>

        <p className="ragic-defs__formula-patch-error-message">{context.message}</p>

        {context.formPaths.length > 0 ? (
          <section className="ragic-defs__formula-patch-error-meta">
            <h4>受影響表單</h4>
            <ul>
              {context.formPaths.map((formPath) => (
                <li key={formPath}>{formPath}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="ragic-defs__formula-patch-error-meta">
          <h4>診斷資訊</h4>
          <dl>
            {context.sheetPath ? (
              <>
                <dt>Sheet path</dt>
                <dd>{context.sheetPath}</dd>
              </>
            ) : null}
            {context.sourceEncoding ? (
              <>
                <dt>Source encoding</dt>
                <dd>{context.sourceEncoding}</dd>
              </>
            ) : null}
            {context.requestId ? (
              <>
                <dt>Request ID</dt>
                <dd>{context.requestId}</dd>
              </>
            ) : null}
            {context.traceId ? (
              <>
                <dt>Trace ID</dt>
                <dd>{context.traceId}</dd>
              </>
            ) : null}
          </dl>
        </section>

        {context.fatalValidationErrors.length > 0 ? (
          <section className="ragic-defs__formula-patch-error-list">
            <h4>Fatal validation errors</h4>
            <ul>
              {context.fatalValidationErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {context.blockers.length > 0 ? (
          <section className="ragic-defs__formula-patch-error-list">
            <h4>阻擋原因</h4>
            <ul>
              {context.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {context.warnings.length > 0 ? (
          <section className="ragic-defs__formula-patch-error-list">
            <h4>警告</h4>
            <ul>
              {context.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <details className="ragic-defs__formula-patch-error-details">
          <summary>完整原始回應</summary>
          <pre><code>{context.raw}</code></pre>
        </details>

        <div className="ragic-defs__formula-patch-error-actions">
          <button
            type="button"
            className={`dev-mode-btn ragic-defs__code-copy${
              copyState === "copied"
                ? " is-copied"
                : copyState === "failed"
                  ? " is-failed"
                  : ""
            }`}
            onClick={onCopy}
          >
            <CopyOutlined />
            {copyStateText}
          </button>
          <button
            type="button"
            className="dev-mode-btn"
            onClick={onClose}
          >
            關閉
          </button>
        </div>
      </section>
    </div>
  );
}

function FormulaApplySuccessDialog({
  state,
  onClose,
}: {
  state: FormulaApplySuccessDialogState;
  onClose: () => void;
}) {
  return (
    <div
      className="ragic-defs__formula-apply-success-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="ragic-defs__formula-apply-success-modal"
        role="dialog"
        aria-modal="true"
        aria-label="公式套用成功"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ragic-defs__formula-apply-success-header">
          <div>
            <span className="ragic-defs__formula-apply-success-badge">成功</span>
            <h3>{state.title}</h3>
          </div>
          <button
            type="button"
            className="ragic-defs__formula-apply-success-close"
            onClick={onClose}
            aria-label="關閉套用成功訊息"
          >
            <CloseOutlined />
          </button>
        </header>

        <p className="ragic-defs__formula-apply-success-message">{state.message}</p>

        <dl className="ragic-defs__formula-apply-success-summary">
          <dt>套用範圍</dt>
          <dd>{state.appliedCount.toLocaleString()} 張表單</dd>
        </dl>

        {state.formPaths.length > 0 ? (
          <section className="ragic-defs__formula-apply-success-list">
            <h4>已更新表單</h4>
            <ul>
              {state.formPaths.map((formPath) => (
                <li key={formPath}>{formPath}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="ragic-defs__formula-apply-success-actions">
          <button
            type="button"
            className="dev-mode-btn"
            onClick={onClose}
          >
            關閉
          </button>
        </div>
      </section>
    </div>
  );
}

function FormContextBar({
  contextRef,
  detail,
  selectedPath,
  selectedForm,
  detailQuery,
  detailSearchType,
  filteredFieldCount,
  filteredFormulaCount,
  filteredWorkflowCount,
  isDetailFiltering,
  looksLikeFormLookup,
  onQueryChange,
  onSearchTypeChange,
  onOpenFormLookupFromDetailSearch,
}: {
  contextRef: RefObject<HTMLElement | null>;
  detail: RagicDefinitionFormDetail | null;
  selectedPath: string | null;
  selectedForm: RagicDefinitionForm | null;
  detailQuery: string;
  detailSearchType: DetailSearchType;
  filteredFieldCount: number;
  filteredFormulaCount: number;
  filteredWorkflowCount: number;
  isDetailFiltering: boolean;
  looksLikeFormLookup: boolean;
  onQueryChange: (query: string) => void;
  onSearchTypeChange: (type: DetailSearchType) => void;
  onOpenFormLookupFromDetailSearch: () => void;
}) {
  const form = detail?.form ?? selectedForm;
  return (
    <section ref={contextRef} className="ragic-defs__context">
      <div className="ragic-defs__context-main">
        <div className="ragic-defs__context-title">
          <strong>{form?.formName || "(未命名)"}</strong>
          <code>{form?.formPath ?? selectedPath ?? "未選擇表單"}</code>
        </div>
        <div className="ragic-defs__context-meta">
          <span>{detail?.form.sourceRelativePath ?? form?.sourceRelativePath ?? "nui file"}</span>
          <span>{detail?.form.sourceEncoding ?? form?.sourceEncoding ?? "encoding"}</span>
          <span>
            {detail
              ? `${detail.fields.length} 欄 · ${detail.formulas.length} 公式 · ${detail.workflows.length} workflow`
              : "loading"}
          </span>
        </div>
      </div>
      <div className="ragic-defs__context-tools">
        <input
          type="search"
          className="ragic-inline__search"
          value={detailQuery}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜尋欄位 ID、欄位名稱、公式或 workflow"
          aria-label="search current form fields formulas and workflows"
          disabled={!detail}
        />
        <div className="ragic-defs__seg" role="tablist" aria-label="current form search type">
          {(["formula", "field", "workflow"] as const).map((type) => (
            <button
              key={type}
              type="button"
              className={detailSearchType === type ? "is-active" : ""}
              onClick={() => onSearchTypeChange(type)}
              disabled={!detail}
            >
              {type === "formula" ? "公式" : type === "field" ? "欄位" : "Workflow"}
            </button>
          ))}
        </div>
      </div>
      <div className="ragic-defs__context-foot">
        <span>
          {detail
            ? `${filteredFieldCount.toLocaleString()} 欄 · ${filteredFormulaCount.toLocaleString()} 公式 · ${filteredWorkflowCount.toLocaleString()} workflow`
            : "請先選擇表單"}
        </span>
        {isDetailFiltering && detail ? (
          <span>
            搜尋範圍：<code>{detail.form.formPath}</code>
          </span>
        ) : null}
        {looksLikeFormLookup ? (
          <button
            type="button"
            className="ragic-defs__context-link"
            onClick={onOpenFormLookupFromDetailSearch}
          >
            用「{detailQuery.trim()}」找表單
          </button>
        ) : null}
      </div>
    </section>
  );
}
