import { expect, test } from "bun:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeLaunchSpacer } from "./launchSpacer";

const MIN_TIME_MS = 1_000;

// Records when the wrapped effect actually starts, which is the only thing the
// spacer controls -- it deliberately does not bound how many run at once.
const launchAt = (launches: number[]) =>
  Effect.gen(function* () {
    launches.push(yield* Effect.clockWith((clock) => clock.currentTimeMillis));
  });

test("concurrent callers launch one per minTime", async () => {
  const launches: number[] = [];

  const program = Effect.gen(function* () {
    const spacer = yield* makeLaunchSpacer(MIN_TIME_MS);
    const fibers = yield* Effect.forEach(
      [0, 1, 2],
      () => Effect.forkChild(spacer(launchAt(launches))),
    );

    yield* TestClock.adjust(Duration.millis(5 * MIN_TIME_MS));
    yield* Fiber.joinAll(fibers);
    return launches;
  });

  const result = await Effect.runPromise(
    Effect.provide(program, TestClock.layer()),
  );

  expect(result).toEqual([0, MIN_TIME_MS, 2 * MIN_TIME_MS]);
});

test("a caller arriving after an idle gap does not wait", async () => {
  // The budget is a rate, not a queue: once the spacing has elapsed with
  // nobody asking, the next request goes out immediately rather than being
  // held to a stale slot.
  const launches: number[] = [];

  const program = Effect.gen(function* () {
    const spacer = yield* makeLaunchSpacer(MIN_TIME_MS);

    yield* spacer(launchAt(launches));
    yield* TestClock.adjust(Duration.millis(30 * MIN_TIME_MS));
    yield* spacer(launchAt(launches));

    return launches;
  });

  const result = await Effect.runPromise(
    Effect.provide(program, TestClock.layer()),
  );

  expect(result).toEqual([0, 30 * MIN_TIME_MS]);
});

test("the spacer caps the rate without capping concurrency", async () => {
  // The quoter fans out over every token with TVL and relies on the requests
  // overlapping; a semaphore would instead serialize them and stretch a cycle
  // to the sum of its quotes.
  let inFlight = 0;
  let maxInFlight = 0;

  const slowRequest = Effect.gen(function* () {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    yield* Effect.sleep(Duration.millis(10 * MIN_TIME_MS));
    inFlight -= 1;
  });

  const program = Effect.gen(function* () {
    const spacer = yield* makeLaunchSpacer(MIN_TIME_MS);
    const fibers = yield* Effect.forEach(
      [0, 1, 2, 3],
      () => Effect.forkChild(spacer(slowRequest)),
    );

    yield* TestClock.adjust(Duration.millis(20 * MIN_TIME_MS));
    yield* Fiber.joinAll(fibers);
    return maxInFlight;
  });

  const result = await Effect.runPromise(
    Effect.provide(program, TestClock.layer()),
  );

  expect(result).toBe(4);
});
