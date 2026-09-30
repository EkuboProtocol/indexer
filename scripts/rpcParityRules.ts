/**
 * Verdict rules for the RPC parity check (`rpcParity.ts`, EKU-527), kept free
 * of I/O so they can be tested.
 *
 * The parity check decides whether a candidate endpoint may sit in a chain's
 * `EVM_RPC_URL` list behind the primary. The failure that matters is the
 * silent one: a log query answered by a node that is behind, which returns
 * fewer events and no error. So every comparison here is exact, and a
 * difference that a reorg cannot explain fails the chain.
 */

export interface RawLog {
  address: string;
  blockHash: string;
  blockNumber: string;
  data: string;
  logIndex: string;
  removed?: boolean;
  topics: string[];
  transactionHash: string;
  transactionIndex: string;
}

export interface LogDiff {
  onlyPrimary: string[];
  onlyCandidate: string[];
  changed: string[];
}

const logKey = (log: RawLog) => `${BigInt(log.blockNumber)}:${BigInt(log.logIndex)}`;

/** Every field the indexer reads, normalised so hex case and padding do not count. */
function fingerprint(log: RawLog): string {
  return JSON.stringify([
    log.address.toLowerCase(),
    log.blockHash.toLowerCase(),
    log.data.toLowerCase(),
    log.topics.map((topic) => topic.toLowerCase()),
    log.transactionHash.toLowerCase(),
    BigInt(log.transactionIndex).toString(),
    Boolean(log.removed),
  ]);
}

export function diffLogs(primary: RawLog[], candidate: RawLog[]): LogDiff {
  const a = new Map(primary.map((log) => [logKey(log), fingerprint(log)]));
  const b = new Map(candidate.map((log) => [logKey(log), fingerprint(log)]));
  const diff: LogDiff = { onlyPrimary: [], onlyCandidate: [], changed: [] };
  for (const [key, print] of a) {
    if (!b.has(key)) diff.onlyPrimary.push(key);
    else if (b.get(key) !== print) diff.changed.push(key);
  }
  for (const key of b.keys()) if (!a.has(key)) diff.onlyCandidate.push(key);
  // Duplicates inside one response collapse in the map; count them as a change.
  if (a.size !== primary.length || b.size !== candidate.length) diff.changed.push("duplicate log keys");
  return diff;
}

export const isEmptyDiff = (diff: LogDiff) =>
  diff.onlyPrimary.length + diff.onlyCandidate.length + diff.changed.length === 0;

/**
 * A near-head read taken from the candidate, checked again once final.
 * `headHash` is what the candidate called block `head` when it answered;
 * `servedHash` is what it returned for that number straight after (null when it
 * did not have the block its own `latest` had just named).
 */
export interface HeadSample {
  head: number;
  headHash: string;
  servedHash: string | null;
  from: number;
  logs: RawLog[];
}

export type HeadOutcome = "match" | "reorg" | "mismatch";

/**
 * A head block that is not the final one was reorged out, and its logs may
 * differ legitimately. A head block that is final makes every block below it
 * final too (hash chain), so its logs must match exactly: a difference there
 * means the logs came from a different view of the chain than the head did.
 */
export function classifyHeadSample(
  sample: HeadSample,
  finalHash: string,
  finalLogs: RawLog[],
): { outcome: HeadOutcome; diff?: LogDiff } {
  if (sample.headHash.toLowerCase() !== finalHash.toLowerCase()) return { outcome: "reorg" };
  if (sample.servedHash === null || sample.servedHash.toLowerCase() !== finalHash.toLowerCase()) {
    return { outcome: "mismatch" };
  }
  const diff = diffLogs(finalLogs, sample.logs);
  return isEmptyDiff(diff) ? { outcome: "match" } : { outcome: "mismatch", diff };
}

/** Nearest-rank percentile of absolute values. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.map(Math.abs).sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export interface DriftSample {
  /** primary latest - candidate latest */
  blocks: number;
  /** primary latest timestamp - candidate latest timestamp */
  seconds: number;
}

