import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const TAB_ID_STORAGE_KEY = "work-report:tab-id:v1";
const CLIENT_BOOT_ID_STORAGE_KEY = "work-report:client-boot-id:v1";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function installBrowserStub(navigationType: "navigate" | "reload", existing = false) {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  if (existing) {
    sessionStorage.setItem(TAB_ID_STORAGE_KEY, "tab-existing");
    sessionStorage.setItem(CLIENT_BOOT_ID_STORAGE_KEY, "boot-existing");
  }
  vi.stubGlobal("window", { localStorage, sessionStorage });
  vi.stubGlobal("performance", {
    getEntriesByType: () => [{ type: navigationType }],
  });
  return { localStorage, sessionStorage };
}

describe("clientIdentity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("navigate document 只旋轉一次 tab 與 boot identity", async () => {
    const { sessionStorage } = installBrowserStub("navigate", true);
    const { getOrCreateClientBootId, getOrCreateTabId } = await import("./clientIdentity");

    const firstTabId = getOrCreateTabId();
    const firstBootId = getOrCreateClientBootId();

    expect(firstTabId).not.toBe("tab-existing");
    expect(firstBootId).not.toBe("boot-existing");
    expect(getOrCreateTabId()).toBe(firstTabId);
    expect(getOrCreateClientBootId()).toBe(firstBootId);
    expect(sessionStorage.getItem(TAB_ID_STORAGE_KEY)).toBe(firstTabId);
    expect(sessionStorage.getItem(CLIENT_BOOT_ID_STORAGE_KEY)).toBe(firstBootId);
  });

  test("先讀 boot 或先讀 tab 都會取得同一份完整 identity", async () => {
    installBrowserStub("navigate", true);
    const { getOrCreateClientBootId, getOrCreateTabId } = await import("./clientIdentity");

    const bootId = getOrCreateClientBootId();
    const tabId = getOrCreateTabId();

    expect(getOrCreateClientBootId()).toBe(bootId);
    expect(getOrCreateTabId()).toBe(tabId);
  });

  test("reload document 保留既有 session identity", async () => {
    installBrowserStub("reload", true);
    const { getOrCreateClientBootId, getOrCreateTabId } = await import("./clientIdentity");

    expect(getOrCreateTabId()).toBe("tab-existing");
    expect(getOrCreateClientBootId()).toBe("boot-existing");
  });

  test("本機名稱會正規化後保存，並相容既有 debug.deviceLabel", async () => {
    const { localStorage } = installBrowserStub("reload");
    localStorage.setItem("debug.deviceLabel", "  舊電腦  ");
    const {
      encodeTaskActorLabelHeader,
      readWorkReportDeviceLabel,
      writeWorkReportDeviceLabel,
    } = await import("./clientIdentity");

    expect(readWorkReportDeviceLabel()).toBe("舊電腦");

    writeWorkReportDeviceLabel("  生管\n工作站  ");
    expect(readWorkReportDeviceLabel()).toBe("生管 工作站");
    expect(localStorage.getItem("work-report:device-label:v1")).toBe("生管 工作站");
    expect(encodeTaskActorLabelHeader("生管 工作站")).toBe(
      encodeURIComponent("生管 工作站")
    );

    writeWorkReportDeviceLabel("");
    expect(localStorage.getItem("work-report:device-label:v1")).toBeNull();
    expect(localStorage.getItem("debug.deviceLabel")).toBeNull();
    expect(readWorkReportDeviceLabel()).toBe("");
  });

  test("本機名稱儲存空間不可用時不會阻斷報工流程", async () => {
    installBrowserStub("reload");
    vi.stubGlobal("window", {
      sessionStorage: new MemoryStorage(),
      localStorage: {
        getItem: () => {
          throw new Error("storage blocked");
        },
        setItem: () => {
          throw new Error("storage blocked");
        },
        removeItem: () => {
          throw new Error("storage blocked");
        },
      },
    });
    const { readWorkReportDeviceLabel, writeWorkReportDeviceLabel } = await import(
      "./clientIdentity"
    );

    expect(readWorkReportDeviceLabel()).toBe("");
    expect(() => writeWorkReportDeviceLabel("生管工作站")).not.toThrow();
  });
});
