import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { env } from "../../src/config/env";
import { prewarmFormOptionsOnStartup, stopFormOptionsPrewarm } from "../../src/bootstrap/prewarm";
import { workReportReadService } from "../../src/services/work-report/workReportReadService";

type MutableEnv = typeof env & {
  WORK_REPORT_OPTIONS_PREWARM_STARTUP_DELAY_MS: number;
  WORK_REPORT_OPTIONS_PREWARM_BETWEEN_FORMS_DELAY_MS: number;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await wait(5);
  }
}

function overrideOptionsPrewarmEnv(
  t: TestContext,
  values: {
    startupDelayMs: number;
    betweenFormsDelayMs: number;
  }
): void {
  const mutableEnv = env as MutableEnv;
  const originalStartupDelayMs = mutableEnv.WORK_REPORT_OPTIONS_PREWARM_STARTUP_DELAY_MS;
  const originalBetweenFormsDelayMs =
    mutableEnv.WORK_REPORT_OPTIONS_PREWARM_BETWEEN_FORMS_DELAY_MS;

  mutableEnv.WORK_REPORT_OPTIONS_PREWARM_STARTUP_DELAY_MS = values.startupDelayMs;
  mutableEnv.WORK_REPORT_OPTIONS_PREWARM_BETWEEN_FORMS_DELAY_MS = values.betweenFormsDelayMs;

  t.after(() => {
    stopFormOptionsPrewarm();
    mutableEnv.WORK_REPORT_OPTIONS_PREWARM_STARTUP_DELAY_MS = originalStartupDelayMs;
    mutableEnv.WORK_REPORT_OPTIONS_PREWARM_BETWEEN_FORMS_DELAY_MS = originalBetweenFormsDelayMs;
  });
}

test("options prewarm 啟動時只排程，不會 listen 後立刻打 Ragic", async (t) => {
  stopFormOptionsPrewarm();
  overrideOptionsPrewarmEnv(t, { startupDelayMs: 40, betweenFormsDelayMs: 0 });
  t.mock.method(console, "info", () => {});
  const calls: string[] = [];
  t.mock.method(workReportReadService, "getFormOptions", async (formId: string) => {
    calls.push(formId);
    return {};
  });

  prewarmFormOptionsOnStartup();

  assert.deepEqual(calls, []);
  await wait(15);
  assert.deepEqual(calls, []);

  await waitUntil(() => calls.length === 2);
  assert.deepEqual(calls, ["104", "105"]);
});

test("options prewarm 104/105 串行執行，中間套用 between forms delay", async (t) => {
  stopFormOptionsPrewarm();
  overrideOptionsPrewarmEnv(t, { startupDelayMs: 0, betweenFormsDelayMs: 25 });
  t.mock.method(console, "info", () => {});

  const started: Array<{ formId: string; at: number }> = [];
  const finished: Array<{ formId: string; at: number }> = [];
  let active = 0;
  let maxActive = 0;
  t.mock.method(workReportReadService, "getFormOptions", async (formId: string) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push({ formId, at: Date.now() });
    if (formId === "104") {
      await wait(10);
    }
    active -= 1;
    finished.push({ formId, at: Date.now() });
    return {};
  });

  prewarmFormOptionsOnStartup();

  await waitUntil(() => finished.length === 2);
  assert.deepEqual(
    started.map((item) => item.formId),
    ["104", "105"]
  );
  assert.equal(maxActive, 1);
  assert.equal(finished[0]?.formId, "104");
  assert.equal(started[1]?.formId, "105");
  assert.ok(
    (started[1]?.at ?? 0) - (finished[0]?.at ?? 0) >= 15,
    "105 應在 104 完成後再等待 configured delay 才開始"
  );
});
