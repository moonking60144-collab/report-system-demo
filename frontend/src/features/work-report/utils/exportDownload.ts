// 效率統計匯出（期間統計 CSV / 機台運轉分析表）共用的小工具：
// 首頁效率統計 modal 與停機紀錄頁工具列兩個入口都用這份，避免檔名與預設值漂移。

// 資料窗固定是「上個月」（同 Ragic 發佈 view 的期間統計）。
// weekdays = 上個月平日數（一～五），當「應出勤天數」預設值；遇國定假日使用者自己調。
export function lastMonthInfo(
  now = new Date()
): { label: string; year: number; month: number; weekdays: number } {
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const monthIndex = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const totalDays = new Date(year, monthIndex + 1, 0).getDate();
  let weekdays = 0;
  for (let day = 1; day <= totalDays; day += 1) {
    const weekday = new Date(year, monthIndex, day).getDay();
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
