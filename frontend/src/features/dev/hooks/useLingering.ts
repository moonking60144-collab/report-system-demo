import { useEffect, useState } from "react";

/**
 * `active` 變 true 時立刻回傳 true；變 false 時延遲 lingerMs 才回傳 false。
 * 用於進度條完成後想保持 100% 顯示一下下再消失的場景。
 */
export function useLingering(active: boolean, lingerMs: number): boolean {
  const [linger, setLinger] = useState(active);
  useEffect(() => {
    if (active) {
      // active 重新拉起時要立刻把 linger 拉回 true（之前可能已被 timer 設成 false）
      // 這個 setState in effect 是必要的：state 必須跟著 prop 即時同步
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinger(true);
      return;
    }
    const id = window.setTimeout(() => setLinger(false), lingerMs);
    return () => window.clearTimeout(id);
  }, [active, lingerMs]);
  return linger;
}
