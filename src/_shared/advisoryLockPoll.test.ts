import { describe, expect, it } from "bun:test";
import { pollForAdvisoryLock } from "./advisoryLockPoll";

function acquirerHeldFor(attempts: number): {
  tryAcquire: () => Promise<boolean>;
  calls: () => number;
} {
  let seen = 0;
  return {
    tryAcquire: async () => {
      seen++;
      return seen > attempts;
    },
    calls: () => seen,
  };
}

describe("pollForAdvisoryLock", () => {
  it("takes the lock immediately when it is free", async () => {
    const { tryAcquire, calls } = acquirerHeldFor(0);

    await pollForAdvisoryLock(tryAcquire, { pollIntervalMs: 0 });

    expect(calls()).toBe(1);
  });

  it("waits for the predecessor to exit, however long the handoff takes", async () => {
    // The deploy handoff is deliberate, so there is no deadline to give up at:
    // a newcomer keeps waiting until the outgoing instance releases the lock.
    const { tryAcquire, calls } = acquirerHeldFor(500);

    await pollForAdvisoryLock(tryAcquire, { pollIntervalMs: 0 });

    expect(calls()).toBe(501);
  });

  it("reports how long it has been waiting so a stuck handoff is visible", async () => {
    const { tryAcquire } = acquirerHeldFor(3);
    let clock = 1_000;
    const waits: number[] = [];

    await pollForAdvisoryLock(tryAcquire, {
      pollIntervalMs: 0,
      now: () => (clock += 5_000),
      onContended: (waitedMs) => waits.push(waitedMs),
    });

    // Elapsed is measured from the first call, not from zero.
    expect(waits).toEqual([5_000, 10_000, 15_000]);
  });
});
