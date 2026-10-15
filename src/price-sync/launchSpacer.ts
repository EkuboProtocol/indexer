import { Clock, Duration, Effect, Ref, Semaphore } from "effect";

export interface LaunchSpacer {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}

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
