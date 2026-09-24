import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { WorkReportRecord } from "../../../api/workReport";
import type {
  ColumnFilterState,
  ColumnSortRule,
  GlobalFilters,
  SidebarPlaceholderView,
  WorkReportFormId,
  WorkReportListAnchor,
  WorkReportListLocationState,
  WorkReportListViewState,
  WorkReportTopView,
  WorkReportFilterGroup,
} from "../types";
import {
  normalizeListSearch,
  serializeColumnSortRulesToSearchParam,
  writeGlobalFiltersToSearchParams,
} from "../utils";

const QUICK_VIEW_QUERY_KEY = "fQuick";
const LANDING_PAGE_QUERY_KEY = "landingPage";
const TOP_VIEW_QUERY_KEY = "topView";

interface UseWorkReportListNavigationArgs {
  currentFormId: WorkReportFormId;
  activeLandingPageKey: WorkReportListViewState["landingPageKey"];
  activeTopView: WorkReportTopView;
  activePlaceholderViewId: SidebarPlaceholderView["id"] | null;
  globalFilterDraft: GlobalFilters;
  globalFilters: GlobalFilters;
  customFilterDraft: WorkReportFilterGroup;
  customFilters: WorkReportFilterGroup;
  page: number;
  pageSize: number;
  columnFilterState: ColumnFilterState;
  columnSortRules: ColumnSortRule[];
  loading: boolean;
  visibleRecords: WorkReportRecord[];
  setHighlightedEntryId: Dispatch<SetStateAction<string | null>>;
}

