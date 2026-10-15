import { Clock, Effect, Ref } from "effect";
import { describeCause, type PriceSyncError } from "../errors";

export const COINGECKO_QUOTA_PAUSE_MS = 6 * 60 * 60 * 1_000;

export const QUOTA_EXHAUSTED_MARKER = "COINGECKO_QUOTA_EXHAUSTED";
export const QUOTA_RESTORED_MARKER = "COINGECKO_QUOTA_RESTORED";

export function isMonthlyQuotaError(error: PriceSyncError): boolean {
  const message = describeCause(error.cause);
  return /^429\b/.test(message) && /"error_code"\s*:\s*10006\b/.test(message);
}

export interface CoinGeckoQuotaGate {
  readonly isOpen: Effect.Effect<boolean>;
  readonly guard: <A>(
    request: Effect.Effect<A, PriceSyncError>,
    onPaused: A,
  ) => Effect.Effect<A, PriceSyncError>;
  readonly reopen: (reason: string) => Effect.Effect<void>;
}

export function makeCoinGeckoQuotaGate(
  pauseMs: number = COINGECKO_QUOTA_PAUSE_MS,
): CoinGeckoQuotaGate {
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
