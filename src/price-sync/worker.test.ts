import { expect, test } from "bun:test";
import { Duration, Effect, Fiber, References, Stream } from "effect";
import { TestClock } from "effect/testing";
import { PriceSyncError } from "./errors";
import type { PriceSyncJob, PriceUpdate } from "./fetchers/types";
import {
  expirationLoop,
  firstLaunchDelayMs,
  jobLoop,
  partitionEnabled,
} from "./worker";
import type { PriceSyncSql } from "./worker";

const INTERVAL_MS = 2_000;

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
  const launches: number[] = [];
  const job: PriceSyncJob = {
    chainIds: [1n],
    source: "tst",
    intervalMs: INTERVAL_MS,
    fetch: Stream.unwrap(
      Effect.gen(function* () {
        launches.push(
          yield* Effect.clockWith((clock) => clock.currentTimeMillis),
        );
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

  const cycleMs = 3 * INTERVAL_MS;
  const gaps = launches.slice(1).map((at, ix) => at - launches[ix]);

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

  expect(result.calls).toBe(6);
  expect(result.running).toBe(true);
});

test("one failing job does not take the others down with it", async () => {
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

          return {
            failing: failing.attempts,
            healthy: healthy.attempts,
            running,
          };
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

function launchTimes(
  lookup: () => Promise<unknown>,
  forMs: number,
  resumeFromLastRun = true,
) {
  const launches: number[] = [];
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    return lookup();
  }) as unknown as PriceSyncSql;
  const job: PriceSyncJob = {
    chainIds: [1n, 10n],
    source: "tst",
    intervalMs: INTERVAL_MS,
    resumeFromLastRun,
    fetch: Stream.unwrap(
      Effect.gen(function* () {
        launches.push(
          yield* Effect.clockWith((clock) => clock.currentTimeMillis),
        );
        return Stream.fromArray([[] as readonly PriceUpdate[]]);
      }),
    ),
  };

  return Effect.runPromise(
    Effect.provide(
      silenced(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(jobLoop(sql, job));
          yield* TestClock.adjust(Duration.millis(forMs));
          yield* Fiber.interrupt(fiber);
          return { launches, queries };
        }),
      ),
      TestClock.layer(),
    ),
  );
}

const storedAt = (ms: number) => () =>
  Promise.resolve([{ last: new Date(ms) }]);

test("a restart waits out the rest of the interval since the last stored price", async () => {
  const { launches, queries } = await launchTimes(
    storedAt(-500),
    3 * INTERVAL_MS,
  );

  expect(launches).toEqual([1_500, 3_500, 5_500]);
  expect(queries).toHaveLength(1);
});

test("a stale stored price launches at once", async () => {
  const { launches } = await launchTimes(
    storedAt(-10 * INTERVAL_MS),
    2 * INTERVAL_MS,
  );

  expect(launches).toEqual([0, 2_000, 4_000]);
});

test("no stored price launches at once", async () => {
  const { launches } = await launchTimes(
    () => Promise.resolve([{ last: null }]),
    2 * INTERVAL_MS,
  );

  expect(launches).toEqual([0, 2_000, 4_000]);
});

test("a failed lookup launches at once and keeps the job running", async () => {
  const { launches } = await launchTimes(
    () => Promise.reject(new Error("connection refused")),
    2 * INTERVAL_MS,
  );

  expect(launches).toEqual([0, 2_000, 4_000]);
});

test("a job that does not opt in launches at once without a lookup", async () => {
  const { launches, queries } = await launchTimes(
    storedAt(-500),
    2 * INTERVAL_MS,
    false,
  );

  expect(launches).toEqual([0, 2_000, 4_000]);
  expect(queries).toHaveLength(0);
});

test("firstLaunchDelayMs never waits longer than one interval", () => {
  expect(firstLaunchDelayMs(undefined, 1_000, 60_000)).toBe(0);
  expect(firstLaunchDelayMs(Number.NaN, 1_000, 60_000)).toBe(0);
  expect(firstLaunchDelayMs(0, 1_000, 60_000)).toBe(59_000);
  expect(firstLaunchDelayMs(0, 60_000, 60_000)).toBe(0);
  expect(firstLaunchDelayMs(0, 120_000, 60_000)).toBe(0);
  expect(firstLaunchDelayMs(1_000_000, 0, 60_000)).toBe(60_000);
});
