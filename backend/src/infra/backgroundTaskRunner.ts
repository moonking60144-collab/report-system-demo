/**
 * Background task runner
 *
 * 統一的「route 收到 request → 背景跑 worker → 更新 task status」pattern。
 * 解決的問題：
 * - `void (async () => {})()` 裡面如果 throw，Node 20+ 會 unhandledRejection 導致 process crash
 * - 各 route 自己 try/catch + upsert task status 程式碼重複
 * - 雙重保險：handler 內的 catch 失敗時還有最外層 catch 擋住
 *
 * 使用方式：
 *   runBackgroundTask("create-downtime", async () => {
 *     const result = await doWork();
 *     markSuccess(result);
 *   }, (error) => markFailed(error));
 *
 * **不適用情境（重要）**：
 * - 這是 **fire-and-forget** 模式，process 重啟會丟掉 in-flight task，**不能跨啟動 retry**
 * - 不適合長時間 / 高重要性任務（callback、批次寫入幾分鐘的）
 * - 對比：104/105 工令的 batch create / update 走 `workReportTaskRegistryService`，
 *   有 persist 到 task store（重啟後會把 pending/running 標 failed，由 client 看到狀態
 *   再決定 retry），是真正的 worker queue
 *
 * 適用情境：
 * - 短任務（< 30s）、失敗可以容忍直接丟（callback / projection / log push）
 * - Route handler 已經回了 client 200，背景做完即可，不需要持久狀態
 */
export function runBackgroundTask(
  label: string,
  work: () => Promise<void>,
  onError?: (error: unknown) => void
): void {
  // 用立即執行的 async function + 完整 try/catch 包住，絕對不讓 exception 逃出
  void (async () => {
    try {
      await work();
    } catch (error) {
      try {
        onError?.(error);
      } catch (handlerError) {
        console.error("[background-task][onError-failed]", {
          label,
          originalError: error instanceof Error ? error.message : String(error),
          handlerError: handlerError instanceof Error ? handlerError.message : String(handlerError),
        });
      }
      // 最外層再多一層保險：確保不會 unhandledRejection
      console.error("[background-task][failed]", {
        label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
