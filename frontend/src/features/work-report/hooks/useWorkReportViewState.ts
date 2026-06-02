import { useEffect, useState } from "react";
import { ALL_FILTER_VALUE } from "../constants";
import type { GlobalFilters, WorkReportLandingPageKey, WorkReportListViewState } from "../types";
import { getInitialGlobalFilters, hasExplicitGlobalFilterParamsInUrl } from "../utils";

interface UseWorkReportViewStateInitialState {
  page?: WorkReportListViewState["page"];
  pageSize?: WorkReportListViewState["pageSize"];
  globalFilterDraft?: WorkReportListViewState["globalFilterDraft"];
  globalFilters?: WorkReportListViewState["globalFilters"];
}

export function useWorkReportViewState(
  initialLandingPageKey: WorkReportLandingPageKey,
  initialState: UseWorkReportViewStateInitialState = {}
) {
  const hasPageParamsInUrl = (() => {
    const params = new URLSearchParams(window.location.search);
    return params.has("page") || params.has("pageSize");
  })();
  const hasExplicitFilterParamsInUrl = hasExplicitGlobalFilterParamsInUrl();

  const [pageSize, setPageSize] = useState(() => {
    if (hasPageParamsInUrl) {
      const params = new URLSearchParams(window.location.search);
      const value = Number(params.get("pageSize"));
      return Number.isFinite(value) && value > 0 ? value : 25;
    }
    const initialPageSize = Number(initialState.pageSize);
    if (Number.isFinite(initialPageSize) && initialPageSize > 0) {
      return initialPageSize;
    }
    const params = new URLSearchParams(window.location.search);
    const value = Number(params.get("pageSize"));
    return Number.isFinite(value) && value > 0 ? value : 25;
  });
  const [page, setPage] = useState(() => {
    if (hasPageParamsInUrl) {
      const params = new URLSearchParams(window.location.search);
      const value = Number(params.get("page"));
      return Number.isFinite(value) && value > 0 ? value : 1;
    }
    const initialPage = Number(initialState.page);
    if (Number.isFinite(initialPage) && initialPage > 0) {
      return initialPage;
    }
    const params = new URLSearchParams(window.location.search);
    const value = Number(params.get("page"));
    return Number.isFinite(value) && value > 0 ? value : 1;
  });
  const [globalFilterDraft, setGlobalFilterDraft] = useState<GlobalFilters>(() => {
    if (hasExplicitFilterParamsInUrl) {
      return getInitialGlobalFilters(initialLandingPageKey);
    }
    if (initialState.globalFilterDraft) {
      return { ...initialState.globalFilterDraft };
    }
    if (initialState.globalFilters) {
      return { ...initialState.globalFilters };
    }
    return getInitialGlobalFilters(initialLandingPageKey);
  });
  const [globalFilters, setGlobalFilters] = useState<GlobalFilters>(() => {
    if (hasExplicitFilterParamsInUrl) {
      return getInitialGlobalFilters(initialLandingPageKey);
    }
    if (initialState.globalFilters) {
      return { ...initialState.globalFilters };
    }
    if (initialState.globalFilterDraft) {
      return { ...initialState.globalFilterDraft };
    }
    return getInitialGlobalFilters(initialLandingPageKey);
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("q");

    if (globalFilters.globalKeyword.trim()) {
      params.set("fGlobal", globalFilters.globalKeyword.trim());
    } else {
      params.delete("fGlobal");
    }

    if (globalFilters.workOrderKeyword.trim()) {
      params.set("fWorkOrder", globalFilters.workOrderKeyword.trim());
    } else {
      params.delete("fWorkOrder");
    }

    if (globalFilters.customerPartKeyword.trim()) {
      params.set("fPart", globalFilters.customerPartKeyword.trim());
    } else {
      params.delete("fPart");
    }

    if (globalFilters.machineCode !== ALL_FILTER_VALUE) {
      params.set("fMachine", globalFilters.machineCode);
    } else {
      params.delete("fMachine");
    }

    if (globalFilters.filterMachineCode !== ALL_FILTER_VALUE) {
      params.set("fFilterMachine", globalFilters.filterMachineCode);
    } else {
      params.delete("fFilterMachine");
    }

    if (globalFilters.status !== ALL_FILTER_VALUE) {
      params.set("fStatus", globalFilters.status);
    } else {
      params.delete("fStatus");
    }

    if (globalFilters.siteRunning !== "all") {
      params.set("fSite", globalFilters.siteRunning);
    } else {
      params.delete("fSite");
    }

    if (globalFilters.startSchedule !== "all") {
      params.set("fStartSchedule", globalFilters.startSchedule);
    } else {
      params.delete("fStartSchedule");
    }

    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`;
    window.history.replaceState(null, "", nextUrl);
  }, [globalFilters, page, pageSize]);

  return {
    pageSize,
    setPageSize,
    page,
    setPage,
    globalFilterDraft,
    setGlobalFilterDraft,
    globalFilters,
    setGlobalFilters,
  };
}
