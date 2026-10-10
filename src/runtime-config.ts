export const CONTINUATION_RETRY_MS = 50;
/** Waits after 1, 2 and 3+ no-progress continuation runs in a row. */
export const CONTINUATION_BACKOFF_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000];
export const RUNTIME_PERSIST_INTERVAL_MS = 60_000;

export const __testHooks = {
  continuationRetryMs: CONTINUATION_RETRY_MS,
  runtimePersistIntervalMs: RUNTIME_PERSIST_INTERVAL_MS,
};
