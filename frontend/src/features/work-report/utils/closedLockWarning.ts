import { message } from "antd";

// 連點保護：1.5 秒內只吐一次 toast，避免連按導致一堆 message 疊起來
let lastShownAt = 0;

export function showClosedLockWarning(text: string): void {
  const now = Date.now();
  if (now - lastShownAt < 1500) {
    return;
  }
  lastShownAt = now;
  void message.warning({ content: text, duration: 2.5 });
}
