// Only one indexer may run per chain, and that is enforced with a session-level
// advisory lock. The obvious way to take it -- pg_advisory_lock -- blocks in the
// server until the lock is free, and that wait happens inside a transaction, so
// the waiting backend holds an open snapshot for as long as it blocks.
//
// On 2026-09-01 two workers for chain 46630 connected during a deploy. The loser
// sat in pg_advisory_lock for 22 hours, pinning the vacuum horizon 486,642
// transactions back. Autovacuum could not collect anything database-wide:
// erc20_tokens_latest_price grew to 3.6M dead tuples and a 361 MB heap, and the
// pool-state poll went from ~13 ms to 3.2 s before anyone noticed.
//
// Polling with pg_try_advisory_lock has the same effect for the caller -- wait
// until the lock is available -- but each attempt is its own instant
// transaction, so a loser holds no snapshot between tries. The wait is bounded
// so that a duplicate worker eventually exits loudly rather than idling forever.
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;

export async function pollForAdvisoryLock(
  tryAcquire: () => Promise<boolean>,
  {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    description = "an advisory lock",
    now = Date.now,
    onContended,
  }: {
    pollIntervalMs?: number;
    maxWaitMs?: number;
    description?: string;
    now?: () => number;
    onContended?: (attempt: number) => void;
  } = {},
): Promise<void> {
  const deadline = now() + maxWaitMs;

  for (let attempt = 1; ; attempt++) {
    if (await tryAcquire()) return;

    if (now() >= deadline) {
      throw new Error(
        `Gave up after ${Math.round(maxWaitMs / 1000)}s waiting for ${description}; ` +
          `another process still holds it. Exiting rather than waiting with an open transaction.`,
      );
    }

    onContended?.(attempt);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
