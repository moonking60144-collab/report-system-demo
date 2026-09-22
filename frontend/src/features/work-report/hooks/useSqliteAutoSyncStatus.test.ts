import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subscribeSqliteAutoSyncStatus } from "./useSqliteAutoSyncStatus";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../api/apiClient", () => ({ createApiClient: () => ({ get }) }));
vi.mock("../../../utils/clientIdentity", () => ({
  getOrCreateClientBootId: () => "boot", getOrCreateClientId: () => "client", getOrCreateTabId: () => "tab",
}));
class Source extends EventTarget {
  static current: Source;
  readyState = 1;
  close = vi.fn();
  constructor() { super(); Source.current = this; }
  send(forms: string[]) {
    this.dispatchEvent(new MessageEvent("work-report-event", { data: JSON.stringify({
      type: "sqlite-auto-sync-status", sqliteAutoSync: { activeFormIds: forms },
    }) }));
  }
}
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { EventSource: Source, setInterval }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  get.mockReset();
});
afterEach(() => { dispose?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("初次載入取得同步狀態，事件立即清除，晚到 GET 不覆蓋較新的結束事件", async () => {
  let finish: (value: unknown) => void = () => {};
  get.mockResolvedValueOnce({ data: { data: { activeFormIds: ["901"] } } })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const changed = vi.fn();
  dispose = subscribeSqliteAutoSyncStatus(changed);
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenLastCalledWith(["901"]);
  window.dispatchEvent(new Event("focus"));
  Source.current.send([]);
  finish({ data: { data: { activeFormIds: ["901"] } } });
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenLastCalledWith([]);
  expect(get).toHaveBeenCalledTimes(2);
});

it("斷線清除已知狀態，重連查當下狀態，卸載中止回應及補查", async () => {
  get.mockResolvedValue({ data: { data: { activeFormIds: ["903"] } } });
  const changed = vi.fn();
  dispose = subscribeSqliteAutoSyncStatus(changed);
  await vi.advanceTimersByTimeAsync(0);
  Source.current.dispatchEvent(new Event("error"));
  expect(changed).toHaveBeenLastCalledWith(null);
  get.mockResolvedValue({ data: { data: { activeFormIds: [] } } });
  Source.current.dispatchEvent(new Event("open"));
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenLastCalledWith([]);
  dispose(); dispose = undefined;
  const calls = get.mock.calls.length;
  Source.current.send(["902"]);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(get).toHaveBeenCalledTimes(calls);
  expect(changed).toHaveBeenLastCalledWith([]);
  expect(Source.current.close).toHaveBeenCalledOnce();
});

it("查詢失敗與格式不正確不宣稱同步中，舊請求在卸載後不能更新", async () => {
  let finish: (value: unknown) => void = () => {};
  get.mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ data: { data: { activeFormIds: "901" } } })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const changed = vi.fn();
  dispose = subscribeSqliteAutoSyncStatus(changed);
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenLastCalledWith(null);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenLastCalledWith(null);
  window.dispatchEvent(new Event("focus"));
  dispose(); dispose = undefined;
  finish({ data: { data: { activeFormIds: ["902"] } } });
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenCalledTimes(2);
});
