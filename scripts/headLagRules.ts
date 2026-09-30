/**
 * Alert rules for the head-freshness monitor (`monitorHeadLag.ts`, EKU-502),
 * kept free of I/O so they can be replayed and tested.
 *
 * Lag is `now() - indexer_cursor.head_block_time`, both read from the database
 * so the monitor host's clock does not matter. It is chain time, not write
 * time, on purpose: in the 2026-09-30 Alchemy incident Unichain's provider
 * froze its `latest` block, and the worker kept polling quietly without an
 * error. Its cursor row was not moving, but a frozen head that the worker did
 * keep re-writing would look fresh by `last_updated`; only the block time shows
 * the chain has stopped reaching us. `last_updated` stands in only where the
 * head is unknown (`reset_indexer_cursor` clears it).
 *
 * Kinds:
 * - `head_lag`: a chain's lag has been over its threshold on `sustainChecks`
 *   consecutive checks. A chain named in the config but missing from
 *   `indexer_cursor` counts as over.
 * - `check_failed`: the check itself failed on `sustainChecks` consecutive runs.
 *
 * Each finding is re-raised at most once per `realertMs` while it persists, so
 * a routine whose alert issue was already closed hears about an outage that is
 * still going on without being paged every minute. A chain drops out of its
 * episode as soon as one check sees it under threshold.
 */

/** A missing threshold inherits the default; `off` stops checking the chain. */
export type ChainConfig = { name: string; thresholdSeconds?: number | "off" };

export type HeadLagConfig = {
  /** Keyed by chain ID. */
  chains: Map<string, ChainConfig>;
  defaultThresholdSeconds: number;
  sustainChecks: number;
  realertMs: number;
};

export type CursorRow = {
  chainId: string;
  headBlockNumber: string | null;
  /** Seconds between the database's `now()` and the head's block time. */
  lagSeconds: number | null;
  /** Seconds since the cursor row was last written. */
  updatedSecondsAgo: number;
};

export type ChainState = { breaches: number; alertedAt?: string };

export type HeadLagState = {
  chains?: Record<string, ChainState>;
  checkFailures?: number;
  checkFailedAlertedAt?: string;
};

export type ChainResult = {
  chainId: string;
  name: string;
  thresholdSeconds: number;
  lagSeconds: number | null;
  headBlockNumber: string | null;
  over: boolean;
  breaches: number;
};

export type Finding =
  | {
      kind: "head_lag";
      chainId: string;
      name: string;
      lagSeconds: number | null;
      thresholdSeconds: number;
      breaches: number;
      headBlockNumber: string | null;
    }
  | { kind: "check_failed"; failures: number; error: string };

/**
 * Parses `HEAD_LAG_CHAINS`: comma-separated `chainId=name[:thresholdSeconds|off]`.
 */
export function parseChains(raw: string): Map<string, ChainConfig> {
  const chains = new Map<string, ChainConfig>();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const match = /^(\d+)=([\w.-]+)(?::(\d+|off))?$/.exec(entry);
    if (!match) {
      throw new Error(`HEAD_LAG_CHAINS entry must be chainId=name[:seconds|off], got ${entry}`);
    }
    const [, chainId, name, threshold] = match;
    chains.set(chainId!, {
      name: name!,
      ...(threshold === undefined ? {} : { thresholdSeconds: threshold === "off" ? "off" : Number(threshold) }),
    });
  }
  return chains;
}

function thresholdFor(config: HeadLagConfig, chainId: string): number | null {
  const configured = config.chains.get(chainId)?.thresholdSeconds;
  if (configured === "off") return null;
  return configured ?? config.defaultThresholdSeconds;
}

function due(alertedAt: string | undefined, now: Date, realertMs: number): boolean {
  return alertedAt === undefined || now.getTime() - Date.parse(alertedAt) >= realertMs;
}

/** The chain's lag, or null when it has no cursor row at all. */
function lagOf(row: CursorRow | undefined): number | null {
  if (!row) return null;
  return row.lagSeconds ?? row.updatedSecondsAgo;
}

/** The streak, and the last alert while the chain is still in the same episode. */
function nextChainState(over: boolean, previous: ChainState | undefined): ChainState {
  if (!over) return { breaches: 0 };
  const breaches = (previous?.breaches ?? 0) + 1;
  return previous?.alertedAt ? { breaches, alertedAt: previous.alertedAt } : { breaches };
}

