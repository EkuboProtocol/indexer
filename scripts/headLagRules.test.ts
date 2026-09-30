import { describe as group, expect, it } from "bun:test";
import {
  describe,
  evaluate,
  evaluateFailure,
  markAlerted,
  parseChains,
  type CursorRow,
  type HeadLagConfig,
  type HeadLagState,
} from "./headLagRules";

const config: HeadLagConfig = {
  chains: parseChains("1=eth,130=unichain,4663=rhc:600,999=retired:off"),
  defaultThresholdSeconds: 300,
  sustainChecks: 2,
  realertMs: 60 * 60_000,
};

const row = (chainId: string, lagSeconds: number | null, updatedSecondsAgo = lagSeconds ?? 0): CursorRow => ({
  chainId, headBlockNumber: "100", lagSeconds, updatedSecondsAgo,
});

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 30, 13, minutes));

/** Runs checks one minute apart, delivering every alert, and returns what each raised. */
function replay(checks: CursorRow[][], start: HeadLagState = {}) {
  let state = start;
  return checks.map((rows, minute) => {
    const now = at(minute);
    const { findings, next } = evaluate(rows, config, state, now);
    state = markAlerted(next, findings, now);
    return findings.map((f) => (f.kind === "head_lag" ? f.name : f.kind));
  });
}

const healthy = [row("1", 12), row("130", 3), row("4663", 1)];

group("head-lag rules", () => {
  it("parses per-chain thresholds and off switches", () => {
    expect(config.chains.get("4663")).toEqual({ name: "rhc", thresholdSeconds: 600 });
    expect(config.chains.get("1")).toEqual({ name: "eth" });
    expect(config.chains.get("999")).toEqual({ name: "retired", thresholdSeconds: "off" });
    expect(() => parseChains("eth")).toThrow(/chainId=name/);
  });

  it("stays quiet on live chains", () => {
    expect(replay([healthy, healthy, healthy])).toEqual([[], [], []]);
  });

  // The 2026-09-30 Alchemy US-East incident: heads froze at 13:12 and the
  // chains were back by 13:28. Unichain's worker saw no error at all.
  it("alerts once the stall is sustained, not on every minute of it", () => {
    const stalled = (minutes: number) => [row("1", 12), row("130", minutes * 60), row("4663", 1)];
    const raised = replay([
      healthy,
      ...Array.from({ length: 16 }, (_, m) => stalled(m + 1)),
      healthy,
    ]);
    // Over five minutes from the 6th stalled minute, sustained on the 7th.
    expect(raised.findIndex((r) => r.length > 0)).toBe(7);
    expect(raised.flat()).toEqual(["unichain"]);
  });

  it("does not alert on a single slow check", () => {
    expect(replay([healthy, [row("1", 400), row("130", 3), row("4663", 1)], healthy])).toEqual([[], [], []]);
  });

  it("honours per-chain thresholds and ignores chains turned off", () => {
    const slowRhc = [row("1", 12), row("130", 3), row("4663", 500), row("999", 1e6)];
    expect(replay([slowRhc, slowRhc])).toEqual([[], []]);
  });

  it("checks chains nobody listed at the default threshold", () => {
    const withNew = [...healthy, row("8453", 900)];
    expect(replay([withNew, withNew])).toEqual([[], ["chain-8453"]]);
  });

  it("treats a listed chain missing from indexer_cursor as stale", () => {
    const missing = [row("1", 12), row("4663", 1)];
    const { findings } = evaluate(missing, config, { chains: { "130": { breaches: 1 } } }, at(0));
    expect(findings).toMatchObject([{ kind: "head_lag", chainId: "130", lagSeconds: null }]);
    expect(describe(findings[0]!)).toContain("no indexer_cursor row");
  });

  it("falls back to last_updated when the head was reset", () => {
    const { results } = evaluate([row("1", null, 42)], config, {}, at(0));
    expect(results.find((r) => r.chainId === "1")?.lagSeconds).toBe(42);
  });

  it("re-alerts an ongoing stall hourly, and afresh after recovery", () => {
    const stalled = [row("1", 12), row("130", 900), row("4663", 1)];
    const raised = replay([
      ...Array(62).fill(stalled),
      healthy,
      stalled,
      stalled,
    ]);
    const alertMinutes = raised.flatMap((r, minute) => (r.length > 0 ? [minute] : []));
    expect(alertMinutes).toEqual([1, 61, 64]);
  });

  it("does not mark an undelivered alert, so the next run raises it again", () => {
    const stalled = [row("1", 12), row("130", 900), row("4663", 1)];
    const first = evaluate(stalled, config, { chains: { "130": { breaches: 1 } } }, at(0));
    const second = evaluate(stalled, config, first.next, at(1));
    expect(second.findings).toHaveLength(1);
  });

  it("alerts when the check itself fails twice in a row", () => {
    let state: HeadLagState = {};
    const first = evaluateFailure("connect ECONNREFUSED", config, state, at(0));
    expect(first.findings).toEqual([]);
    state = first.next;
    const second = evaluateFailure("connect ECONNREFUSED", config, state, at(1));
    expect(second.findings).toMatchObject([{ kind: "check_failed", failures: 2 }]);
    state = markAlerted(second.next, second.findings, at(1));
    expect(evaluateFailure("again", config, state, at(2)).findings).toEqual([]);
    // One good check clears the failure streak.
    expect(evaluate(healthy, config, state, at(3)).next.checkFailures).toBeUndefined();
  });

  it("keeps chain streaks across a failed check", () => {
    const stalled = [row("1", 12), row("130", 900), row("4663", 1)];
    const first = evaluate(stalled, config, {}, at(0));
    const failed = evaluateFailure("timeout", config, first.next, at(1));
    expect(evaluate(stalled, config, failed.next, at(2)).findings).toHaveLength(1);
  });
});
