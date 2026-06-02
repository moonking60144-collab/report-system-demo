import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { NoticeState, SidebarPlaceholderView } from "../../types";
import { consumeServerBootRedirectFlash } from "../../utils";
import { parseQuickViewIdFromSearch } from "./useWorkReportListViewController";

interface UseWorkReportListEffectsControllerArgs {
  highlightedEntryId: string | null;
  setHighlightedEntryId: Dispatch<SetStateAction<string | null>>;
  notice: NoticeState | null;
  setNotice: Dispatch<SetStateAction<NoticeState | null>>;
  t: (key: string, options?: Record<string, unknown>) => string;
  applySidebarPlaceholderView: (
    viewId: SidebarPlaceholderView["id"],
    options?: { showNotice?: boolean; syncQuery?: boolean }
  ) => Promise<void>;
  initialQuickViewRestored: boolean;
}

export function useWorkReportListEffectsController({
  highlightedEntryId,
  setHighlightedEntryId,
  notice,
  setNotice,
  t,
  applySidebarPlaceholderView,
  initialQuickViewRestored,
}: UseWorkReportListEffectsControllerArgs) {
  const highlightedEntryTimerRef = useRef<number | null>(null);
  const hasRestoredQuickViewRef = useRef(initialQuickViewRestored);

  useEffect(() => {
    if (!highlightedEntryId) {
      return;
    }

    if (highlightedEntryTimerRef.current !== null) {
      window.clearTimeout(highlightedEntryTimerRef.current);
      highlightedEntryTimerRef.current = null;
    }

    highlightedEntryTimerRef.current = window.setTimeout(() => {
      setHighlightedEntryId(null);
      highlightedEntryTimerRef.current = null;
    }, 1800);

    return () => {
      if (highlightedEntryTimerRef.current !== null) {
        window.clearTimeout(highlightedEntryTimerRef.current);
        highlightedEntryTimerRef.current = null;
      }
    };
  }, [highlightedEntryId, setHighlightedEntryId]);

  useEffect(() => {
    if (!notice || notice.sticky) {
      return;
    }

    const dismissDelayMs =
      notice.displayAsHumanStatus || notice.type === "warn" || notice.type === "error"
        ? 6000
        : 3500;

    const timer = window.setTimeout(() => {
      setNotice(null);
    }, dismissDelayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [notice, setNotice]);

  useEffect(() => {
    const flash = consumeServerBootRedirectFlash();
    if (!flash) {
      return;
    }
    window.queueMicrotask(() => {
      setNotice({
        type: "warn",
        message: t(flash.messageKey),
        sticky: true,
        displayAsHumanStatus: true,
      });
    });
  }, [setNotice, t]);

  useEffect(() => {
    if (hasRestoredQuickViewRef.current) {
      return;
    }
    hasRestoredQuickViewRef.current = true;

    const quickViewId = parseQuickViewIdFromSearch(window.location.search);
    if (!quickViewId) {
      return;
    }

    window.queueMicrotask(() => {
      void applySidebarPlaceholderView(quickViewId, {
        showNotice: false,
        syncQuery: false,
      });
    });
  }, [applySidebarPlaceholderView]);
}
