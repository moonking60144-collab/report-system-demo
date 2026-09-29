const RELOAD_ATTEMPT_KEY = "frontend-update:reload-attempt:v1";
export const FRONTEND_BUILD_ID = String(import.meta.env.VITE_FRONTEND_BUILD_ID ?? "");

interface FrontendUpdateGuardDeps {
  currentBuildId: string;
  loadBuildId: () => Promise<string>;
  readAttempt: () => string | null;
  writeAttempt: (attempt: string) => void;
  reload: () => void;
}

export function createFrontendUpdateGuard(deps: FrontendUpdateGuardDeps) {
  let pending: Promise<void> | null = null;
  let reloading = false;

  const check = (advertisedBuildId?: unknown): Promise<void> => {
    if (!deps.currentBuildId || advertisedBuildId === deps.currentBuildId || reloading) {
      return Promise.resolve();
    }
    if (pending) return pending;
    pending = (async () => {
      try {
        // Confirm the version at the frontend origin before acting on an API/SSE hint.
        const nextBuildId = await deps.loadBuildId();
        if (!nextBuildId || nextBuildId === deps.currentBuildId) return;
        const attempt = `${deps.currentBuildId}:${nextBuildId}`;
        if (deps.readAttempt() === attempt) return;
        deps.writeAttempt(attempt);
        reloading = true;
        deps.reload();
      } catch {
        // A restart, offline connection or unavailable storage must not cause a reload loop.
      }
    })().finally(() => { pending = null; });
    return pending;
  };
  return { check };
}

export const frontendUpdateGuard = createFrontendUpdateGuard({
  currentBuildId: FRONTEND_BUILD_ID,
  async loadBuildId() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    try {
      const base = new URL(import.meta.env.BASE_URL, window.location.href);
      const response = await fetch(new URL("version.json", base), {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return "";
      const payload = await response.json() as { buildId?: unknown };
      return typeof payload.buildId === "string" ? payload.buildId.trim() : "";
    } finally {
      window.clearTimeout(timeout);
    }
  },
  readAttempt: () => window.sessionStorage.getItem(RELOAD_ATTEMPT_KEY),
  writeAttempt: (attempt) => window.sessionStorage.setItem(RELOAD_ATTEMPT_KEY, attempt),
  reload: () => window.location.reload(),
});

export function checkFrontendLifecycleVersion(event: Event): void {
  try {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { frontendBuildId?: unknown };
    void frontendUpdateGuard.check(payload.frontendBuildId);
  } catch {
    // Ignore malformed lifecycle events; visibility/online checks remain available.
  }
}

export function installFrontendUpdateGuard(): void {
  if (!FRONTEND_BUILD_ID) return;
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navigation?.type === "navigate") window.sessionStorage.removeItem(RELOAD_ATTEMPT_KEY);
  } catch {
    // Reload still requires a writable per-tab attempt marker.
  }
  const check = () => { void frontendUpdateGuard.check(); };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  window.addEventListener("online", check);
  window.addEventListener("pageshow", check);
  // Keep this outside React so an import failure unmounting the app cannot cancel recovery.
  window.addEventListener("vite:preloadError", check);
  check();
}
