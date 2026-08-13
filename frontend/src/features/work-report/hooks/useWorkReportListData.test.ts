import { describe, expect, it } from "vitest";
import {
  HydrationRequestCoordinator,
  shouldPropagateHydrationFallbackFailure,
  shouldReuseHydratedFullRecords,
} from "./useWorkReportListData";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("shouldReuseHydratedFullRecords", () => {
  it("一般重繪可重用已 hydrate 的本機 records", () => {
    expect(
      shouldReuseHydratedFullRecords({
        forceRefresh: false,
        reloadFromBackend: false,
        hasHydratedAllRecords: true,
        recordCount: 10,
      })
    ).toBe(true);
  });

  it("manual 或 SSE reload 必須繞過本機 memo 重新向 backend 取 snapshot", () => {
    expect(
      shouldReuseHydratedFullRecords({
        forceRefresh: false,
        reloadFromBackend: true,
        hasHydratedAllRecords: true,
        recordCount: 10,
      })
    ).toBe(false);
  });

  it("force refresh 仍會繞過本機 memo 並保留原 live refresh 契約", () => {
    expect(
      shouldReuseHydratedFullRecords({
        forceRefresh: true,
        reloadFromBackend: false,
        hasHydratedAllRecords: true,
        recordCount: 10,
      })
    ).toBe(false);
  });
});

describe("shouldPropagateHydrationFallbackFailure", () => {
  it("initial hydration 可顯示本機 cache，不把 fallback 當成整體失敗", () => {
    expect(shouldPropagateHydrationFallbackFailure(false)).toBe(false);
  });

  it("manual/SSE reload 失敗即使顯示 cache 仍要 reject，不能被 caller 顯示成刷新成功", () => {
    expect(shouldPropagateHydrationFallbackFailure(true)).toBe(true);
  });
});

describe("HydrationRequestCoordinator", () => {
  it("active hydration 期間的 reload 會在目前 request 後再抓一次，且不遺失後續 reload", async () => {
    const coordinator = new HydrationRequestCoordinator<string>();
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const secondStarted = deferred<void>();
    const thirdStarted = deferred<void>();
    let requestCount = 0;
    const execute = async () => {
      requestCount += 1;
      if (requestCount === 1) return first.promise;
      if (requestCount === 2) {
        secondStarted.resolve();
        return second.promise;
      }
      thirdStarted.resolve();
      return third.promise;
    };

    const initialResult = coordinator.run(false, execute);
    const firstReloadResult = coordinator.run(true, execute);
    await Promise.resolve();
    expect(requestCount).toBe(1);

    first.resolve("initial");
    await secondStarted.promise;
    expect(requestCount).toBe(2);

    const latestReloadResult = coordinator.run(true, execute);
    second.resolve("reload-1");
    await thirdStarted.promise;
    expect(requestCount).toBe(3);

    third.resolve("reload-2");
    await expect(initialResult).resolves.toBe("initial");
    await expect(firstReloadResult).resolves.toBe("reload-1");
    await expect(latestReloadResult).resolves.toBe("reload-2");
  });

  it("active hydration 失敗時仍會執行已排入的 reload", async () => {
    const coordinator = new HydrationRequestCoordinator<string>();
    const initial = deferred<string>();
    const reload = deferred<string>();
    const reloadStarted = deferred<void>();
    let requestCount = 0;
    const execute = async () => {
      requestCount += 1;
      if (requestCount === 1) return initial.promise;
      reloadStarted.resolve();
      return reload.promise;
    };

    const initialResult = coordinator.run(false, execute);
    const queuedReloadResult = coordinator.run(true, execute);
    const initialFailure = expect(initialResult).rejects.toThrow("initial failed");
    await Promise.resolve();

    initial.reject(new Error("initial failed"));
    await initialFailure;
    await reloadStarted.promise;
    expect(requestCount).toBe(2);

    reload.resolve("reloaded");
    await expect(queuedReloadResult).resolves.toBe("reloaded");
  });

  it("reset 後舊 form waiter 不會消耗新 form reload 或重新執行舊 execute", async () => {
    const coordinator = new HydrationRequestCoordinator<string>();
    const formAInitial = deferred<string>();
    const formBInitial = deferred<string>();
    const formBReload = deferred<string>();
    const formBReloadStarted = deferred<void>();
    let formARequestCount = 0;
    let formBRequestCount = 0;
    const executeFormA = async () => {
      formARequestCount += 1;
      return formAInitial.promise;
    };
    const executeFormB = async () => {
      formBRequestCount += 1;
      if (formBRequestCount === 1) return formBInitial.promise;
      formBReloadStarted.resolve();
      return formBReload.promise;
    };

    const formAResult = coordinator.run(false, executeFormA);
    const staleFormAReload = coordinator.run(true, executeFormA);
    await Promise.resolve();
    coordinator.reset();

    const formBResult = coordinator.run(false, executeFormB);
    const currentFormBReload = coordinator.run(true, executeFormB);
    await Promise.resolve();
    expect(formARequestCount).toBe(1);
    expect(formBRequestCount).toBe(1);

    formAInitial.resolve("form-a-initial");
    await expect(formAResult).resolves.toBe("form-a-initial");
    await expect(staleFormAReload).resolves.toBe("form-a-initial");
    expect(formARequestCount).toBe(1);

    formBInitial.resolve("form-b-initial");
    await formBReloadStarted.promise;
    expect(formBRequestCount).toBe(2);

    formBReload.resolve("form-b-reload");
    await expect(formBResult).resolves.toBe("form-b-initial");
    await expect(currentFormBReload).resolves.toBe("form-b-reload");
    expect(formARequestCount).toBe(1);
  });
});
