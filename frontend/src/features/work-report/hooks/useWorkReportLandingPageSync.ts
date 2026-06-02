import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ColumnSortRule,
  GlobalFilters,
  SidebarPlaceholderView,
  WorkReportFormId,
  WorkReportLandingPageKey,
} from "../types";
import { cloneGlobalFilters } from "../utils";

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
          activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
        }
      >
    >
  >;
  globalFilterDraft: GlobalFilters;
  globalFilters: GlobalFilters;
  columnSortRules: ColumnSortRule[];
  activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
  getDefaultFiltersForLandingPage: (landingPageKey: WorkReportLandingPageKey) => GlobalFilters;
  getDefaultSortRulesForLandingPage: (
    landingPageKey: WorkReportLandingPageKey,
    filters: GlobalFilters
  ) => ColumnSortRule[];
  getFormIdForLandingPage: (landingPageKey: WorkReportLandingPageKey) => WorkReportFormId;
  setGlobalFilterDraft: Dispatch<SetStateAction<GlobalFilters>>;
  setGlobalFilters: Dispatch<SetStateAction<GlobalFilters>>;
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
}: UseWorkReportLandingPageSyncArgs): void {
  useEffect(() => {
    // NOTE: 切換 landing page 的當次 render，先不要覆蓋目標分頁的 scopedFilters；
    // 否則會把舊分頁的 filter 狀態寫進新分頁，造成首次切入預設失效。
    if (previousLandingPageKeyRef.current !== activeLandingPageKey) {
      return;
    }

    pageScopedFiltersRef.current[activeLandingPageKey] = {
      draft: cloneGlobalFilters(globalFilterDraft),
      applied: cloneGlobalFilters(globalFilters),
      columnSortRules: columnSortRules.map((rule) => ({ ...rule })),
      activePlaceholderViewId,
    };
  }, [
    activeLandingPageKey,
    activePlaceholderViewId,
    columnSortRules,
    globalFilterDraft,
    globalFilters,
    pageScopedFiltersRef,
    previousLandingPageKeyRef,
  ]);

  useEffect(() => {
    const previousLandingPageKey = previousLandingPageKeyRef.current;
    if (previousLandingPageKey === activeLandingPageKey) {
      return;
    }

    previousLandingPageKeyRef.current = activeLandingPageKey;
    const scopedFilters = pageScopedFiltersRef.current[activeLandingPageKey];
    const nextFilters = scopedFilters
      ? {
          draft: cloneGlobalFilters(scopedFilters.draft),
          applied: cloneGlobalFilters(scopedFilters.applied),
          columnSortRules: scopedFilters.columnSortRules.map((rule) => ({ ...rule })),
          activePlaceholderViewId: scopedFilters.activePlaceholderViewId,
        }
      : (() => {
          const initial = getDefaultFiltersForLandingPage(activeLandingPageKey);
          return {
            draft: cloneGlobalFilters(initial),
            applied: cloneGlobalFilters(initial),
            columnSortRules: getDefaultSortRulesForLandingPage(activeLandingPageKey, initial),
            activePlaceholderViewId: null,
          };
        })();

    resetListDataState(getFormIdForLandingPage(activeLandingPageKey));
    resetColumnFilters();
    setGlobalFilterDraft(nextFilters.draft);
    setGlobalFilters(nextFilters.applied);
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
    setPage,
  ]);
}
