import { test as base } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export { expect } from "@playwright/test";
export type { Page, Route } from "@playwright/test";

export const test = base.extend<{ executedSources: void }>({
  executedSources: [async ({ page }, use) => {
    const output = process.env.VERIFICATION_BROWSER_TRACE;
    if (!output) { await use(); return; }
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use();
    const coverage = await page.coverage.stopJSCoverage();
    const urls = coverage.filter(script => script.functions.some(fn => fn.ranges.some(range => range.count > 0))).map(script => script.url);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, `${randomUUID()}.json`), JSON.stringify(urls));
  }, { auto: true }],
});
