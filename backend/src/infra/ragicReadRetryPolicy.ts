const MUTATION_RETRY_BUDGET_BUFFER_MS = 1_000;

export interface RagicMutationReadPolicyInput {
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  configuredTotalBudgetMs?: number;
}

export interface RagicMutationReadPolicy {
  timeoutMs: number;
  totalBudgetMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

function calculateBackoffJitterRange(baseDelayMs: number): number {
  return Math.max(1, Math.round(baseDelayMs * 0.3));
}

export function calculateReadRetryBackoffDelayMs(
  baseDelayMs: number,
  attempt: number,
  random: () => number = Math.random
): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.floor(random() * calculateBackoffJitterRange(baseDelayMs));
  return exponential + jitter;
}

function calculateMaximumBackoffBudgetMs(
  baseDelayMs: number,
  maxRetries: number
): number {
  if (maxRetries <= 0) {
    return 0;
  }
  const exponentialTotal = baseDelayMs * (2 ** maxRetries - 1);
  const jitterTotal =
    maxRetries * (calculateBackoffJitterRange(baseDelayMs) - 1);
  return exponentialTotal + jitterTotal;
}

export function resolveRagicMutationReadPolicy(
  input: RagicMutationReadPolicyInput
): RagicMutationReadPolicy {
  const minimumTotalBudgetMs =
    input.timeoutMs * (input.maxRetries + 1) +
    Math.max(
      input.maxRetries * MUTATION_RETRY_BUDGET_BUFFER_MS,
      calculateMaximumBackoffBudgetMs(
        input.retryBaseDelayMs,
        input.maxRetries
      )
    );
  const totalBudgetMs =
    input.configuredTotalBudgetMs ?? minimumTotalBudgetMs;

  if (!Number.isSafeInteger(totalBudgetMs) || totalBudgetMs < minimumTotalBudgetMs) {
    throw new Error(
      `RAGIC_MUTATION_READ_TOTAL_BUDGET_MS 至少需要 ${minimumTotalBudgetMs}ms` +
        `（目前 ${totalBudgetMs}ms），才能容納 ${input.timeoutMs}ms timeout` +
        ` 與 ${input.maxRetries} 次 read retry 的 backoff。`
    );
  }

  return {
    timeoutMs: input.timeoutMs,
    totalBudgetMs,
    maxRetries: input.maxRetries,
    retryBaseDelayMs: input.retryBaseDelayMs,
  };
}
