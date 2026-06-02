/**
 * Demo fault-injection — 給 demo UI 提供「按一下就觸發後端三條防線」的開關。
 *
 * 三條防線：
 * 1. ragicRequestScheduler 的 circuit breaker → 連續 read/write 失敗會把上游熔斷
 * 2. form16WriteVerifier → createEntry 後讀回比對 critical field，發現缺漏自動 DELETE rollback
 * 3. form16OrphanCleanup → 定期掃 orphan row（缺工單號）並清掉
 *
 * 模組級 mutable state：只有在 DEMO_MODE=true 時會被 MockRagicClient 讀取／
 * 透過 /api/__demo/fault-injection 寫入。production 永遠走預設零值，因此就算
 * 這個模組被 import 也不會影響真實流量。
 */

export interface FaultInjectionState {
  /** 總開關。enabled=false 時 helpers 全部 no-op，不論其他欄位設多少 */
  enabled: boolean;
  /** 0..1，每次 read/write 進來時 < failureRate 就丟 UpstreamError */
  failureRate: number;
  /** 0..5000ms，每次 read/write 進來時隨機延遲 0..latencyMs */
  latencyMs: number;
  /** 0..1，createEntry 時 < dropFieldRate 就隨機掉一個 critical field，觸發 write verifier rollback */
  dropFieldRate: number;
}

const DEFAULT_STATE: FaultInjectionState = {
  enabled: false,
  failureRate: 0,
  latencyMs: 0,
  dropFieldRate: 0,
};

let state: FaultInjectionState = { ...DEFAULT_STATE };

export function getState(): FaultInjectionState {
  return { ...state };
}

export function setState(partial: Partial<FaultInjectionState>): FaultInjectionState {
  const next: FaultInjectionState = { ...state };
  if (typeof partial.enabled === "boolean") {
    next.enabled = partial.enabled;
  }
  if (typeof partial.failureRate === "number" && Number.isFinite(partial.failureRate)) {
    next.failureRate = clamp(partial.failureRate, 0, 1);
  }
  if (typeof partial.latencyMs === "number" && Number.isFinite(partial.latencyMs)) {
    next.latencyMs = clamp(Math.trunc(partial.latencyMs), 0, 5000);
  }
  if (typeof partial.dropFieldRate === "number" && Number.isFinite(partial.dropFieldRate)) {
    next.dropFieldRate = clamp(partial.dropFieldRate, 0, 1);
  }
  state = next;
  return { ...state };
}

export function reset(): FaultInjectionState {
  state = { ...DEFAULT_STATE };
  return { ...state };
}

/** 隨機數 < failureRate，且 enabled=true */
export function shouldInjectFailure(): boolean {
  if (!state.enabled) return false;
  if (state.failureRate <= 0) return false;
  return Math.random() < state.failureRate;
}

/** 0 if disabled，否則 [0, latencyMs) 之間隨機 */
export function getLatencyMs(): number {
  if (!state.enabled) return 0;
  if (state.latencyMs <= 0) return 0;
  return Math.floor(Math.random() * state.latencyMs);
}

/** 隨機數 < dropFieldRate，且 enabled=true */
export function shouldDropField(): boolean {
  if (!state.enabled) return false;
  if (state.dropFieldRate <= 0) return false;
  return Math.random() < state.dropFieldRate;
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
