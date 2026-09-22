import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

export async function startMeetingCoverage(page: Page): Promise<void> {
  if (process.env.VERIFICATION_BROWSER_TRACE_DIR) await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

export async function stopMeetingCoverage(page: Page): Promise<void> {
  const directory = process.env.VERIFICATION_BROWSER_TRACE_DIR;
  if (!directory || page.isClosed()) return;
  const entries = await page.coverage.stopJSCoverage();
  const observed = new Set<string>();
  for (const entry of entries) {
    if (!entry.functions.some(fn => fn.ranges.some(range => range.count > 0))) continue;
    const url = new URL(entry.url);
    if (url.pathname.startsWith("/src/")) observed.add(`frontend${decodeURIComponent(url.pathname)}`);
  }
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${randomUUID()}.json`), JSON.stringify({ observedConsumers: [...observed].sort() }));
}
