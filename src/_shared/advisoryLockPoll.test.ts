import { describe, expect, it } from "bun:test";
import { pollForAdvisoryLock } from "./advisoryLockPoll";

function acquirerFailing(times: number): {
  tryAcquire: () => Promise<boolean>;
  calls: () => number;
} {
  let attempts = 0;
  return {
    tryAcquire: async () => {
      attempts++;
      return attempts > times;
    },
    calls: () => attempts,
  };
}

describe("pollForAdvisoryLock", () => {
  it("returns immediately when the lock is free", async () => {
    const { tryAcquire, calls } = acquirerFailing(0);

    await pollForAdvisoryLock(tryAcquire, { pollIntervalMs: 0 });

    expect(calls()).toBe(1);
  });

  it("retries until the holder releases, as pg_advisory_lock would", async () => {
    const { tryAcquire, calls } = acquirerFailing(3);
    const contended: number[] = [];

    await pollForAdvisoryLock(tryAcquire, {
      pollIntervalMs: 0,
      onContended: (attempt) => contended.push(attempt),
    });

    expect(calls()).toBe(4);
    expect(contended).toEqual([1, 2, 3]);
  });

  it("gives up once the deadline passes instead of waiting forever", async () => {
    const { tryAcquire, calls } = acquirerFailing(Number.MAX_SAFE_INTEGER);
    // A clock that jumps past the deadline after the first failed attempt, so a
    // permanently held lock terminates rather than pinning the vacuum horizon.
    let clock = 0;
    const now = () => {
      clock += 30_000;
      return clock;
    };

    await expect(
      pollForAdvisoryLock(tryAcquire, {
        pollIntervalMs: 0,
        maxWaitMs: 10_000,
        description: "the indexer lock for chain ID 46630",
        now,
      }),
    ).rejects.toThrow(/indexer lock for chain ID 46630/);

    expect(calls()).toBe(1);
  });
});
