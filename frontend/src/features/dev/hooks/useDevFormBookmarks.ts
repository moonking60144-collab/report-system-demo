import { useState } from "react";

export interface DevFormRef {
  formPath: string;
  formName: string;
}

const RECENT_KEY = "dev.recentForms";
const PINNED_KEY = "dev.pinnedForms";
const RECENT_MAX = 5;

function read(key: string): DevFormRef[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is DevFormRef =>
        !!x &&
        typeof (x as DevFormRef).formPath === "string" &&
        typeof (x as DevFormRef).formName === "string"
    );
  } catch {
    return [];
  }
}

function write(key: string, value: DevFormRef[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage 滿 / 停用 → 忽略，功能降級不報錯
  }
}

/**
 * 開發者面板的「最近開啟」與「釘選」表單，存 localStorage（裝置層級、跨 session 保留）。
 * 最近＝點開過的表單去重後最多 5 筆；釘選＝手動釘到總覽、不限量。
 */
export function useDevFormBookmarks() {
  const [recent, setRecent] = useState<DevFormRef[]>(() => read(RECENT_KEY));
  const [pinned, setPinned] = useState<DevFormRef[]>(() => read(PINNED_KEY));

  const pushRecent = (form: DevFormRef) => {
    setRecent((prev) => {
      const next = [form, ...prev.filter((x) => x.formPath !== form.formPath)].slice(
        0,
        RECENT_MAX
      );
      write(RECENT_KEY, next);
      return next;
    });
  };

  const togglePin = (form: DevFormRef) => {
    setPinned((prev) => {
      const exists = prev.some((x) => x.formPath === form.formPath);
      const next = exists
        ? prev.filter((x) => x.formPath !== form.formPath)
        : [...prev, form];
      write(PINNED_KEY, next);
      return next;
    });
  };

  const isPinned = (formPath: string) => pinned.some((x) => x.formPath === formPath);

  return { recent, pinned, pushRecent, togglePin, isPinned };
}