function getSearchSignature(search: string): string {
  const params = new URLSearchParams(normalizeListSearch(search));
  const entries = Array.from(params.entries()).sort(([keyA, valueA], [keyB, valueB]) => {
    if (keyA === keyB) {
      return valueA.localeCompare(valueB);
    }
    return keyA.localeCompare(keyB);
  });
  return entries.map(([key, value]) => `${key}=${value}`).join("&");
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function useWorkReportListNavigation({
  currentFormId,
  activeLandingPageKey,
  activeTopView,
  activePlaceholderViewId,
  globalFilterDraft,
  globalFilters,
  customFilterDraft,
  customFilters,
  page,
  pageSize,
  columnFilterState,
  columnSortRules,
  loading,
  visibleRecords,
  setHighlightedEntryId,
}: UseWorkReportListNavigationArgs) {
  const navigate = useNavigate();
  const location = useLocation();
  const restoreScrollTimerRef = useRef<number | null>(null);
  const openDetailLockUntilRef = useRef(0);

  const buildListSearch = useCallback((): string => {
    const params = new URLSearchParams(normalizeListSearch(location.search));
    params.delete("q");
    if (activeLandingPageKey) {
      params.set(LANDING_PAGE_QUERY_KEY, activeLandingPageKey);
    } else {
      params.delete(LANDING_PAGE_QUERY_KEY);
    }
    params.set(TOP_VIEW_QUERY_KEY, activeTopView);
    writeGlobalFiltersToSearchParams(params, globalFilters);
    if (activePlaceholderViewId) {
      params.set(QUICK_VIEW_QUERY_KEY, activePlaceholderViewId);
    } else {
      params.delete(QUICK_VIEW_QUERY_KEY);
    }
    const serializedSortRules = serializeColumnSortRulesToSearchParam(columnSortRules);
    if (serializedSortRules) {
      params.set("fSort", serializedSortRules);
    } else {
      params.delete("fSort");
    }

    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    const search = params.toString();
    return search ? `?${search}` : "";
  }, [
    activeLandingPageKey,
    activePlaceholderViewId,
    activeTopView,
    columnSortRules,
    globalFilters,
    location.search,
    page,
    pageSize,
  ]);

  const handleOpenDetail = useCallback(
    (entryId: string): void => {
      const now = Date.now();
      if (now < openDetailLockUntilRef.current) {
        return;
      }
      openDetailLockUntilRef.current = now + 450;

      const listSearch = normalizeListSearch(buildListSearch());
      const outerScrollY = document.querySelector<HTMLElement>(".ragic-list-main")?.scrollTop ?? window.scrollY;
      const listAnchor: WorkReportListAnchor = {
        entryId,
        scrollY: outerScrollY,
        outerScrollY,
        at: now,
      };
      const listViewState: WorkReportListViewState = {
        landingPageKey: activeLandingPageKey,
        activePlaceholderViewId,
        globalFilterDraft,
        globalFilters,
        page,
        pageSize,
        columnFilterState,
        columnSortRules,
        customFilterDraft,
        customFilters,
      };
      const nextState: WorkReportListLocationState = { listSearch, listAnchor, listViewState };
      navigate(`/reports/${currentFormId}/${entryId}${listSearch}`, {
        state: nextState,
      });
    },
    [
      activeLandingPageKey,
      activePlaceholderViewId,
      buildListSearch,
      columnFilterState,
      columnSortRules,
      customFilterDraft,
      customFilters,
      currentFormId,
      globalFilterDraft,
      globalFilters,
      navigate,
      page,
      pageSize,
    ]
  );

  useEffect(() => {
    if (loading) {
      return;
    }
    if (visibleRecords.length === 0) {
      return;
    }

    const locationState = (location.state as WorkReportListLocationState | null) ?? null;
    const stateSearch = normalizeListSearch(locationState?.listSearch);
    const currentSearch = normalizeListSearch(location.search);
    const anchorPayload = locationState?.listAnchor
      ? {
          listSearch: stateSearch || currentSearch,
          listAnchor: locationState.listAnchor,
        }
      : null;

    if (!anchorPayload?.listAnchor) {
      return;
    }

    const payloadSearchNormalized = normalizeListSearch(anchorPayload.listSearch);
    const currentSearchSignature = getSearchSignature(currentSearch);
    const payloadSearchSignature = getSearchSignature(payloadSearchNormalized);
    if (payloadSearchNormalized && payloadSearchSignature !== currentSearchSignature) {
      return;
    }

    const cleanupAnchor = () => {
      if (targetEntryId) {
        setHighlightedEntryId(targetEntryId);
      }
      if (locationState?.listAnchor) {
        const nextState: WorkReportListLocationState | undefined = stateSearch
          ? { listSearch: stateSearch, listViewState: locationState.listViewState }
          : locationState.listViewState
            ? { listViewState: locationState.listViewState }
            : undefined;
        navigate(`${location.pathname}${location.search}`, {
          replace: true,
          state: nextState,
        });
      }
    };

    const safeOuterScrollY = Math.max(0, anchorPayload.listAnchor.outerScrollY ?? anchorPayload.listAnchor.scrollY);
    const targetEntryId = String(anchorPayload.listAnchor.entryId ?? "").trim();
    const tryRestoreToAnchorRow = (remainingRetry: number): void => {
      const outerScroller = document.querySelector<HTMLElement>(".ragic-list-main");
      if (outerScroller) outerScroller.scrollTop = safeOuterScrollY;
      else window.scrollTo({ top: safeOuterScrollY, behavior: "auto" });
      if (targetEntryId) {
        const escapedEntryId = escapeAttributeValue(targetEntryId);
        const row = document.querySelector<HTMLElement>(
          `.ragic-table [data-row-key="${escapedEntryId}"]`
        );
        if (row) {
          if (outerScroller) {
            const toolbarHeight = document.querySelector<HTMLElement>(".work-report-workspace-toolbar")?.offsetHeight ?? 0;
            const headerHeight = document.querySelector<HTMLElement>(".ragic-table .ant-table-thead")?.offsetHeight ?? 0;
            const visibleTop = outerScroller.getBoundingClientRect().top + toolbarHeight + headerHeight;
            const visibleBottom = outerScroller.getBoundingClientRect().bottom - 14;
            const rowRect = row.getBoundingClientRect();
            if (rowRect.top < visibleTop || rowRect.bottom > visibleBottom) {
              outerScroller.scrollTop += rowRect.top - visibleTop - 12;
            }
          } else {
            row.scrollIntoView({ block: "nearest" });
          }
          cleanupAnchor();
          return;
        }
      }

      if (remainingRetry <= 0) {
        cleanupAnchor();
        return;
      }

      restoreScrollTimerRef.current = window.setTimeout(() => {
        tryRestoreToAnchorRow(remainingRetry - 1);
      }, 100);
    };

    if (restoreScrollTimerRef.current !== null) {
      window.clearTimeout(restoreScrollTimerRef.current);
      restoreScrollTimerRef.current = null;
    }
    window.requestAnimationFrame(() => {
      tryRestoreToAnchorRow(24);
    });
    return () => {
      if (restoreScrollTimerRef.current !== null) {
        window.clearTimeout(restoreScrollTimerRef.current);
        restoreScrollTimerRef.current = null;
      }
    };
  }, [
    loading,
    location.pathname,
    location.search,
    location.state,
    navigate,
    setHighlightedEntryId,
    visibleRecords,
  ]);

  return {
    handleOpenDetail,
  };
}
