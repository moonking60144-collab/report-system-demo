import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { COLUMN_TYPE_MAP } from "../constants";
import type {
  ColumnAnalysisState,
  ColumnFilterRule,
  ColumnFilterState,
  ColumnKey,
  ColumnMenuSearchState,
  ColumnSortDirection,
  ColumnSortRule,
  ColumnTextFilterDialogState,
} from "../types";
import { hasActiveColumnFilterRule, hasActiveColumnFilters, sanitizeColumnTextFilterInput } from "../utils";

interface UseColumnMenuStateOptions {
  setPage: Dispatch<SetStateAction<number>>;
  initialState?: {
    columnFilterState?: ColumnFilterState;
    columnSortRules?: ColumnSortRule[];
  };
}

export function useColumnMenuState({ setPage, initialState }: UseColumnMenuStateOptions) {
  const [columnFilterState, setColumnFilterState] = useState<ColumnFilterState>(
    () => initialState?.columnFilterState ?? {}
  );
  const [columnSortRules, setColumnSortRules] = useState<ColumnSortRule[]>(
    () => initialState?.columnSortRules ?? []
  );
  const [columnMenuOpenKey, setColumnMenuOpenKey] = useState<ColumnKey | null>(null);
  const [columnMenuSearchState, setColumnMenuSearchState] = useState<ColumnMenuSearchState>({});
  const [columnAnalysisState, setColumnAnalysisState] = useState<ColumnAnalysisState>({ open: false, columnKey: null });
  const [columnAnalysisLabel, setColumnAnalysisLabel] = useState<string>("");
  const [columnTextFilterDialog, setColumnTextFilterDialog] = useState<ColumnTextFilterDialogState>({
    open: false,
    columnKey: null,
    columnLabel: "",
    draftValue: "",
  });
  const columnMenuInteractRef = useRef(false);

  const hasActiveColumnMenuFilters = useMemo(
    () => hasActiveColumnFilters(columnFilterState),
    [columnFilterState]
  );
  const hasActiveColumnSortRules = columnSortRules.length > 0;
  const isColumnAnalysisOpen = columnAnalysisState.open && Boolean(columnAnalysisState.columnKey);

  const handleColumnMenuOpenChange = useCallback((columnKey: ColumnKey, nextOpen: boolean): void => {
    if (!nextOpen && columnMenuInteractRef.current) {
      return;
    }
    setColumnMenuOpenKey(nextOpen ? columnKey : null);
  }, []);

  const markColumnMenuInteract = useCallback((): void => {
    columnMenuInteractRef.current = true;
    window.setTimeout(() => {
      columnMenuInteractRef.current = false;
    }, 0);
  }, []);

  const handleColumnMenuSearchChange = useCallback((columnKey: ColumnKey, searchText: string): void => {
    setColumnMenuSearchState((prev) => ({ ...prev, [columnKey]: searchText }));
  }, []);

  const omitColumnKey = useCallback((state: ColumnFilterState, columnKey: ColumnKey): ColumnFilterState => {
    const nextState = { ...state };
    delete nextState[columnKey];
    return nextState;
  }, []);

  const omitSearchKey = useCallback((state: ColumnMenuSearchState, columnKey: ColumnKey): ColumnMenuSearchState => {
    const nextState = { ...state };
    delete nextState[columnKey];
    return nextState;
  }, []);

  const applyColumnTextFilter = useCallback((columnKey: ColumnKey, rawInput: string): void => {
    const nextTextQuery = sanitizeColumnTextFilterInput(rawInput);

    setColumnMenuSearchState((prev) => ({
      ...prev,
      [columnKey]: nextTextQuery,
    }));

    setColumnFilterState((prev) => {
      const prevRule = prev[columnKey];
      const nextRule: ColumnFilterRule = { ...(prevRule ?? {}) };

      if (nextTextQuery) {
        nextRule.textQuery = nextTextQuery;
      } else {
        delete nextRule.textQuery;
      }

      if (!hasActiveColumnFilterRule(nextRule)) {
        if (!prevRule) {
          return prev;
        }
        return omitColumnKey(prev, columnKey);
      }

      return { ...prev, [columnKey]: nextRule };
    });

    setPage(1);
  }, [omitColumnKey, setPage]);

  const toggleColumnFilterToken = useCallback((columnKey: ColumnKey, token: string): void => {
    setColumnFilterState((prev) => {
      const prevRule = prev[columnKey];
      const currentTokens = prevRule?.selectedTokens ?? [];
      const hasToken = currentTokens.includes(token);
      const nextTokens = hasToken
        ? currentTokens.filter((value) => value !== token)
        : [...currentTokens, token];

      const nextRule: ColumnFilterRule = { ...(prevRule ?? {}) };
      if (nextTokens.length > 0) {
        nextRule.selectedTokens = nextTokens;
      } else {
        delete nextRule.selectedTokens;
      }

      if (!hasActiveColumnFilterRule(nextRule)) {
        if (!prevRule) {
          return prev;
        }
        return omitColumnKey(prev, columnKey);
      }

      return { ...prev, [columnKey]: nextRule };
    });
    setPage(1);
  }, [omitColumnKey, setPage]);

  const clearColumnFilter = useCallback((columnKey: ColumnKey): void => {
    setColumnFilterState((prev) => {
      if (!prev[columnKey]) {
        return prev;
      }
      return omitColumnKey(prev, columnKey);
    });
    setColumnMenuSearchState((prev) => {
      if (!(columnKey in prev)) {
        return prev;
      }
      return omitSearchKey(prev, columnKey);
    });
    setPage(1);
  }, [omitColumnKey, omitSearchKey, setPage]);

  const applyColumnSortRule = useCallback((columnKey: ColumnKey, direction: ColumnSortDirection): void => {
    const type = COLUMN_TYPE_MAP[columnKey] ?? "text";
    setColumnSortRules((prev) => {
      const next = prev.filter((rule) => rule.key !== columnKey);
      next.push({ key: columnKey, direction, type });
      return next;
    });
    setPage(1);
  }, [setPage]);

  const clearColumnSortRule = useCallback((columnKey: ColumnKey): void => {
    setColumnSortRules((prev) => prev.filter((rule) => rule.key !== columnKey));
    setPage(1);
  }, [setPage]);

  const clearColumnMenuSettings = useCallback((columnKey: ColumnKey): void => {
    setColumnFilterState((prev) => {
      if (!prev[columnKey]) {
        return prev;
      }
      return omitColumnKey(prev, columnKey);
    });
    setColumnSortRules((prev) => prev.filter((rule) => rule.key !== columnKey));
    setColumnMenuSearchState((prev) => {
      if (!(columnKey in prev)) {
        return prev;
      }
      return omitSearchKey(prev, columnKey);
    });
    setPage(1);
  }, [omitColumnKey, omitSearchKey, setPage]);

  const openColumnAnalysis = useCallback((columnKey: ColumnKey, label: string): void => {
    setColumnAnalysisLabel(label);
    setColumnAnalysisState({ open: true, columnKey });
  }, []);

  const closeColumnAnalysis = useCallback((): void => {
    setColumnAnalysisState({ open: false, columnKey: null });
  }, []);

  const openColumnTextFilterDialog = useCallback((columnKey: ColumnKey, columnLabel: string): void => {
    const currentApplied = columnFilterState[columnKey]?.textQuery ?? "";
    const currentDraft = columnMenuSearchState[columnKey] ?? currentApplied;

    setColumnTextFilterDialog({
      open: true,
      columnKey,
      columnLabel,
      draftValue: currentDraft,
    });
    setColumnMenuOpenKey(null);
  }, [columnFilterState, columnMenuSearchState]);

  const handleColumnTextFilterDialogChange = useCallback((value: string): void => {
    setColumnTextFilterDialog((prev) => ({ ...prev, draftValue: value }));
  }, []);

  const closeColumnTextFilterDialog = useCallback((): void => {
    setColumnTextFilterDialog({
      open: false,
      columnKey: null,
      columnLabel: "",
      draftValue: "",
    });
  }, []);

  const submitColumnTextFilterDialog = useCallback((): void => {
    if (!columnTextFilterDialog.columnKey) {
      closeColumnTextFilterDialog();
      return;
    }
    applyColumnTextFilter(columnTextFilterDialog.columnKey, columnTextFilterDialog.draftValue);
    closeColumnTextFilterDialog();
  }, [columnTextFilterDialog, applyColumnTextFilter, closeColumnTextFilterDialog]);

  const resetColumnFilters = useCallback((): void => {
    setColumnFilterState({});
    setColumnMenuSearchState({});
    setColumnMenuOpenKey(null);
    setColumnTextFilterDialog({
      open: false,
      columnKey: null,
      columnLabel: "",
      draftValue: "",
    });
  }, []);

  return {
    columnFilterState,
    setColumnFilterState,
    columnSortRules,
    setColumnSortRules,
    columnMenuOpenKey,
    setColumnMenuOpenKey,
    columnMenuSearchState,
    setColumnMenuSearchState,
    columnAnalysisState,
    setColumnAnalysisState,
    columnAnalysisLabel,
    setColumnAnalysisLabel,
    columnTextFilterDialog,
    setColumnTextFilterDialog,
    hasActiveColumnMenuFilters,
    hasActiveColumnSortRules,
    isColumnAnalysisOpen,
    handleColumnMenuOpenChange,
    markColumnMenuInteract,
    handleColumnMenuSearchChange,
    applyColumnTextFilter,
    toggleColumnFilterToken,
    clearColumnFilter,
    applyColumnSortRule,
    clearColumnSortRule,
    clearColumnMenuSettings,
    openColumnAnalysis,
    closeColumnAnalysis,
    openColumnTextFilterDialog,
    handleColumnTextFilterDialogChange,
    closeColumnTextFilterDialog,
    submitColumnTextFilterDialog,
    resetColumnFilters,
  };
}
