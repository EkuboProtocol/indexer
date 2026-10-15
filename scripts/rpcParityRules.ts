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

const logKey = (log: RawLog) =>
  `${BigInt(log.blockNumber)}:${BigInt(log.logIndex)}`;

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
  if (a.size !== primary.length || b.size !== candidate.length)
    diff.changed.push("duplicate log keys");
  return diff;
}

export const isEmptyDiff = (diff: LogDiff) =>
  diff.onlyPrimary.length + diff.onlyCandidate.length + diff.changed.length ===
  0;

export interface HeadSample {
  head: number;
  headHash: string;
  servedHash: string | null;
  from: number;
  logs: RawLog[];
}

export type HeadOutcome = "match" | "reorg" | "mismatch";

export function classifyHeadSample(
  sample: HeadSample,
  finalHash: string,
  finalLogs: RawLog[],
): { outcome: HeadOutcome; diff?: LogDiff } {
  if (sample.servedHash === null) return { outcome: "mismatch" };
  if (sample.headHash.toLowerCase() !== finalHash.toLowerCase())
    return { outcome: "reorg" };
  if (sample.servedHash.toLowerCase() !== finalHash.toLowerCase())
    return { outcome: "mismatch" };
  const diff = diffLogs(finalLogs, sample.logs);
  return isEmptyDiff(diff)
    ? { outcome: "match" }
    : { outcome: "mismatch", diff };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.map(Math.abs).sort((x, y) => x - y);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]!;
}

export interface DriftSample {
  blocks: number;
  seconds: number;
}

export function evaluateDrift(
  samples: DriftSample[],
  limits: { maxBlocks: number; maxSeconds: number },
) {
  const p95Blocks = percentile(
    samples.map((s) => s.blocks),
    95,
  );
  const p95Seconds = percentile(
    samples.map((s) => s.seconds),
    95,
  );
  return {
    samples: samples.length,
    p95Blocks,
    p95Seconds,
    maxBlocks: percentile(
      samples.map((s) => s.blocks),
      100,
    ),
    maxSeconds: percentile(
      samples.map((s) => s.seconds),
      100,
    ),
    ok:
      samples.length > 0 &&
      (p95Blocks <= limits.maxBlocks || p95Seconds <= limits.maxSeconds),
  };
}

export interface CapProbe {
  blocks: number;
  primary: number | "error";
  candidate: number | "error";
}

export interface CapRecommendation {
  suspectLogCount: number;
  silentTruncation: "shortfall" | "plateau" | null;
  largestIntact: number;
}

export function recommendSuspectLogCount(
  probes: CapProbe[],
  documentedCap: number,
): CapRecommendation {
  const shortfall = probes.find(
    (p) =>
      typeof p.primary === "number" &&
      typeof p.candidate === "number" &&
      p.candidate < p.primary,
  );
  const plateau = probes.find(
    (p, i) =>
      typeof p.candidate === "number" &&
      p.candidate >= 1_000 &&
      i > 0 &&
      probes[i - 1]!.candidate === p.candidate,
  );
  const intact = probes
    .filter((p) => typeof p.candidate === "number" && p.candidate === p.primary)
    .map((p) => p.candidate as number);
  const largestIntact = intact.length ? Math.max(...intact) : 0;
  const truncated = shortfall ?? plateau;
  return {
    suspectLogCount: truncated
      ? (truncated.candidate as number)
      : documentedCap,
    silentTruncation: truncated ? (shortfall ? "shortfall" : "plateau") : null,
    largestIntact,
  };
}

export interface ParityReport {
  chainIdOk: boolean;
  finalized: { ok: boolean; detail: string };
  windows: { compared: number; eventBearing: number; failures: string[] };
  head: {
    reads: number;
    errors: number;
    match: number;
    reorg: number;
    mismatch: number;
    nonEmpty: number;
    timedOut: boolean;
  };
  drift: ReturnType<typeof evaluateDrift>;
  cap: CapRecommendation;
}

export function verdict(
  report: ParityReport,
  maxHeadErrorPct = 5,
): { pass: boolean; reasons: string[] } {
  const { chainIdOk, finalized, windows, head, drift, cap } = report;
  const checks: [failed: boolean, reason: string][] = [
    [!chainIdOk, "candidate serves a different chain id"],
    [!finalized.ok, `finalized tag: ${finalized.detail}`],
    [
      windows.eventBearing === 0,
      "no event-bearing eth_getLogs window compared",
    ],
    [
      windows.failures.length > 0,
      `${windows.failures.length} eth_getLogs window(s) differ or failed`,
    ],
    [
      head.timedOut,
      "finality never reached the sampled heads; head reads unchecked",
    ],
    [
      head.mismatch > 0,
      `${head.mismatch} near-head read(s) differ from the final chain`,
    ],
    [
      head.match + head.reorg + head.mismatch === 0,
      "no near-head reads checked",
    ],
    [
      head.errors * 100 > head.reads * maxHeadErrorPct,
      `${head.errors} of ${head.reads} near-head reads errored (limit ${maxHeadErrorPct}%)`,
    ],
    [
      cap.silentTruncation !== null,
      `silent eth_getLogs truncation (${cap.silentTruncation}) at ${cap.suspectLogCount} logs`,
    ],
    [
      !drift.ok,
      `latest drift p95 ${drift.p95Blocks} blocks / ${drift.p95Seconds}s is over the limit`,
    ],
  ];
  const reasons = checks
    .filter(([failed]) => failed)
    .map(([, reason]) => reason);
  return { pass: reasons.length === 0, reasons };
}
