/**
 * The minimal reports `productionMonitor.ts` sends off the production network
 * (docs/INDEXER-MONITOR.md), kept free of I/O so they can be tested. Only chain
 * names and verdicts leave: no block numbers, hashes, errors, RPC URLs or
 * database detail, which stay in the worker's own logs.
 */
import type { Result } from "./eventGapAudit";
import type { ChainResult } from "./headLagRules";

export type HeadLagReport =
  | { kind: "head-lag"; ok: true; chains: string[]; lagging: string[] }
  | { kind: "head-lag"; ok: false; error: "read_failed" };

export type GapReport = {
  kind: "event-gaps";
  chains: { chain: string; outcome: "ok" | "gap" | "check_failed" }[];
};

/**
 * A chain is lagging once it has been over its threshold on `sustainChecks`
 * consecutive checks, the same rule as the workstation monitor, but without
 * its hourly re-alert throttle: the receiver keeps the episode open until a
 * check sees the chain under threshold, and its Health Check emails only on
 * the transitions.
 */
export function headLagReport(
  results: ChainResult[],
  sustainChecks: number,
): HeadLagReport {
  return {
    kind: "head-lag",
    ok: true,
    chains: results.map((r) => r.name),
    lagging: results
      .filter((r) => r.over && r.breaches >= sustainChecks)
      .map((r) => r.name),
  };
}

export function gapReport(results: Result[]): GapReport {
  return {
    kind: "event-gaps",
    chains: results.map((r) => ({
      chain: r.network,
      outcome: r.ok ? "ok" : r.gap ? "gap" : "check_failed",
    })),
  };
}

/** Milliseconds to wait so cycles start `intervalMs` apart, never overlapping. */
export function delayUntilNext(
  startedAt: number,
  now: number,
  intervalMs: number,
): number {
  return Math.max(0, startedAt + intervalMs - now);
}
