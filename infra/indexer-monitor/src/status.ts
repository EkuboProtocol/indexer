/**
 * State and answers of the off-host indexer monitor (docs/INDEXER-MONITOR.md),
 * kept free of Cloudflare types so they can be tested with Bun.
 *
 * The production monitor (`scripts/productionMonitor.ts`) runs inside the
 * indexer's App Platform app and posts two kinds of report here: head lag every
 * minute and an event-gap audit about every 30 minutes. Two Cloudflare Health
 * Checks read the answers, and the zone's notification policy emails the owner
 * on each status change. That gives one email when an episode starts and one
 * when it ends, with nothing running on the workstation or in Paperclip.
 *
 * - `/observations` fails only on a positive observation: a chain whose head
 *   was over its threshold on two consecutive checks, or a finalized
 *   event-bearing block missing or stored under another hash. A failed or
 *   missing check never opens or clears it; only a later definitive check of
 *   the same chain does.
 * - `/monitor` fails when telemetry is missing: no definitive head-lag reading
 *   in the last five minutes (killed worker, failing database read, lost
 *   network), or a chain with no definitive gap audit in the allowed age.
 *   Its body says which, so a read failure can be told apart from silence.
 */

export const HEAD_MAX_AGE_MS = 5 * 60_000;
export const GAP_MAX_AGE_MS = 75 * 60_000;
/** Reports dated further ahead than this are refused as a clock fault. */
export const MAX_FUTURE_MS = 60_000;

export type HeadLagReport =
  | {
      kind: "head-lag";
      at: number;
      ok: true;
      chains: string[];
      lagging: string[];
    }
  | { kind: "head-lag"; at: number; ok: false; error: "read_failed" };

export type GapOutcome = "ok" | "gap" | "check_failed";

export type GapReport = {
  kind: "event-gaps";
  at: number;
  chains: { chain: string; outcome: GapOutcome }[];
};

export type Report = HeadLagReport | GapReport;

type ChainObservation = { at: number; fault: boolean };

export type State = {
  head: {
    reportAt?: number;
    readFailedAt?: number;
    chains: Record<string, ChainObservation>;
  };
  gaps: Record<string, ChainObservation & { failedAt?: number }>;
};

export type Expected = { headChains: string[]; gapChains: string[] };

export const emptyState = (): State => ({ head: { chains: {} }, gaps: {} });

const NAME = /^[a-z0-9][a-z0-9/._-]{0,63}$/;
const MAX_CHAINS = 64;

function names(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CHAINS) return undefined;
  return value.every((name) => typeof name === "string" && NAME.test(name))
    ? (value as string[])
    : undefined;
}

function headReport(body: Record<string, unknown>, at: number): Report | null {
  if (body.ok === false)
    return body.error === "read_failed"
      ? { kind: "head-lag", at, ok: false, error: "read_failed" }
      : null;
  const chains = names(body.chains);
  const lagging = names(body.lagging);
  if (body.ok !== true || !chains || !lagging) return null;
  if (!lagging.every((name) => chains.includes(name))) return null;
  return { kind: "head-lag", at, ok: true, chains, lagging };
}

const OUTCOMES = new Set<unknown>(["ok", "gap", "check_failed"]);

function gapReport(body: Record<string, unknown>, at: number): Report | null {
  const { chains } = body;
  if (!Array.isArray(chains) || chains.length > MAX_CHAINS) return null;
  const parsed: GapReport["chains"] = [];
  for (const entry of chains as unknown[]) {
    const { chain, outcome } = (entry ?? {}) as Record<string, unknown>;
    if (typeof chain !== "string" || !NAME.test(chain)) return null;
    if (!OUTCOMES.has(outcome)) return null;
    parsed.push({ chain, outcome: outcome as GapOutcome });
  }
  return { kind: "event-gaps", at, chains: parsed };
}

/**
 * Validates a posted report. The time is the receiver's, not the sender's:
 * staleness must not depend on the monitor host's clock.
 */
export function parseReport(value: unknown, now: number): Report | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body.kind === "head-lag") return headReport(body, now);
  if (body.kind === "event-gaps") return gapReport(body, now);
  return null;
}

function applyHead(state: State, report: HeadLagReport): State {
  if (!report.ok)
    return { ...state, head: { ...state.head, readFailedAt: report.at } };
  const chains: Record<string, ChainObservation> = {};
  for (const name of report.chains)
    chains[name] = { at: report.at, fault: report.lagging.includes(name) };
  return { ...state, head: { reportAt: report.at, chains } };
}

function applyGaps(state: State, report: GapReport): State {
  const gaps = { ...state.gaps };
  for (const { chain, outcome } of report.chains) {
    const previous = gaps[chain];
    gaps[chain] =
      outcome === "check_failed"
        ? {
            at: previous?.at ?? 0,
            fault: previous?.fault ?? false,
            failedAt: report.at,
          }
        : { at: report.at, fault: outcome === "gap" };
  }
  return { ...state, gaps };
}

export function apply(state: State, report: Report): State {
  return report.kind === "head-lag"
    ? applyHead(state, report)
    : applyGaps(state, report);
}

export type Answer = { status: 200 | 503; body: string };

export function observations(state: State, expected: Expected): Answer {
  const lagging = expected.headChains.filter(
    (name) => state.head.chains[name]?.fault,
  );
  const gaps = expected.gapChains.filter((name) => state.gaps[name]?.fault);
  if (lagging.length === 0 && gaps.length === 0)
    return { status: 200, body: "indexer-no-observed-fault" };
  const parts = [
    lagging.length ? `head-lag=${lagging.join(",")}` : "",
    gaps.length ? `event-gap=${gaps.join(",")}` : "",
  ].filter(Boolean);
  return { status: 503, body: `indexer-observed-fault ${parts.join(" ")}` };
}

const fresh = (at: number | undefined, now: number, maxAge: number) =>
  at !== undefined && at > 0 && now - at < maxAge;

function headProblem(state: State, expected: Expected, now: number) {
  const { head } = state;
  if (fresh(head.reportAt, now, HEAD_MAX_AGE_MS)) {
    const missing = expected.headChains.filter((name) => !head.chains[name]);
    return missing.length ? `head-lag=unconfigured:${missing.join(",")}` : "";
  }
  return (head.readFailedAt ?? 0) > (head.reportAt ?? 0) &&
    fresh(head.readFailedAt, now, HEAD_MAX_AGE_MS)
    ? "head-lag=read-failing"
    : "head-lag=no-report";
}

function gapProblem(state: State, expected: Expected, now: number) {
  const stale = expected.gapChains.filter(
    (name) => !fresh(state.gaps[name]?.at, now, GAP_MAX_AGE_MS),
  );
  if (stale.length === 0) return "";
  const failing = stale.filter((name) => {
    const failedAt = state.gaps[name]?.failedAt;
    return fresh(failedAt, now, GAP_MAX_AGE_MS);
  });
  const silent = stale.filter((name) => !failing.includes(name));
  return [
    failing.length ? `event-gap=check-failing:${failing.join(",")}` : "",
    silent.length ? `event-gap=no-report:${silent.join(",")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function monitor(state: State, expected: Expected, now: number): Answer {
  const problems = [
    headProblem(state, expected, now),
    gapProblem(state, expected, now),
  ].filter(Boolean);
  return problems.length
    ? { status: 503, body: `indexer-monitor-unavailable ${problems.join(" ")}` }
    : { status: 200, body: "indexer-monitor-current" };
}

/** Constant-time comparison of two equal-length digests. */
export function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
