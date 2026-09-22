import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";
import {
  HydrationRequestCoordinator,
  HydrationEntrySettlementBarrier,
  ForegroundPreviewRequestCoordinator,
  INITIAL_BACKGROUND_FETCH_STATE,
  PreviewPageCache,
  buildPreviewRequestKey,
  reduceBackgroundFetchState,
  resolveCachedPreviewRevalidationFailure,
  resolvePreviewLoadFailure,
  retryReadModelUnavailable,
  shouldPropagateHydrationFallbackFailure,
  shouldReuseHydratedFullRecords,
  type PreviewPageCacheEntry,
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

function createApiError(code: string): AxiosError {
  return new AxiosError(
    "Request failed",
    "ERR_BAD_RESPONSE",
    undefined,
    undefined,
    {
      status: 503,
      statusText: "Service Unavailable",
      headers: {},
      config: {} as never,
      data: { error: { code, message: "暫時無法讀取" } },
    }
  );
}

function createPreviewCacheEntry(input: {
  key: string;
  formId?: "901" | "902";
  page?: number;
  cachedAt?: number;
  records?: PreviewPageCacheEntry["records"];
}): PreviewPageCacheEntry {
  return {
    key: input.key,
    formId: input.formId ?? "901",
    page: input.page ?? 1,
    pageSize: 25,
    records: input.records ?? [],
    hasMore: true,
    totalCount: 100,
    readMeta: {
      cacheSource: "sqlite" as const,
      cacheState: "fresh" as const,
      snapshotAt: "2026-08-14T00:00:00.000Z",
    },
    cachedAt: input.cachedAt ?? 1_000,
  };
}

describe("PreviewPageCache", () => {
  it("相同 form、filter、sort 與 page 會產生相同 cache key", () => {
    const input = {
      currentFormId: "901" as const,
      page: 1,
      pageSize: 25,
      shouldUseFullHydrationForList: false,
      bootstrapKeyword: "",
      serverPreviewQuery: {
        enabled: true,
        status: "未結案",
        sort: "machineCode:asc,sortOrder:asc",
      },
    };

    expect(buildPreviewRequestKey(input)).toBe(buildPreviewRequestKey({ ...input }));
    expect(buildPreviewRequestKey(input)).not.toBe(
      buildPreviewRequestKey({ ...input, page: 2 })
    );
  });

  it("fresh entry 可重用，超過 TTL 後不再提供舊頁面", () => {
    const cache = new PreviewPageCache(4, 1_000);
    cache.set(createPreviewCacheEntry({ key: "page-1", cachedAt: 1_000 }));

    expect(cache.get("page-1", 1_999)?.key).toBe("page-1");
    expect(cache.get("page-1", 2_001)).toBeNull();
  });

  it("超過容量時淘汰最久未使用頁面", () => {
    const cache = new PreviewPageCache(2, 10_000);
    cache.set(createPreviewCacheEntry({ key: "page-1" }));
    cache.set(createPreviewCacheEntry({ key: "page-2", page: 2 }));
    expect(cache.get("page-1", 1_100)?.key).toBe("page-1");

    cache.set(createPreviewCacheEntry({ key: "page-3", page: 3 }));

    expect(cache.peek("page-2", 1_100)).toBeNull();
    expect(cache.peek("page-1", 1_100)?.key).toBe("page-1");
    expect(cache.peek("page-3", 1_100)?.key).toBe("page-3");
  });

  it("mutation 先更新相關 preview pages，再標 stale，背景刷新不會套回舊值", () => {
    const cache = new PreviewPageCache(4, 10_000);
    cache.set(
      createPreviewCacheEntry({
        key: "901-page-1",
        formId: "901",
        records: [
          {
            id: "E-901",
            workOrderNo: "WO-901",
            status: "未結案",
            customerPartNo: null,
            erpPartNo: null,
            reports: [],
            sortOrder: 8,
          },
        ],
      })
    );
    cache.set(createPreviewCacheEntry({ key: "902-page-1", formId: "902" }));
    const previousRevision = cache.revision("901");

    cache.updateFormRecords("901", (records) =>
      records.map((record) =>
        record.id === "E-901" ? { ...record, sortOrder: 10 } : record
      )
    );
    cache.invalidateForm("901");

    expect(cache.get("901-page-1", 1_100)?.records[0]?.sortOrder).toBe(10);
    expect(cache.peek("901-page-1", 1_100)?.readMeta.cacheState).toBe("stale");
    expect(cache.peek("902-page-1", 1_100)?.readMeta.cacheState).toBe("fresh");
    expect(cache.revision("901")).toBe(previousRevision + 1);
    expect(cache.revision("902")).toBe(0);
  });
});

describe("ForegroundPreviewRequestCoordinator", () => {
  it("不同 query 取消舊 request，相同 query 沿用 controller", () => {
    const coordinator = new ForegroundPreviewRequestCoordinator();
    const first = coordinator.start("query-a", 1);
    const same = coordinator.start("query-a", 2);
    expect(same).toBe(first);
    expect(first.signal.aborted).toBe(false);

    const next = coordinator.start("query-b", 3);
    expect(first.signal.aborted).toBe(true);
    expect(next.signal.aborted).toBe(false);

    coordinator.reset();
    expect(next.signal.aborted).toBe(true);
  });
});

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

describe("EntrySettlementBarrier", () => {
  it("preview 或 hydration 開始後才完成的 settlement 不會被較早 snapshot 覆寫", async () => {
    const barrier = new HydrationEntrySettlementBarrier<{
      id: string;
      sortOrder: number;
    }>();
    const response = deferred<Array<{ id: string; sortOrder: number }>>();
    const requestRevision = barrier.captureRevision();
    const hydrated = response.promise.then((records) =>
      barrier.merge("901", requestRevision, records)
    );

    barrier.record("901", {
      id: "E-901",
      sortOrder: 11,
    });
    response.resolve([{ id: "E-901", sortOrder: 9 }]);

    await expect(hydrated).resolves.toEqual([{ id: "E-901", sortOrder: 11 }]);
  });

  it("settlement 之前才啟動的新 hydration 可以發布後續 snapshot", () => {
    const barrier = new HydrationEntrySettlementBarrier<{
      id: string;
      sortOrder: number;
    }>();
    barrier.record("901", { id: "E-901", sortOrder: 11 });
    const requestRevision = barrier.captureRevision();

    expect(
      barrier.merge("901", requestRevision, [{ id: "E-901", sortOrder: 12 }])
    ).toEqual([{ id: "E-901", sortOrder: 12 }]);
  });

  it("較早 hydration 遺漏 entry 時仍保留 request 後完成的 settlement", () => {
    const barrier = new HydrationEntrySettlementBarrier<{
      id: string;
      sortOrder: number;
    }>();
    const requestRevision = barrier.captureRevision();
    barrier.record("901", { id: "E-901", sortOrder: 11 });

    expect(barrier.merge("901", requestRevision, [])).toEqual([
      { id: "E-901", sortOrder: 11 },
    ]);
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

describe("retryReadModelUnavailable", () => {
  it("初次載入遇到暫時不可讀時有限重試，成功後回傳結果", async () => {
    const waited: number[] = [];
    let attempts = 0;

    const result = await retryReadModelUnavailable(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw createApiError("SQLITE_READ_MODEL_UNAVAILABLE");
        }
        return "ready";
      },
      {
        retryDelaysMs: [10, 20],
        wait: async (delayMs) => {
          waited.push(delayMs);
        },
      }
    );

    expect(result).toBe("ready");
    expect(attempts).toBe(3);
    expect(waited).toEqual([10, 20]);
  });

  it("非 SQLite readiness 錯誤不重試", async () => {
    let attempts = 0;

    await expect(
      retryReadModelUnavailable(
        async () => {
          attempts += 1;
          throw createApiError("INTERNAL_SERVER_ERROR");
        },
        { retryDelaysMs: [10], wait: async () => undefined }
      )
    ).rejects.toMatchObject({ response: { data: { error: { code: "INTERNAL_SERVER_ERROR" } } } });
    expect(attempts).toBe(1);
  });

  it("查詢條件已切換時停止重試舊請求", async () => {
    let attempts = 0;
    let active = true;

    await expect(
      retryReadModelUnavailable(
        async () => {
          attempts += 1;
          throw createApiError("SQLITE_READ_MODEL_UNAVAILABLE");
        },
        {
          retryDelaysMs: [10],
          shouldContinue: () => active,
          wait: async () => {
            active = false;
          },
        }
      )
    ).rejects.toMatchObject({
      response: { data: { error: { code: "SQLITE_READ_MODEL_UNAVAILABLE" } } },
    });
    expect(attempts).toBe(1);
  });
});

describe("resolveCachedPreviewRevalidationFailure", () => {
  it("重驗失敗時保留快取 rows，並把 snapshot 標成 stale 供 UI 警示", () => {
    const cached = createPreviewCacheEntry({ key: "901-page-1" });
    const records = [{
      id: "E-901",
      workOrderNo: "WO-901",
      status: "未結案",
      customerPartNo: null,
      erpPartNo: null,
      reports: [],
    }];
    cached.records = records;

    const result = resolveCachedPreviewRevalidationFailure(
      cached,
      new Error("network timeout")
    );

    expect(result.records).toBe(records);
    expect(result.readMeta).toEqual({
      cacheSource: "sqlite",
      cacheState: "stale",
      snapshotAt: "2026-08-14T00:00:00.000Z",
    });
    expect(result.error).toBe("network timeout");
  });
});

describe("resolvePreviewLoadFailure", () => {
  it("背景刷新失敗時保留既有 rows，並輸出可呈現的 stale error", () => {
    const retainedPreview = createPreviewCacheEntry({
      key: "901-page-1",
      records: [
        {
          id: "E-901",
          workOrderNo: "WO-901",
          status: "未結案",
          customerPartNo: null,
          erpPartNo: null,
          reports: [],
        },
      ],
    });

    const result = resolvePreviewLoadFailure({
      isBackground: true,
      cachedPreview: null,
      retainedPreview,
      error: new Error("background timeout"),
    });

    expect(result.kind).toBe("retain");
    if (result.kind !== "retain") {
      throw new Error("Expected retained preview");
    }
    expect(result.preview).toBe(retainedPreview);
    expect(result.failure.records).toBe(retainedPreview.records);
    expect(result.failure.readMeta.cacheState).toBe("stale");
    expect(result.failure.error).toBe("background timeout");
  });
});

describe("reduceBackgroundFetchState", () => {
  it("前景 preview supersede 背景 request 後，舊 request 完成不會留下 loading", () => {
    const backgroundStarted = reduceBackgroundFetchState(
      INITIAL_BACKGROUND_FETCH_STATE,
      { type: "start", scope: "preview", requestId: 10 }
    );
    const foregroundStarted = reduceBackgroundFetchState(backgroundStarted, {
      type: "clear",
      scope: "preview",
    });
    const backgroundFinished = reduceBackgroundFetchState(foregroundStarted, {
      type: "finish",
      scope: "preview",
      requestId: 10,
    });

    expect(backgroundFinished).toEqual(INITIAL_BACKGROUND_FETCH_STATE);
  });

  it("較舊的背景 request 完成時不會清掉同 scope 的較新 request", () => {
    const firstStarted = reduceBackgroundFetchState(
      INITIAL_BACKGROUND_FETCH_STATE,
      { type: "start", scope: "preview", requestId: 10 }
    );
    const secondStarted = reduceBackgroundFetchState(firstStarted, {
      type: "start",
      scope: "preview",
      requestId: 11,
    });
    const firstFinished = reduceBackgroundFetchState(secondStarted, {
      type: "finish",
      scope: "preview",
      requestId: 10,
    });

    expect(firstFinished.previewRequestId).toBe(11);
    expect(
      reduceBackgroundFetchState(firstFinished, {
        type: "finish",
        scope: "preview",
        requestId: 11,
      })
    ).toEqual(INITIAL_BACKGROUND_FETCH_STATE);
  });

  it("preview 與 hydration 各自持有 token，任一完成不會提早清除另一個", () => {
    const previewStarted = reduceBackgroundFetchState(
      INITIAL_BACKGROUND_FETCH_STATE,
      { type: "start", scope: "preview", requestId: 3 }
    );
    const bothStarted = reduceBackgroundFetchState(previewStarted, {
      type: "start",
      scope: "hydration",
      requestId: 7,
    });
    const previewFinished = reduceBackgroundFetchState(bothStarted, {
      type: "finish",
      scope: "preview",
      requestId: 3,
    });

    expect(previewFinished).toEqual({
      previewRequestId: null,
      hydrationRequestId: 7,
    });
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
