import { useCallback, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  FIXED_FILTER_PRESET_IDS_BY_FORM,
  WORK_REPORT_LANDING_PAGE_CONFIGS,
} from "../../constants";
import type {
  ColumnSortRule,
  GlobalFilters,
  SidebarPlaceholderView,
  WorkReportLandingPageKey,
  WorkReportLocalPreferences,
} from "../../types";
import {
  detectFixedFilterPresetId,
  getDefaultSortRulesForCurrentFilters,
  getFixedFilterPresetFilters,
} from "../../utils";
import { useWorkReportLandingPageSync } from "../useWorkReportLandingPageSync";

interface UseWorkReportListLandingControllerArgs {
  activeLandingPageKey: WorkReportLandingPageKey;
  activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
  localPreferences: WorkReportLocalPreferences;
  globalFilterDraft: GlobalFilters;
  globalFilters: GlobalFilters;
  columnSortRules: ColumnSortRule[];
  setGlobalFilterDraft: Dispatch<SetStateAction<GlobalFilters>>;
  setGlobalFilters: Dispatch<SetStateAction<GlobalFilters>>;
  setPage: Dispatch<SetStateAction<number>>;
  resetListDataState: (nextFormId?: "104" | "105") => void;
  resetColumnFilters: () => void;
  setColumnSortRules: Dispatch<SetStateAction<ColumnSortRule[]>>;
  setActivePlaceholderViewId: Dispatch<SetStateAction<SidebarPlaceholderView["id"] | null>>;
}

export function useWorkReportListLandingController({
  activeLandingPageKey,
  activePlaceholderViewId,
  localPreferences,
  globalFilterDraft,
  globalFilters,
  columnSortRules,
  setGlobalFilterDraft,
  setGlobalFilters,
  setPage,
  resetListDataState,
  resetColumnFilters,
  setColumnSortRules,
  setActivePlaceholderViewId,
}: UseWorkReportListLandingControllerArgs) {
  const pageScopedFiltersRef = useRef<
    Partial<
      Record<
        WorkReportLandingPageKey,
        {
          draft: GlobalFilters;
          applied: GlobalFilters;
          columnSortRules: ColumnSortRule[];
          activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
        }
      >
    >
  >({});
  const previousLandingPageKeyRef = useRef<WorkReportLandingPageKey>(activeLandingPageKey);

  const getDefaultFiltersForLandingPage = useCallback(
    (landingPageKey: WorkReportLandingPageKey): GlobalFilters => {
      const landingPageConfig = WORK_REPORT_LANDING_PAGE_CONFIGS[landingPageKey];
      const preferredPresetId =
        localPreferences[landingPageConfig.defaultFixedPresetPreferenceKey] ??
        landingPageConfig.fallbackFixedPresetId;
      const allowedPresetIds = FIXED_FILTER_PRESET_IDS_BY_FORM[landingPageConfig.formId];
      const safePresetId = allowedPresetIds.includes(preferredPresetId)
        ? preferredPresetId
        : landingPageConfig.fallbackFixedPresetId;
      return getFixedFilterPresetFilters(safePresetId, landingPageConfig.formId);
    },
    [localPreferences]
  );

  const getDefaultSortRulesForLandingPage = useCallback(
    (landingPageKey: WorkReportLandingPageKey, filters: GlobalFilters): ColumnSortRule[] => {
      const landingPageConfig = WORK_REPORT_LANDING_PAGE_CONFIGS[landingPageKey];
      const presetId = detectFixedFilterPresetId(filters, landingPageConfig.formId);
      return getDefaultSortRulesForCurrentFilters(landingPageConfig.formId, filters, presetId);
    },
    []
  );

  const getFormIdForLandingPage = useCallback(
    (landingPageKey: WorkReportLandingPageKey) =>
      WORK_REPORT_LANDING_PAGE_CONFIGS[landingPageKey].formId,
    []
  );

  useWorkReportLandingPageSync({
    activeLandingPageKey,
    previousLandingPageKeyRef,
    pageScopedFiltersRef,
    globalFilterDraft,
    globalFilters,
    columnSortRules,
    activePlaceholderViewId,
    getDefaultFiltersForLandingPage,
    getDefaultSortRulesForLandingPage,
    getFormIdForLandingPage,
    setGlobalFilterDraft,
    setGlobalFilters,
    setPage,
    resetListDataState,
    resetColumnFilters,
    setColumnSortRules,
    setActivePlaceholderViewId,
  });

  return {
    pageScopedFiltersRef:
      pageScopedFiltersRef as MutableRefObject<
        Partial<
          Record<
            WorkReportLandingPageKey,
            {
              draft: GlobalFilters;
              applied: GlobalFilters;
              columnSortRules: ColumnSortRule[];
              activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
            }
          >
        >
      >,
  };
}
