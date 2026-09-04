import { Clock, Duration, Effect, Ref, Semaphore } from "effect";

export interface LaunchSpacer {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}

/**
 * Spaces the *start* of each wrapped effect by at least `minTimeMs`.
 *
 * This is the Bottleneck `minTime` contract the quoter ran on, and the
 * distinction matters: it caps the request rate, not the number of requests in
 * flight. A concurrency limit would serialize quotes behind the slowest one
 * and stretch a cycle out; spacing launches keeps the same request budget with
 * the same overlap the quoter always had.
 *
 * Only the wait itself holds the permit, so callers queue for their slot and
 * then run concurrently.
 */
export function makeLaunchSpacer(
  minTimeMs: number,
): Effect.Effect<LaunchSpacer> {
  return Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    const nextLaunchAt = yield* Ref.make(0);

    const awaitSlot = Semaphore.withPermits(
      gate,
      1,
    )(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const scheduledAt = Math.max(now, yield* Ref.get(nextLaunchAt));
        yield* Ref.set(nextLaunchAt, scheduledAt + minTimeMs);
        if (scheduledAt > now) {
          yield* Effect.sleep(Duration.millis(scheduledAt - now));
        }
      }),
    );

    return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(awaitSlot, () => effect);
  });
}
