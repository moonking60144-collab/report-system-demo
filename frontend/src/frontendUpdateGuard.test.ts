import { describe, expect, it, vi } from "vitest";
import { createFrontendUpdateGuard } from "./frontendUpdateGuard";

function tab(currentBuildId = "build-a", storage = new Map<string, string>()) {
  const reload = vi.fn();
  const loadBuildId = vi.fn(async () => "build-b");
  const guard = createFrontendUpdateGuard({
    currentBuildId, loadBuildId, reload,
    readAttempt: () => storage.get("attempt") ?? null,
    writeAttempt: (attempt) => { storage.set("attempt", attempt); },
  });
  return { guard, reload, loadBuildId, storage };
}

describe("frontend build update", () => {
  it("same-build reconnects do not reload or add a version request", async () => {
    const page = tab();
    await page.guard.check("build-a");
    await page.guard.check("build-a");
    expect(page.loadBuildId).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("compares the first observation against the loaded build, not a new baseline", async () => {
    const page = tab();
    await page.guard.check();
    expect(page.reload, "FRONTEND_RELOAD_CONTRACT").toHaveBeenCalledTimes(1);
    expect(page.storage.get("attempt")).toBe("build-a:build-b");
  });

  it("waits for the frontend origin to publish the advertised build", async () => {
    const page = tab();
    page.loadBuildId.mockResolvedValueOnce("build-a");
    await page.guard.check("build-b");
    expect(page.reload).not.toHaveBeenCalled();
    await page.guard.check("build-b");
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("each open tab reloads independently", async () => {
    const first = tab();
    const second = tab();
    await first.guard.check("build-b");
    await second.guard.check("build-b");
    expect(first.reload).toHaveBeenCalledTimes(1);
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it("coalesces SSE, visibility and preload-error checks into one reload", async () => {
    const page = tab();
    let publish!: (id: string) => void;
    page.loadBuildId.mockReturnValueOnce(new Promise((resolve) => { publish = resolve; }));
    const checks = [page.guard.check("build-b"), page.guard.check(), page.guard.check()];
    expect(page.loadBuildId).toHaveBeenCalledTimes(1);
    publish("build-b");
    await Promise.all(checks);
    await page.guard.check("build-b");
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("stale HTML after reload cannot loop, but a later release can recover", async () => {
    const first = tab();
    await first.guard.check("build-b");
    const staleReload = tab("build-a", first.storage);
    await staleReload.guard.check("build-b");
    expect(staleReload.reload).not.toHaveBeenCalled();
    staleReload.loadBuildId.mockResolvedValue("build-c");
    await staleReload.guard.check("build-c");
    expect(staleReload.reload).toHaveBeenCalledTimes(1);
    const updated = tab("build-c", first.storage);
    await updated.guard.check("build-c");
    expect(updated.reload).not.toHaveBeenCalled();
  });

  it("an unavailable or missing manifest does not reload and can be retried", async () => {
    const page = tab();
    page.loadBuildId.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("");
    await page.guard.check();
    await page.guard.check();
    expect(page.reload).not.toHaveBeenCalled();
    await page.guard.check();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("does not auto-reload when the loop-prevention marker cannot be stored", async () => {
    const reload = vi.fn();
    const guard = createFrontendUpdateGuard({
      currentBuildId: "build-a", loadBuildId: async () => "build-b", reload,
      readAttempt: () => null,
      writeAttempt: () => { throw new Error("storage denied"); },
    });
    await guard.check();
    expect(reload).not.toHaveBeenCalled();
  });
});
