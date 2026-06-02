import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

interface FixedHorizontalScrollbarProps {
  tableWrapRef: RefObject<HTMLDivElement | null>;
  enabled?: boolean;
}

type SyncSource = "bar" | "table" | null;

interface ScrollbarMetrics {
  left: number;
  width: number;
  contentWidth: number;
  visible: boolean;
}

const CANDIDATE_SCROLL_SELECTORS = [
  ".ragic-table .ant-table-body",
  ".ragic-table .ant-table-content",
  ".ragic-table .ant-table-container",
] as const;

const INITIAL_METRICS: ScrollbarMetrics = {
  left: 0,
  width: 0,
  contentWidth: 0,
  visible: false,
};

function isHorizontallyScrollable(element: HTMLElement) {
  if (element.scrollWidth <= element.clientWidth + 1) {
    return false;
  }
  const computed = window.getComputedStyle(element);
  return computed.overflowX === "auto" || computed.overflowX === "scroll";
}

function findHorizontalScroller(root: HTMLElement): HTMLElement | null {
  for (const selector of CANDIDATE_SCROLL_SELECTORS) {
    const candidate = root.querySelector<HTMLElement>(selector);
    if (!candidate) {
      continue;
    }
    if (isHorizontallyScrollable(candidate)) {
      return candidate;
    }
  }

  if (isHorizontallyScrollable(root)) {
    return root;
  }

  return null;
}

