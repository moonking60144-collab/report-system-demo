import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ColumnSortRule,
  GlobalFilters,
  SidebarPlaceholderView,
  WorkReportFormId,
  WorkReportLandingPageKey,
  WorkReportFilterGroup,
} from "../types";
import {
  cloneGlobalFilters,
  cloneWorkReportFilterGroup,
  EMPTY_WORK_REPORT_FILTER_GROUP,
  normalizeColumnSortRulesForForm,
  normalizeGlobalFiltersForForm,
} from "../utils";

interface UseWorkReportLandingPageSyncArgs {
  activeLandingPageKey: WorkReportLandingPageKey;
  previousLandingPageKeyRef: MutableRefObject<WorkReportLandingPageKey>;
  pageScopedFiltersRef: MutableRefObject<
    Partial<
      Record<
        WorkReportLandingPageKey,
        {
          draft: GlobalFilters;
          applied: GlobalFilters;
          columnSortRules: ColumnSortRule[];
          customFilterDraft: WorkReportFilterGroup;
          customFilters: WorkReportFilterGroup;
          activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
        }
      >
    >
  >;
  globalFilterDraft: GlobalFilters;
  globalFilters: GlobalFilters;
  columnSortRules: ColumnSortRule[];
  customFilterDraft: WorkReportFilterGroup;
  customFilters: WorkReportFilterGroup;
  activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
  getDefaultFiltersForLandingPage: (landingPageKey: WorkReportLandingPageKey) => GlobalFilters;
  getDefaultSortRulesForLandingPage: (
    landingPageKey: WorkReportLandingPageKey,
    filters: GlobalFilters
  ) => ColumnSortRule[];
  getFormIdForLandingPage: (landingPageKey: WorkReportLandingPageKey) => WorkReportFormId;
  setGlobalFilterDraft: Dispatch<SetStateAction<GlobalFilters>>;
  setGlobalFilters: Dispatch<SetStateAction<GlobalFilters>>;
  setCustomFilterDraft: Dispatch<SetStateAction<WorkReportFilterGroup>>;
  setCustomFilters: Dispatch<SetStateAction<WorkReportFilterGroup>>;
  setPage: Dispatch<SetStateAction<number>>;
  resetListDataState: (nextFormId?: WorkReportFormId) => void;
  resetColumnFilters: () => void;
  setColumnSortRules: Dispatch<SetStateAction<ColumnSortRule[]>>;
  setActivePlaceholderViewId: Dispatch<SetStateAction<SidebarPlaceholderView["id"] | null>>;
}

export function useWorkReportLandingPageSync({
  activeLandingPageKey,
  previousLandingPageKeyRef,
  pageScopedFiltersRef,
  globalFilterDraft,
  globalFilters,
  columnSortRules,
  customFilterDraft,
  customFilters,
  activePlaceholderViewId,
  getDefaultFiltersForLandingPage,
  getDefaultSortRulesForLandingPage,
  getFormIdForLandingPage,
  setGlobalFilterDraft,
  setGlobalFilters,
  setCustomFilterDraft,
  setCustomFilters,
  setPage,
  resetListDataState,
  resetColumnFilters,
  setColumnSortRules,
  setActivePlaceholderViewId,
}: UseWorkReportLandingPageSyncArgs): void {
  useEffect(() => {
    // NOTE: 切換 landing page 的當次 render，先不要覆蓋目標分頁的 scopedFilters；
    // 否則會把舊分頁的 filter 狀態寫進新分頁，造成首次切入預設失效。
    if (previousLandingPageKeyRef.current !== activeLandingPageKey) {
      return;
    }

    const currentFormId = getFormIdForLandingPage(activeLandingPageKey);
    pageScopedFiltersRef.current[activeLandingPageKey] = {
      draft: normalizeGlobalFiltersForForm(globalFilterDraft, currentFormId),
      applied: normalizeGlobalFiltersForForm(globalFilters, currentFormId),
      columnSortRules: normalizeColumnSortRulesForForm(columnSortRules, currentFormId),
      customFilterDraft: cloneWorkReportFilterGroup(customFilterDraft),
      customFilters: cloneWorkReportFilterGroup(customFilters),
      activePlaceholderViewId,
    };
  }, [
    activeLandingPageKey,
    activePlaceholderViewId,
    columnSortRules,
    customFilterDraft,
    customFilters,
    globalFilterDraft,
    globalFilters,
    getFormIdForLandingPage,
    pageScopedFiltersRef,
    previousLandingPageKeyRef,
  ]);

  useEffect(() => {
    const previousLandingPageKey = previousLandingPageKeyRef.current;
    if (previousLandingPageKey === activeLandingPageKey) {
      return;
    }

    previousLandingPageKeyRef.current = activeLandingPageKey;
    const nextFormId = getFormIdForLandingPage(activeLandingPageKey);
    const scopedFilters = pageScopedFiltersRef.current[activeLandingPageKey];
    const nextFilters = scopedFilters
      ? {
          draft: normalizeGlobalFiltersForForm(scopedFilters.draft, nextFormId),
          applied: normalizeGlobalFiltersForForm(scopedFilters.applied, nextFormId),
          columnSortRules: normalizeColumnSortRulesForForm(
            scopedFilters.columnSortRules,
            nextFormId
          ),
          customFilterDraft: cloneWorkReportFilterGroup(scopedFilters.customFilterDraft),
          customFilters: cloneWorkReportFilterGroup(scopedFilters.customFilters),
          activePlaceholderViewId: scopedFilters.activePlaceholderViewId,
        }
      : (() => {
          const initial = getDefaultFiltersForLandingPage(activeLandingPageKey);
          return {
            draft: cloneGlobalFilters(initial),
            applied: cloneGlobalFilters(initial),
            columnSortRules: getDefaultSortRulesForLandingPage(activeLandingPageKey, initial),
            customFilterDraft: EMPTY_WORK_REPORT_FILTER_GROUP,
            customFilters: EMPTY_WORK_REPORT_FILTER_GROUP,
            activePlaceholderViewId: null,
          };
        })();

    resetListDataState(nextFormId);
    resetColumnFilters();
    setGlobalFilterDraft(nextFilters.draft);
    setGlobalFilters(nextFilters.applied);
    setCustomFilterDraft(nextFilters.customFilterDraft);
    setCustomFilters(nextFilters.customFilters);
    setColumnSortRules(nextFilters.columnSortRules);
    setActivePlaceholderViewId(nextFilters.activePlaceholderViewId);
    setPage(1);
  }, [
    activeLandingPageKey,
    getDefaultFiltersForLandingPage,
    getFormIdForLandingPage,
    getDefaultSortRulesForLandingPage,
    pageScopedFiltersRef,
    previousLandingPageKeyRef,
    resetColumnFilters,
    resetListDataState,
    setActivePlaceholderViewId,
    setColumnSortRules,
    setGlobalFilterDraft,
    setGlobalFilters,
    setCustomFilterDraft,
    setCustomFilters,
    setPage,
  ]);
}
