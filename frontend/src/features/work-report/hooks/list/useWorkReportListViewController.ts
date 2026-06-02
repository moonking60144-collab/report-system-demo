import { useCallback, useEffect, useState } from "react";
import type { SidebarPlaceholderView, WorkReportLandingPageKey, WorkReportListLocationState, WorkReportLocalPreferences, WorkReportTopView } from "../../types";

const LANDING_PAGE_QUERY_KEY = "landingPage";
const TOP_VIEW_QUERY_KEY = "topView";
const QUICK_VIEW_QUERY_KEY = "fQuick";

function parseLandingPageKeyFromSearch(search: string): WorkReportLandingPageKey | null {
  const raw = new URLSearchParams(search).get(LANDING_PAGE_QUERY_KEY);
  if (raw === "thread-rolling-104" || raw === "heading-105") {
    return raw;
  }
  return null;
}

function parseTopViewFromSearch(search: string): WorkReportTopView | null {
  const raw = new URLSearchParams(search).get(TOP_VIEW_QUERY_KEY);
  if (raw === "report" || raw === "local-settings" || raw === "technical-info") {
    return raw;
  }
  return null;
}

function parseQuickViewIdFromSearch(search: string): SidebarPlaceholderView["id"] | null {
  const raw = new URLSearchParams(search).get(QUICK_VIEW_QUERY_KEY);
  if (raw === "starred" || raw === "last-updated") {
    return raw;
  }
  return null;
}

export function useWorkReportListViewController({
  locationSearch,
  initialListViewState,
  localPreferences,
}: {
  locationSearch: string;
  initialListViewState?: WorkReportListLocationState["listViewState"];
  localPreferences: WorkReportLocalPreferences;
}) {
  const landingPageKeyFromSearch = parseLandingPageKeyFromSearch(locationSearch);
  const topViewFromSearch = parseTopViewFromSearch(locationSearch);
  const [fixedFilterSidebarCollapsed, setFixedFilterSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia("(max-width: 768px)").matches;
  });
  const [activeTopView, setActiveTopView] = useState<WorkReportTopView>(
    topViewFromSearch ?? "report"
  );
  const [activeLandingPageKey, setActiveLandingPageKey] = useState<WorkReportLandingPageKey>(
    landingPageKeyFromSearch ??
      initialListViewState?.landingPageKey ??
      localPreferences.defaultLandingPageKey
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQuery = window.matchMedia("(max-width: 768px)");
    const applyMatch = (matches: boolean) => {
      setIsMobileViewport(matches);
      if (!matches) {
        setMobileSidebarOpen(false);
      }
    };
    applyMatch(mediaQuery.matches);
    const handler = (event: MediaQueryListEvent) => applyMatch(event.matches);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

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

  return {
    fixedFilterSidebarCollapsed,
    setFixedFilterSidebarCollapsed,
    mobileSidebarOpen,
    setMobileSidebarOpen,
    isMobileViewport,
    activeTopView,
    setActiveTopView,
    activeLandingPageKey,
    setActiveLandingPageKey,
    syncQuickViewQuery,
  };
}

export { parseLandingPageKeyFromSearch, parseTopViewFromSearch, parseQuickViewIdFromSearch };