export function FixedHorizontalScrollbar({ tableWrapRef, enabled = true }: FixedHorizontalScrollbarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const syncSourceRef = useRef<SyncSource>(null);
  const tableScrollerRef = useRef<HTMLElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedTableScrollerRef = useRef<HTMLElement | null>(null);
  const mutationObserverRef = useRef<MutationObserver | null>(null);
  const refreshFrameRef = useRef<number | null>(null);

  const [metrics, setMetrics] = useState<ScrollbarMetrics>(INITIAL_METRICS);
  const [pageHidden, setPageHidden] = useState(
    typeof document !== "undefined" ? document.hidden : false
  );
  const [inViewport, setInViewport] = useState(true);
  const active = enabled && !pageHidden && inViewport;

  const releaseSyncLock = useCallback(() => {
    window.requestAnimationFrame(() => {
      syncSourceRef.current = null;
    });
  }, []);

  const handleTableScroll = useCallback(() => {
    const tableScroller = tableScrollerRef.current;
    const bar = barRef.current;
    if (!tableScroller || !bar) {
      return;
    }
    if (syncSourceRef.current === "bar") {
      return;
    }
    syncSourceRef.current = "table";
    if (bar.scrollLeft !== tableScroller.scrollLeft) {
      bar.scrollLeft = tableScroller.scrollLeft;
    }
    releaseSyncLock();
  }, [releaseSyncLock]);

  const handleBarScroll = useCallback(() => {
    const tableScroller = tableScrollerRef.current;
    const bar = barRef.current;
    if (!tableScroller || !bar) {
      return;
    }
    if (syncSourceRef.current === "table") {
      return;
    }
    syncSourceRef.current = "bar";
    if (tableScroller.scrollLeft !== bar.scrollLeft) {
      tableScroller.scrollLeft = bar.scrollLeft;
    }
    releaseSyncLock();
  }, [releaseSyncLock]);

  const bindTableScroller = useCallback(
    (nextScroller: HTMLElement | null) => {
      if (tableScrollerRef.current === nextScroller) {
        return;
      }

      if (tableScrollerRef.current) {
        tableScrollerRef.current.removeEventListener("scroll", handleTableScroll);
      }

      tableScrollerRef.current = nextScroller;

      if (nextScroller) {
        nextScroller.addEventListener("scroll", handleTableScroll, { passive: true });
      }

      const observer = resizeObserverRef.current;
      if (observer) {
        if (observedTableScrollerRef.current) {
          observer.unobserve(observedTableScrollerRef.current);
          observedTableScrollerRef.current = null;
        }
        if (nextScroller) {
          observer.observe(nextScroller);
          observedTableScrollerRef.current = nextScroller;
        }
      }
    },
    [handleTableScroll],
  );

  const refreshMetrics = useCallback(() => {
    if (!active) {
      bindTableScroller(null);
      setMetrics((prev) => (prev.visible ? INITIAL_METRICS : prev));
      return;
    }

    const root = tableWrapRef.current;
    if (!root) {
      bindTableScroller(null);
      setMetrics((prev) => (prev.visible ? INITIAL_METRICS : prev));
      return;
    }

    const tableScroller = findHorizontalScroller(root);
    bindTableScroller(tableScroller);

    if (!tableScroller) {
      setMetrics((prev) => (prev.visible ? INITIAL_METRICS : prev));
      return;
    }

    const rect = root.getBoundingClientRect();
    const viewportLeft = Math.max(rect.left, 0);
    const viewportRight = Math.min(rect.right, window.innerWidth);
    const viewportWidth = Math.max(0, viewportRight - viewportLeft);
    const isVisible =
      viewportWidth > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      tableScroller.scrollWidth > tableScroller.clientWidth + 1;

    const nextMetrics: ScrollbarMetrics = {
      left: viewportLeft,
      width: viewportWidth,
      contentWidth: tableScroller.scrollWidth,
      visible: isVisible,
    };

    setMetrics((prev) => {
      if (
        prev.left === nextMetrics.left &&
        prev.width === nextMetrics.width &&
        prev.contentWidth === nextMetrics.contentWidth &&
        prev.visible === nextMetrics.visible
      ) {
        return prev;
      }
      return nextMetrics;
    });

    const bar = barRef.current;
    if (bar && bar.scrollLeft !== tableScroller.scrollLeft) {
      bar.scrollLeft = tableScroller.scrollLeft;
    }
  }, [active, bindTableScroller, tableWrapRef]);

  const scheduleRefreshMetrics = useCallback(() => {
    if (refreshFrameRef.current !== null) {
      return;
    }
    refreshFrameRef.current = window.requestAnimationFrame(() => {
      refreshFrameRef.current = null;
      refreshMetrics();
    });
  }, [refreshMetrics]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const handleVisibilityChange = () => {
      setPageHidden(document.hidden);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const root = tableWrapRef.current;
    if (!root || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setInViewport(entries.some((entry) => entry.isIntersecting));
      },
      {
        root: null,
        threshold: 0,
      }
    );
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, [tableWrapRef]);

  useEffect(() => {
    scheduleRefreshMetrics();
    return () => {
      if (refreshFrameRef.current !== null) {
        window.cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = null;
      }
    };
  }, [scheduleRefreshMetrics]);

  useEffect(() => {
    const root = tableWrapRef.current;
    if (!root || !active || typeof ResizeObserver === "undefined") {
      resizeObserverRef.current = null;
      return;
    }

    const observer = new ResizeObserver(() => {
      scheduleRefreshMetrics();
    });
    observer.observe(root);
    resizeObserverRef.current = observer;

    if (tableScrollerRef.current) {
      observer.observe(tableScrollerRef.current);
      observedTableScrollerRef.current = tableScrollerRef.current;
    }

    return () => {
      observer.disconnect();
      if (resizeObserverRef.current === observer) {
        resizeObserverRef.current = null;
      }
      observedTableScrollerRef.current = null;
    };
  }, [active, scheduleRefreshMetrics, tableWrapRef]);

  useEffect(() => {
    const root = tableWrapRef.current;
    if (!root || !active || typeof MutationObserver === "undefined") {
      mutationObserverRef.current = null;
      return;
    }

    const observer = new MutationObserver(() => {
      scheduleRefreshMetrics();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
    });
    mutationObserverRef.current = observer;

    return () => {
      observer.disconnect();
      if (mutationObserverRef.current === observer) {
        mutationObserverRef.current = null;
      }
    };
  }, [active, scheduleRefreshMetrics, tableWrapRef]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const onWindowResize = () => scheduleRefreshMetrics();
    const onWindowScroll = () => scheduleRefreshMetrics();

    window.addEventListener("resize", onWindowResize, { passive: true });
    window.addEventListener("scroll", onWindowScroll, { passive: true });

    return () => {
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("scroll", onWindowScroll);
    };
  }, [active, scheduleRefreshMetrics]);

  useEffect(() => {
    const tableScroller = tableScrollerRef.current;
    if (!tableScroller) {
      return;
    }
    return () => {
      tableScroller.removeEventListener("scroll", handleTableScroll);
    };
  }, [handleTableScroll]);

  if (!active) {
    return null;
  }

  return (
    <div
      className={`fixed-h-scrollbar-shell${metrics.visible ? "" : " is-hidden"}`}
      style={{
        left: `${metrics.left}px`,
        width: `${metrics.width}px`,
      }}
      aria-hidden={!metrics.visible}
    >
      <div
        ref={barRef}
        className="fixed-h-scrollbar-viewport"
        onScroll={handleBarScroll}
      >
        <div className="fixed-h-scrollbar-spacer" style={{ width: `${metrics.contentWidth}px` }} />
      </div>
    </div>
  );
}
