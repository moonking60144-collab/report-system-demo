import { useEffect, useMemo } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ColumnSortRule,
  FixedFilterPresetId,
  GlobalFilters,
  SidebarPlaceholderView,
  WorkReportLandingPageKey,
} from "../../types";
import {
  detectActiveFixedFilterPresetId,
  detectFixedFilterPresetId,
  getDefaultSortBootstrapKey,
  getDefaultSortRulesForCurrentFilters,
} from "../../utils";

interface UseWorkReportListPresetControllerArgs {
  activeLandingPageKey: WorkReportLandingPageKey;
  activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
  currentFormId: "104" | "105";
  globalFilters: GlobalFilters;
  columnSortRules: ColumnSortRule[];
  setColumnSortRules: Dispatch<SetStateAction<ColumnSortRule[]>>;
  bootstrappedDefaultSortKeysRef: MutableRefObject<Set<string>>;
  dismissedDefaultSortBootstrapKeysRef: MutableRefObject<Set<string>>;
}

export function useWorkReportListPresetController({
  activeLandingPageKey,
  activePlaceholderViewId,
  currentFormId,
  globalFilters,
  columnSortRules,
  setColumnSortRules,
  bootstrappedDefaultSortKeysRef,
  dismissedDefaultSortBootstrapKeysRef,
}: UseWorkReportListPresetControllerArgs) {
  const activeFixedFilterPresetId = useMemo(() => {
    if (activePlaceholderViewId) {
      return null;
    }
    return detectActiveFixedFilterPresetId(
      globalFilters,
      columnSortRules,
      activeLandingPageKey,
      currentFormId
    );
  }, [
    activePlaceholderViewId,
    activeLandingPageKey,
    columnSortRules,
    currentFormId,
    globalFilters,
  ]);

  const detectedFixedFilterPresetId = useMemo<FixedFilterPresetId | null>(() => {
    if (activePlaceholderViewId) {
      return null;
    }
    return detectFixedFilterPresetId(globalFilters, currentFormId);
  }, [activePlaceholderViewId, currentFormId, globalFilters]);

  const isSidebarFixedViewActive = activeFixedFilterPresetId !== null;
  const defaultPresetSortBootstrapKey = getDefaultSortBootstrapKey(
    currentFormId,
    globalFilters,
    detectedFixedFilterPresetId
  );

  useEffect(() => {
    if (!defaultPresetSortBootstrapKey) {
      return;
    }
    if (columnSortRules.length > 0) {
      return;
    }

    const defaultSortRules = getDefaultSortRulesForCurrentFilters(
      currentFormId,
      globalFilters,
      detectedFixedFilterPresetId
    );
    if (defaultSortRules.length === 0) {
      return;
    }
    if (bootstrappedDefaultSortKeysRef.current.has(defaultPresetSortBootstrapKey)) {
      return;
    }
    if (dismissedDefaultSortBootstrapKeysRef.current.has(defaultPresetSortBootstrapKey)) {
      return;
    }

    setColumnSortRules(defaultSortRules);
    bootstrappedDefaultSortKeysRef.current.add(defaultPresetSortBootstrapKey);
  }, [
    bootstrappedDefaultSortKeysRef,
    columnSortRules.length,
    currentFormId,
    defaultPresetSortBootstrapKey,
    detectedFixedFilterPresetId,
    dismissedDefaultSortBootstrapKeysRef,
    globalFilters,
    setColumnSortRules,
  ]);

  return {
    activeFixedFilterPresetId,
    detectedFixedFilterPresetId,
    isSidebarFixedViewActive,
    defaultPresetSortBootstrapKey,
  };
}
