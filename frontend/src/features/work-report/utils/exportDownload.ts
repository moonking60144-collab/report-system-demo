// 效率統計匯出（期間統計 CSV / 機台運轉分析表）共用的小工具：
// 首頁效率統計 modal 與停機紀錄頁工具列兩個入口都用這份，避免檔名與預設值漂移。

// 僅供 server 未提供匯出檔名時的 fallback，以及「應出勤天數」預設值。
// 真正資料期間與下載檔名以 backend response 為準，不可用瀏覽器時鐘覆蓋 server 結果。
export function lastMonthInfo(
  now = new Date()
): { label: string; year: number; month: number; weekdays: number } {
  const taipeiParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const taipeiYear = Number(taipeiParts.find((part) => part.type === "year")?.value);
  const taipeiMonth = Number(taipeiParts.find((part) => part.type === "month")?.value);
  const previousMonth = new Date(Date.UTC(taipeiYear, taipeiMonth - 2, 1));
  const year = previousMonth.getUTCFullYear();
  const monthIndex = previousMonth.getUTCMonth();
  const totalDays = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  let weekdays = 0;
  for (let day = 1; day <= totalDays; day += 1) {
    const weekday = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) weekdays += 1;
  }
  const month = monthIndex + 1;
  return { label: `${year}-${String(month).padStart(2, "0")}`, year, month, weekdays };
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