/** One chain's result, its carried-over state, and its finding when one is due. */
function checkChain(
  chainId: string,
  threshold: number,
  row: CursorRow | undefined,
  config: HeadLagConfig,
  previous: ChainState | undefined,
  now: Date,
): { result: ChainResult; chainState: ChainState; finding: Finding | null } {
  const lagSeconds = lagOf(row);
  const headBlockNumber = row?.headBlockNumber ?? null;
  const over = lagSeconds === null || lagSeconds > threshold;
  const chainState = nextChainState(over, previous);
  const { breaches } = chainState;
  const name = config.chains.get(chainId)?.name ?? `chain-${chainId}`;

  const finding: Finding | null =
    breaches >= config.sustainChecks && due(chainState.alertedAt, now, config.realertMs)
      ? { kind: "head_lag", chainId, name, lagSeconds, thresholdSeconds: threshold, breaches, headBlockNumber }
      : null;

  return {
    result: { chainId, name, thresholdSeconds: threshold, lagSeconds, headBlockNumber, over, breaches },
    chainState,
    finding,
  };
}

/**
 * Evaluates one successful check. Every chain in the database is checked --
 * a chain added to the indexer is covered before anyone remembers to list it --
 * and every configured chain must be present.
 */
export function evaluate(
  rows: CursorRow[],
  config: HeadLagConfig,
  state: HeadLagState,
  now: Date,
): { results: ChainResult[]; findings: Finding[]; next: HeadLagState } {
  const byChain = new Map(rows.map((row) => [row.chainId, row]));
  const chainIds = [...new Set([...config.chains.keys(), ...byChain.keys()])].sort(
    (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
  );

  const results: ChainResult[] = [];
  const findings: Finding[] = [];
  const chains: Record<string, ChainState> = {};

  for (const chainId of chainIds) {
    const threshold = thresholdFor(config, chainId);
    if (threshold === null) continue;
    const checked = checkChain(chainId, threshold, byChain.get(chainId), config, state.chains?.[chainId], now);
    results.push(checked.result);
    chains[chainId] = checked.chainState;
    if (checked.finding) findings.push(checked.finding);
  }

  return { results, findings, next: { chains } };
}

/** Evaluates a run whose check could not complete. Chain streaks are kept. */
export function evaluateFailure(
  error: string,
  config: HeadLagConfig,
  state: HeadLagState,
  now: Date,
): { findings: Finding[]; next: HeadLagState } {
  const failures = (state.checkFailures ?? 0) + 1;
  const next: HeadLagState = { ...state, checkFailures: failures };
  // Bounded: a driver error can be arbitrarily long, and it goes into the
  // webhook body and the alert issue verbatim.
  const findings: Finding[] =
    failures >= config.sustainChecks && due(state.checkFailedAlertedAt, now, config.realertMs)
      ? [{ kind: "check_failed", failures, error: error.slice(0, 500) }]
      : [];
  return { findings, next };
}

/** Marks delivered findings so they are not re-raised before `realertMs`. */
export function markAlerted(state: HeadLagState, findings: Finding[], now: Date): HeadLagState {
  const next: HeadLagState = { ...state, chains: { ...state.chains } };
  for (const finding of findings) {
    if (finding.kind === "check_failed") {
      next.checkFailedAlertedAt = now.toISOString();
    } else {
      const chain = next.chains![finding.chainId];
      if (chain) next.chains![finding.chainId] = { ...chain, alertedAt: now.toISOString() };
    }
  }
  return next;
}

export function describe(finding: Finding): string {
  if (finding.kind === "check_failed") {
    return `head-lag check failed ${finding.failures}x in a row (${finding.error.slice(0, 160)})`;
  }
  const lag =
    finding.lagSeconds === null
      ? "no indexer_cursor row"
      : `head ${Math.round(finding.lagSeconds)}s old at block ${finding.headBlockNumber ?? "?"}`;
  return `${finding.name} (${finding.chainId}): ${lag}, threshold ${finding.thresholdSeconds}s, ${finding.breaches} checks in a row`;
}
