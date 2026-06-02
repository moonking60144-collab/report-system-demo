import { useCallback, useEffect, useState } from "react";

const BODY_BG = {
  light: "#f5f7fa",
  dark: "#020617",
} as const;

export type ItDutyThemeMode = "light" | "dark" | "system";
export type ItDutyResolvedTheme = "light" | "dark";

const STORAGE_KEY = "itDuty.theme";
const VALID_MODES: ReadonlySet<ItDutyThemeMode> = new Set(["light", "dark", "system"]);

function readStoredMode(): ItDutyThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && VALID_MODES.has(raw as ItDutyThemeMode)) {
      return raw as ItDutyThemeMode;
    }
  } catch {
    // localStorage 異常時保守 fallback
  }
  return "system";
}

function getSystemPreferred(): ItDutyResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolve(mode: ItDutyThemeMode): ItDutyResolvedTheme {
  if (mode === "system") return getSystemPreferred();
  return mode;
}

export interface UseItDutyThemeResult {
  mode: ItDutyThemeMode;
  resolved: ItDutyResolvedTheme;
  setMode: (mode: ItDutyThemeMode) => void;
}

export function useItDutyTheme(): UseItDutyThemeResult {
  const [mode, setModeState] = useState<ItDutyThemeMode>(() => readStoredMode());
  const [resolved, setResolved] = useState<ItDutyResolvedTheme>(() => resolve(readStoredMode()));

  // 監聽系統色彩偏好變動（只有當前 mode === system 才需要更新）
  useEffect(() => {
    if (mode !== "system" || typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setResolved(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  // mode 變動 → 同步 resolved
  useEffect(() => {
    setResolved(resolve(mode));
  }, [mode]);

  // (1) 把 body 整片染上對應底色 — 避免頁面 max-width 收窄時兩側露白
  // (2) 把 data-theme 套在 documentElement (<html>) — 這樣 antd Modal 用 portal
  //     渲染到 body 外面時，它裡面的 .itduty-* class 也能讀到對應主題的 CSS vars
  // 兩條都在 IT 頁面 unmount 時還原，不會污染其他頁面
  useEffect(() => {
    if (typeof document === "undefined") return;
    const body = document.body;
    const html = document.documentElement;
    const previousBg = body.style.backgroundColor;
    const previousTheme = html.getAttribute("data-theme");
    body.style.backgroundColor = BODY_BG[resolved];
    html.setAttribute("data-theme", resolved);
    return () => {
      body.style.backgroundColor = previousBg;
      if (previousTheme === null) {
        html.removeAttribute("data-theme");
      } else {
        html.setAttribute("data-theme", previousTheme);
      }
    };
  }, [resolved]);

  const setMode = useCallback((next: ItDutyThemeMode) => {
    if (!VALID_MODES.has(next)) return;
    setModeState(next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 寫入失敗忽略，state 仍可生效
    }
  }, []);

  return { mode, resolved, setMode };
}
