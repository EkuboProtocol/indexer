// Only one indexer may run per chain, enforced with a session-level advisory
// lock. Contention on that lock is deliberate: a deployment starts the new
// instances before the old ones exit, and each newcomer is meant to sit on the
// lock until its predecessor releases it. A full deploy shows around eight
// waiters at once, clearing within seconds. That handoff is the design and this
// module preserves it -- a waiter still waits for as long as it takes.
//
// What is not wanted is for the waiting to cost the database anything.
// pg_advisory_lock blocks inside the server, and the blocked backend holds an
// open transaction -- and so a snapshot -- for the entire wait. That pins the
// vacuum horizon database-wide. On 2026-09-01 a chain-46630 handoff never
// completed: the waiter sat there for 22 hours, held the horizon 486,642
// transactions back, and autovacuum stopped being able to collect anything.
// erc20_tokens_latest_price reached 3.6M dead tuples in a 361 MB heap and the
// pool-state poll went from ~13 ms to 3.2 s.
//
// pg_try_advisory_lock returns immediately instead of blocking, so each attempt
// is its own instant transaction and a waiter holds no snapshot between tries.
// The wait is unbounded, exactly as before; it simply no longer holds the
// horizon while it waits. The interval is short so takeover stays prompt once
// the predecessor exits.
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function pollForAdvisoryLock(
  tryAcquire: () => Promise<boolean>,
  {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
    onContended,
  }: {
    pollIntervalMs?: number;
    now?: () => number;
    onContended?: (waitedMs: number) => void;
  } = {},
): Promise<void> {
  const startedAt = now();

  for (;;) {
    if (await tryAcquire()) return;

    onContended?.(now() - startedAt);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
