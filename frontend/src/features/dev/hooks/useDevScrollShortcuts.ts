import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SCROLL_SHORTCUT_COLLAPSE_HOLD_MS = 2000;
const SCROLL_SHORTCUT_EXIT_MS = 3000;

type ScrollHint = "down" | "up" | null;
type ConcreteScrollHint = Exclude<ScrollHint, null>;

export function useDevScrollShortcuts(layoutVersion: string) {
  const [scrollHint, setScrollHint] = useState<ScrollHint>(null);
  const [expandedForHint, setExpandedForHint] = useState<ConcreteScrollHint | null>(null);
  const [closingForHint, setClosingForHint] = useState<ConcreteScrollHint | null>(null);
  const expandTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const expanded = scrollHint !== null && expandedForHint === scrollHint;
  const closing = scrollHint !== null && closingForHint === scrollHint;

  const clearExpandTimer = useCallback(() => {
    if (expandTimerRef.current === null) return;
    window.clearTimeout(expandTimerRef.current);
    expandTimerRef.current = null;
  }, []);

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current === null) return;
    window.clearTimeout(collapseTimerRef.current);
    collapseTimerRef.current = null;
  }, []);

  useEffect(() => {
    let frame = 0;
    const computeScrollHint = () => {
      const doc = document.documentElement;
      const maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
      if (maxScroll <= 40) {
        setScrollHint(null);
        return;
      }
      setScrollHint(window.scrollY / maxScroll < 0.5 ? "down" : "up");
    };
    const scheduleScrollHint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(computeScrollHint);
    };

    scheduleScrollHint();
    window.addEventListener("scroll", scheduleScrollHint, { passive: true });
    window.addEventListener("resize", scheduleScrollHint);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleScrollHint);
      window.removeEventListener("resize", scheduleScrollHint);
    };
  }, [layoutVersion]);

  useEffect(() => {
    clearExpandTimer();
    clearCollapseTimer();
    return () => {
      clearExpandTimer();
      clearCollapseTimer();
    };
  }, [clearCollapseTimer, clearExpandTimer, scrollHint]);

  const handleHoverStart = useCallback(() => {
    if (!scrollHint) return;
    clearCollapseTimer();
    setClosingForHint(null);
    if (expanded) return;
    if (expandTimerRef.current !== null) return;
    expandTimerRef.current = window.setTimeout(() => {
      setExpandedForHint(scrollHint);
      setClosingForHint(null);
      expandTimerRef.current = null;
    }, 350);
  }, [clearCollapseTimer, expanded, scrollHint]);

  const handleHoverEnd = useCallback(() => {
    if (!scrollHint) return;
    clearExpandTimer();
    if (!expanded) return;
    setClosingForHint(null);
    clearCollapseTimer();
    collapseTimerRef.current = window.setTimeout(() => {
      setClosingForHint(scrollHint);
      collapseTimerRef.current = window.setTimeout(() => {
        setExpandedForHint(null);
        setClosingForHint(null);
        collapseTimerRef.current = null;
      }, SCROLL_SHORTCUT_EXIT_MS);
    }, SCROLL_SHORTCUT_COLLAPSE_HOLD_MS);
  }, [clearCollapseTimer, clearExpandTimer, expanded, scrollHint]);

  const scrollToEdge = useCallback((direction: ScrollHint = scrollHint) => {
    if (!direction) return;
    const maxScroll = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight
    );
    const top = direction === "up" ? 0 : maxScroll;
    window.scrollTo({ top, behavior: "smooth" });
  }, [scrollHint]);

  const className = useMemo(
    () =>
      [
        "ragic-defs__scroll-shortcuts",
        expanded ? "is-expanded" : "",
        closing ? "is-closing" : "",
      ].filter(Boolean).join(" "),
    [closing, expanded]
  );

  return {
    scrollHint,
    scrollShortcutClassName: className,
    scrollShortcutExpanded: expanded,
    handleScrollShortcutHoverStart: handleHoverStart,
    handleScrollShortcutHoverEnd: handleHoverEnd,
    handleScrollShortcut: scrollToEdge,
  };
}
