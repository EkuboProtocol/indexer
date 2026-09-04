import { expect, test } from "bun:test";
import { Duration, Effect, Fiber, References, Stream } from "effect";
import { TestClock } from "effect/testing";
import { PriceSyncError } from "./errors";
import type { PriceSyncJob, PriceUpdate } from "./fetchers/types";
import { expirationLoop, jobLoop, partitionEnabled } from "./worker";
import type { PriceSyncSql } from "./worker";

const INTERVAL_MS = 2_000;

// None of these tests reach the write path -- the batches are empty or the
// cycle fails first -- so the driver is never called.
const unusedSql = (() => Promise.resolve([])) as unknown as PriceSyncSql;

type Behavior = "fail" | "die" | "succeed";

function countingJob(behavior: Behavior, probe: { attempts: number }) {
  const job: PriceSyncJob = {
    chainIds: [1n],
    source: "tst",
    intervalMs: INTERVAL_MS,
    fetch: Stream.unwrap(
      Effect.sync(() => {
        probe.attempts += 1;
        switch (behavior) {
          case "fail":
            return Stream.fail(
              new PriceSyncError({
                source: "tst",
                operation: "fetch prices",
                cause: new Error("boom"),
              }),
            );
          case "die":
            return Stream.die(new Error("splat"));
          case "succeed":
            return Stream.fromArray([[] as readonly PriceUpdate[]]);
        }
      }),
    ),
  };
  return job;
}

// Errors are the point of these tests, so keep their log lines out of the
// runner's output.
const silenced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, References.MinimumLogLevel, "None");

function runLoop(behavior: Behavior, forMs: number) {
  const probe = { attempts: 0 };

  return Effect.runPromise(
    Effect.provide(
      silenced(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            jobLoop(unusedSql, countingJob(behavior, probe)),
          );
          yield* TestClock.adjust(Duration.millis(forMs));

          const running = fiber.pollUnsafe() === undefined;
          yield* Fiber.interrupt(fiber);

          // Nothing may run after the interrupt.
          const afterInterrupt = probe.attempts;
          yield* TestClock.adjust(Duration.millis(forMs));

          return {
            attempts: probe.attempts,
            running,
            ranAfterInterrupt: probe.attempts > afterInterrupt,
          };
        }),
      ),
      TestClock.layer(),
    ),
  );
}

test("a cycle that fails every time does not retire the job", async () => {
  // `Effect.repeat` stops on the first failure, so a job whose errors were not
  // absorbed inside the cycle would run exactly once and then go quiet for the
  // life of the process -- with nothing in the logs to say the source is gone.
  const result = await runLoop("fail", 10 * INTERVAL_MS);

  expect(result.attempts).toBe(11);
  expect(result.running).toBe(true);
  expect(result.ranAfterInterrupt).toBe(false);
});

test("a cycle that dies with a defect does not retire the job", async () => {
  const result = await runLoop("die", 10 * INTERVAL_MS);

  expect(result.attempts).toBe(11);
  expect(result.running).toBe(true);
});

test("a healthy job recurs once per interval", async () => {
  const result = await runLoop("succeed", 10 * INTERVAL_MS);

  expect(result.attempts).toBe(11);
  expect(result.running).toBe(true);
});

test("an overrunning cycle catches up instead of falling further behind", async () => {
  // Bottleneck spaced launches rather than the gaps between them, and
  // `Schedule.fixed` preserves that: a cycle longer than the interval must not
  // push the schedule out by its own duration on every pass.
  //
  // The one difference from `{maxConcurrent: 1, minTime}` is the transition:
  // `fixed` waits to the next interval boundary before it notices it is
  // behind, so the first overrun costs up to one extra interval. Every cycle
  // after that runs back to back, which is what Bottleneck did throughout.
  // Cycles take 50-500ms against a 60s interval in production, so this branch
  // is not reached there -- it is pinned here so a change to the schedule is
  // visible rather than silent.
  const launches: number[] = [];
  const job: PriceSyncJob = {
    chainIds: [1n],
    source: "tst",
    intervalMs: INTERVAL_MS,
    fetch: Stream.unwrap(
      Effect.gen(function* () {
        launches.push(yield* Effect.clockWith((clock) => clock.currentTimeMillis));
        // Three times the interval.
        yield* Effect.sleep(Duration.millis(3 * INTERVAL_MS));
        return Stream.fromArray([[] as readonly PriceUpdate[]]);
      }),
    ),
  };

  await Effect.runPromise(
    Effect.provide(
      silenced(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(jobLoop(unusedSql, job));
          yield* TestClock.adjust(Duration.millis(12 * INTERVAL_MS));
          yield* Fiber.interrupt(fiber);
        }),
      ),
      TestClock.layer(),
    ),
  );

  // Each cycle takes 6s against a 2s cadence, so the next launch is due the
  // moment the previous one lands rather than 2s later.
  const cycleMs = 3 * INTERVAL_MS;
  const gaps = launches.slice(1).map((at, ix) => at - launches[ix]);

  // One boundary wait, then back to back for the rest of the run.
  expect(gaps[0]).toBe(cycleMs + INTERVAL_MS);
  expect(gaps.slice(1)).toEqual(gaps.slice(1).map(() => cycleMs));
  expect(gaps.length).toBeGreaterThan(1);
});

test("the expiration loop keeps polling after a failed refresh", async () => {
  let calls = 0;
  const failingSql = (() => {
    calls += 1;
    return Promise.reject(new Error("connection refused"));
  }) as unknown as PriceSyncSql;

  const result = await Effect.runPromise(
    Effect.provide(
      silenced(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(expirationLoop(failingSql));
          yield* TestClock.adjust(Duration.seconds(5));
          const running = fiber.pollUnsafe() === undefined;
          yield* Fiber.interrupt(fiber);
          return { calls, running };
        }),
      ),
      TestClock.layer(),
    ),
  );

  // Once immediately, then once per second.
  expect(result.calls).toBe(6);
  expect(result.running).toBe(true);
});

test("one failing job does not take the others down with it", async () => {
  // The loops used to be independent promises under a `Promise.all`; they are
  // now fibers under one `Effect.forEach`, which short-circuits on failure.
  // Absorbing errors inside the cycle is what keeps that from turning a single
  // bad source into a worker-wide outage.
  const failing = { attempts: 0 };
  const healthy = { attempts: 0 };

  const result = await Effect.runPromise(
    Effect.provide(
      silenced(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            Effect.forEach(
              [
                jobLoop(unusedSql, countingJob("fail", failing)),
                jobLoop(unusedSql, countingJob("succeed", healthy)),
              ],
              (loop) => loop,
              { concurrency: "unbounded", discard: true },
            ),
          );

          yield* TestClock.adjust(Duration.millis(10 * INTERVAL_MS));
          const running = fiber.pollUnsafe() === undefined;
          yield* Fiber.interrupt(fiber);

          return { failing: failing.attempts, healthy: healthy.attempts, running };
        }),
      ),
      TestClock.layer(),
    ),
  );

  expect(result.failing).toBe(11);
  expect(result.healthy).toBe(11);
  expect(result.running).toBe(true);
});

test("partitionEnabled drops jobs whose interval is zero", async () => {
  const enabled = countingJob("succeed", { attempts: 0 });
  const disabled: PriceSyncJob = { ...enabled, source: "off", intervalMs: 0 };

  const kept = await Effect.runPromise(
    silenced(partitionEnabled([enabled, disabled])),
  );

  expect(kept.map((job) => job.source)).toEqual(["tst"]);
});
