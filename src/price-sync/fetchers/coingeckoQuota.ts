import { Clock, Effect, Ref } from "effect";
import { describeCause, type PriceSyncError } from "../errors";

// How long every CoinGecko job stands down after the account reports its
// monthly credit limit. The limit only lifts at the billing reset or on a plan
// change, so asking again every cycle just repeats the same rejection across
// every chain. The hourly credit check reopens the gate early once credits are
// back.
export const COINGECKO_QUOTA_PAUSE_MS = 6 * 60 * 60 * 1_000;

// The one line to alert on. Logged once per trip, not once per job, so the
// monitor can match it without de-duplicating a burst of per-chain failures.
export const QUOTA_EXHAUSTED_MARKER = "COINGECKO_QUOTA_EXHAUSTED";
export const QUOTA_RESTORED_MARKER = "COINGECKO_QUOTA_RESTORED";

/**
 * Whether CoinGecko refused a request because the account's monthly credits
 * are spent -- `429` with error code 10006. A plain per-minute rate limit is
 * also a 429 but clears on its own, so it does not pause anything.
 */
export function isMonthlyQuotaError(error: PriceSyncError): boolean {
  const message = describeCause(error.cause);
  return /^429\b/.test(message) && /"error_code"\s*:\s*10006\b/.test(message);
}

/**
 * Shared by every CoinGecko job, because the credit limit belongs to the
 * account: once one job learns it is spent, the others should not each spend a
 * request finding out.
 */
export interface CoinGeckoQuotaGate {
  // Whether requests may go out now.
  readonly isOpen: Effect.Effect<boolean>;
  // Runs a request. A monthly-quota refusal pauses every job sharing the gate
  // and yields `onPaused` instead of failing, so the pause is reported by the
  // single trip line rather than as a failure from each job in flight.
  readonly guard: <A>(
    request: Effect.Effect<A, PriceSyncError>,
    onPaused: A,
  ) => Effect.Effect<A, PriceSyncError>;
  // Reopens a paused gate, e.g. once the credit check shows credits again.
  readonly reopen: (reason: string) => Effect.Effect<void>;
}

export function makeCoinGeckoQuotaGate(
  pauseMs: number = COINGECKO_QUOTA_PAUSE_MS,
): CoinGeckoQuotaGate {
  // Epoch millis the pause lasts until; 0 when open. `makeUnsafe` for the same
  // reason as the fetcher's rotation state: it belongs to the process, not to
  // one cycle.
  const pausedUntil = Ref.makeUnsafe(0);

  const isOpen = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return now >= (yield* Ref.get(pausedUntil));
  });

  const trip = Effect.fn("coingecko.quota.trip")(function* (
    error: PriceSyncError,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const until = now + pauseMs;
    // Only the transition from open logs, so jobs that were already in flight
    // when the first one tripped do not each add a line.
    const tripped = yield* Ref.modify(pausedUntil, (current) =>
      now >= current ? [true, until] : [false, current],
    );
    if (!tripped) return;

    yield* Effect.logError(
      `${QUOTA_EXHAUSTED_MARKER} monthly credit limit reached (error_code 10006) by ${error.source} ${error.operation}; pausing every CoinGecko job paused_until=${new Date(until).toISOString()}`,
    );
  });

  const guard = <A>(
    request: Effect.Effect<A, PriceSyncError>,
    onPaused: A,
  ): Effect.Effect<A, PriceSyncError> =>
    Effect.gen(function* () {
      if (!(yield* isOpen)) return onPaused;

      return yield* request.pipe(
        Effect.catchIf(isMonthlyQuotaError, (error) =>
          trip(error).pipe(Effect.as(onPaused)),
        ),
      );
    });

  const reopen = Effect.fn("coingecko.quota.reopen")(function* (
    reason: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const wasPaused = yield* Ref.modify(pausedUntil, (current) => [
      now < current,
      0,
    ]);
    if (wasPaused) {
      yield* Effect.logInfo(`${QUOTA_RESTORED_MARKER} ${reason}`);
    }
  });

  return { isOpen, guard, reopen };
}
