import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateReadRetryBackoffDelayMs,
  resolveRagicMutationReadPolicy,
} from "../../src/infra/ragicReadRetryPolicy";

test("mutation current-read 預設 budget 可容納一次完整 retry", () => {
  assert.deepEqual(
    resolveRagicMutationReadPolicy({
      timeoutMs: 10_000,
      maxRetries: 1,
      retryBaseDelayMs: 200,
    }),
    {
      timeoutMs: 10_000,
      totalBudgetMs: 21_000,
      maxRetries: 1,
      retryBaseDelayMs: 200,
    }
  );
});

test("mutation current-read 兩次 retry 的預設 budget 可容納三次完整讀取", () => {
  assert.deepEqual(
    resolveRagicMutationReadPolicy({
      timeoutMs: 10_000,
      maxRetries: 2,
      retryBaseDelayMs: 200,
    }),
    {
      timeoutMs: 10_000,
      totalBudgetMs: 32_000,
      maxRetries: 2,
      retryBaseDelayMs: 200,
    }
  );
});

test("mutation current-read 拒絕宣告 retry 卻只有單次 timeout 的 budget", () => {
  assert.throws(
    () =>
      resolveRagicMutationReadPolicy({
        timeoutMs: 10_000,
        maxRetries: 1,
        retryBaseDelayMs: 200,
        configuredTotalBudgetMs: 10_000,
      }),
    /RAGIC_MUTATION_READ_TOTAL_BUDGET_MS 至少需要 21000ms/
  );
});

test("mutation current-read 未啟用 retry 時允許 total budget 等於 timeout", () => {
  assert.equal(
    resolveRagicMutationReadPolicy({
      timeoutMs: 10_000,
      maxRetries: 0,
      retryBaseDelayMs: 200,
      configuredTotalBudgetMs: 10_000,
    }).totalBudgetMs,
    10_000
  );
});

test("mutation current-read total budget 必須容納設定的所有 retries", () => {
  assert.throws(
    () =>
      resolveRagicMutationReadPolicy({
        timeoutMs: 10_000,
        maxRetries: 2,
        retryBaseDelayMs: 200,
        configuredTotalBudgetMs: 21_000,
      }),
    /RAGIC_MUTATION_READ_TOTAL_BUDGET_MS 至少需要 32000ms/
  );
});

test("mutation current-read budget 會跟隨 runtime backoff 上限", () => {
  assert.equal(calculateReadRetryBackoffDelayMs(2_000, 0, () => 0.999_999), 2_599);
  assert.equal(
    resolveRagicMutationReadPolicy({
      timeoutMs: 10_000,
      maxRetries: 1,
      retryBaseDelayMs: 2_000,
    }).totalBudgetMs,
    22_599
  );
  assert.throws(() =>
    resolveRagicMutationReadPolicy({
      timeoutMs: 10_000,
      maxRetries: 1,
      retryBaseDelayMs: 2_000,
      configuredTotalBudgetMs: 21_000,
    })
  );
});
