import { useCallback, useEffect } from "react";
import type { ColumnSortRule, SidebarPlaceholderView, WorkReportLandingPageKey, WorkReportTopView } from "../../types";
import { serializeColumnSortRulesToSearchParam } from "../../utils";

const LANDING_PAGE_QUERY_KEY = "landingPage";
const TOP_VIEW_QUERY_KEY = "topView";
const QUICK_VIEW_QUERY_KEY = "fQuick";

export function useWorkReportListUrlSync({
  activeLandingPageKey,
  activeTopView,
  columnSortRules,
}: {
  activeLandingPageKey: WorkReportLandingPageKey;
  activeTopView: WorkReportTopView;
  columnSortRules: ColumnSortRule[];
}) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set(LANDING_PAGE_QUERY_KEY, activeLandingPageKey);
    params.set(TOP_VIEW_QUERY_KEY, activeTopView);
    const serializedSortRules = serializeColumnSortRulesToSearchParam(columnSortRules);
    if (serializedSortRules) {
      params.set("fSort", serializedSortRules);
    } else {
      params.delete("fSort");
    }
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [activeLandingPageKey, activeTopView, columnSortRules]);

  const syncQuickViewQuery = useCallback((viewId: SidebarPlaceholderView["id"] | null): void => {
    const params = new URLSearchParams(window.location.search);
    if (viewId) {
      params.set(QUICK_VIEW_QUERY_KEY, viewId);
    } else {
      params.delete(QUICK_VIEW_QUERY_KEY);
    }

    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);

  return { syncQuickViewQuery };
}