/**
 * `latest` read from both at once. Blocks alone cannot be the limit on chains
 * with sub-second blocks, so a p95 inside either bound passes. The maximum is
 * reported, not gated: one slow response is not a lagging provider.
 */
export function evaluateDrift(
  samples: DriftSample[],
  limits: { maxBlocks: number; maxSeconds: number },
) {
  const p95Blocks = percentile(samples.map((s) => s.blocks), 95);
  const p95Seconds = percentile(samples.map((s) => s.seconds), 95);
  return {
    samples: samples.length,
    p95Blocks,
    p95Seconds,
    maxBlocks: percentile(samples.map((s) => s.blocks), 100),
    maxSeconds: percentile(samples.map((s) => s.seconds), 100),
    ok: samples.length > 0 && (p95Blocks <= limits.maxBlocks || p95Seconds <= limits.maxSeconds),
  };
}

/** One step of the result-cap probe: the same wide query to both endpoints. */
export interface CapProbe {
  blocks: number;
  primary: number | "error";
  candidate: number | "error";
}

/**
 * What `SUSPECT_LOG_COUNT` should be for the candidate. A count below the
 * primary's with no error is silent truncation, and that count is the cap the
 * stream must refuse at. Without one, the largest count the candidate returned
 * intact is only a lower bound, so the documented cap stands.
 */
export function recommendSuspectLogCount(probes: CapProbe[], documentedCap: number) {
  // Fewer logs than the primary, or -- once the primary refuses the span -- the
  // same count for a doubled span, which transfer volume never produces.
  const truncated = probes.find(
    (p, i) =>
      typeof p.candidate === "number" &&
      ((typeof p.primary === "number" && p.candidate < p.primary) ||
        (i > 0 && p.candidate >= 1_000 && probes[i - 1]!.candidate === p.candidate)),
  );
  const intact = probes
    .filter((p) => typeof p.candidate === "number" && p.candidate === p.primary)
    .map((p) => p.candidate as number);
  const largestIntact = intact.length ? Math.max(...intact) : 0;
  if (truncated) {
    return { suspectLogCount: truncated.candidate as number, silentTruncation: true, largestIntact };
  }
  return { suspectLogCount: documentedCap, silentTruncation: false, largestIntact };
}

export interface ParityReport {
  chainIdOk: boolean;
  finalized: { ok: boolean; detail: string };
  windows: { compared: number; eventBearing: number; failures: string[] };
  head: { reads: number; errors: number; match: number; reorg: number; mismatch: number; nonEmpty: number; timedOut: boolean };
  drift: ReturnType<typeof evaluateDrift>;
}

/**
 * An error is loud, so it is not the dangerous failure, but a secondary that
 * errors on most head polls cannot carry the indexer: the free tier answers
 * "Unknown block" for logs up to the head its own `latest` just named.
 */
export function verdict(report: ParityReport, maxHeadErrorPct = 5): { pass: boolean; reasons: string[] } {
  const { chainIdOk, finalized, windows, head, drift } = report;
  const checks: [failed: boolean, reason: string][] = [
    [!chainIdOk, "candidate serves a different chain id"],
    [!finalized.ok, `finalized tag: ${finalized.detail}`],
    [windows.eventBearing === 0, "no event-bearing eth_getLogs window compared"],
    [windows.failures.length > 0, `${windows.failures.length} eth_getLogs window(s) differ or failed`],
    [head.timedOut, "finality never reached the sampled heads; head reads unchecked"],
    [head.mismatch > 0, `${head.mismatch} near-head read(s) differ from the final chain`],
    [head.match + head.reorg + head.mismatch === 0, "no near-head reads checked"],
    [head.errors * 100 > head.reads * maxHeadErrorPct, `${head.errors} of ${head.reads} near-head reads errored (limit ${maxHeadErrorPct}%)`],
    [!drift.ok, `latest drift p95 ${drift.p95Blocks} blocks / ${drift.p95Seconds}s is over the limit`],
  ];
  const reasons = checks.filter(([failed]) => failed).map(([, reason]) => reason);
  return { pass: reasons.length === 0, reasons };
}
