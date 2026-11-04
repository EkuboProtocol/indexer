/**
 * Alert rules for the public endpoint monitor (`monitorPublicEndpoints.ts`),
 * kept free of I/O so they can be replayed and tested.
 *
 * Every run requests two endpoints per chain from outside the platform:
 * - `api`: the public API's latest indexed block, `GET /blocks/<chainId>/latest`.
 *   It goes through the Worker, Hyperdrive and the database, and is cached at
 *   the edge for only 5 seconds.
 * - `quoter`: that chain's quoter service, `GET /<chainId>/health`. Each chain is
 *   a separate App Platform service behind one domain, so one can be down while
 *   the rest answer.
 *
 * Kinds:
 * - `endpoint_down`: a request failed (network error, timeout, a status other
 *   than 200, or a body without the expected block field) on `sustainChecks`
 *   consecutive runs.
 * - `quoter_behind`: a quoter's latest block is more than `quoterLagSeconds`
 *   older than the latest block the API reports for the same chain, on
 *   `sustainChecks` consecutive runs. Both are read from the same database, so
 *   the gap means the quoter stopped following it. When the indexer itself falls
 *   behind, the two move together and the head-lag monitor reports it.
 *
 * A run where every request failed and a control request to a third party
 * failed too is taken as this host being offline: it changes no streak and
 * raises nothing. Each finding is re-raised at most once per `realertMs` while
 * it persists, and one passing check ends its episode.
 */

export type Service = "api" | "quoter";

export type Chain = { chainId: string; name: string };

export type EndpointConfig = {
  chains: Chain[];
  sustainChecks: number;
  realertMs: number;
  quoterLagSeconds: number;
};

/** One request's outcome. `blockTime` is the reported block's unix time in seconds. */
export type Probe =
  | {
      service: Service;
      chainId: string;
      ok: true;
      status: number;
      ms: number;
      blockTime: number;
    }
  | {
      service: Service;
      chainId: string;
      ok: false;
      status: number | null;
      ms: number;
      error: string;
    };

export type Streak = { count: number; alertedAt?: string };

export type EndpointState = {
  down?: Record<string, Streak>;
  behind?: Record<string, Streak>;
};

export type Finding =
  | {
      kind: "endpoint_down";
      service: Service;
      chainId: string;
      name: string;
      failures: number;
      status: number | null;
      error: string;
    }
  | {
      kind: "quoter_behind";
      chainId: string;
      name: string;
      lagSeconds: number;
      thresholdSeconds: number;
      breaches: number;
    };

export type ChainResult = {
  chainId: string;
  name: string;
  quoterLagSeconds: number | null;
};

export const SERVICES: readonly Service[] = ["api", "quoter"];

export const endpointKey = (service: Service, chainId: string) =>
  `${service}:${chainId}`;

export function parseChains(raw: string): Chain[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+)=([\w.-]+)$/.exec(entry);
      if (!match) {
        throw new Error(
          `ENDPOINT_MONITOR_CHAINS entry must be chainId=name, got ${entry}`,
        );
      }
      const [, chainId, name] = match;
      return { chainId, name };
    });
}

export function endpointPath(service: Service, chainId: string): string {
  return service === "api" ? `/blocks/${chainId}/latest` : `/${chainId}/health`;
}

function readJson(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The reported block time in seconds: the API's `timestamp` is an ISO date, the
 * quoter's `latest_block_timestamp` is unix seconds. Null when the body does not
 * carry a usable one.
 */
export function blockTimeOf(service: Service, body: string): number | null {
  const json = readJson(body);
  if (service === "api") {
    const at =
      typeof json?.timestamp === "string" ? Date.parse(json.timestamp) : NaN;
    return Number.isFinite(at) && typeof json?.number === "number"
      ? at / 1000
      : null;
  }
  const seconds = json?.latest_block_timestamp;
  return typeof seconds === "number" && seconds > 0 ? seconds : null;
}

export function toProbe(
  service: Service,
  chainId: string,
  status: number,
  body: string,
  ms: number,
): Probe {
  if (status !== 200) {
    return { service, chainId, ok: false, status, ms, error: `HTTP ${status}` };
  }
  const blockTime = blockTimeOf(service, body);
  return blockTime === null
    ? {
        service,
        chainId,
        ok: false,
        status,
        ms,
        error: "response has no block time",
      }
    : { service, chainId, ok: true, status, ms, blockTime };
}

function due(alertedAt: string | undefined, now: Date, realertMs: number) {
  return (
    alertedAt === undefined ||
    now.getTime() - Date.parse(alertedAt) >= realertMs
  );
}

function advance(failing: boolean, previous: Streak | undefined): Streak {
  if (!failing) return { count: 0 };
  const count = (previous?.count ?? 0) + 1;
  return previous?.alertedAt
    ? { count, alertedAt: previous.alertedAt }
    : { count };
}

function raises(streak: Streak, config: EndpointConfig, now: Date): boolean {
  return (
    streak.count >= config.sustainChecks &&
    due(streak.alertedAt, now, config.realertMs)
  );
}

/** A run where nothing answered and neither did the control is this host's problem. */
export function isOffline(probes: Probe[], controlOk: boolean | null): boolean {
  return controlOk === false && probes.every((p) => !p.ok);
}

function checkEndpoints(
  probes: Probe[],
  config: EndpointConfig,
  state: EndpointState,
  now: Date,
): { down: Record<string, Streak>; findings: Finding[] } {
  const names = new Map(config.chains.map((c) => [c.chainId, c.name]));
  const down: Record<string, Streak> = {};
  const findings: Finding[] = [];
  for (const probe of probes) {
    const key = endpointKey(probe.service, probe.chainId);
    const streak = advance(!probe.ok, state.down?.[key]);
    down[key] = streak;
    if (!probe.ok && raises(streak, config, now)) {
      findings.push({
        kind: "endpoint_down",
        service: probe.service,
        chainId: probe.chainId,
        name: names.get(probe.chainId) ?? `chain-${probe.chainId}`,
        failures: streak.count,
        status: probe.status,
        error: probe.error,
      });
    }
  }
  return { down, findings };
}

function quoterLag(probes: Probe[], chainId: string): number | null {
  const api = probes.find((p) => p.service === "api" && p.chainId === chainId);
  const quoter = probes.find(
    (p) => p.service === "quoter" && p.chainId === chainId,
  );
  return api?.ok && quoter?.ok ? api.blockTime - quoter.blockTime : null;
}

function checkQuoterLag(
  probes: Probe[],
  config: EndpointConfig,
  state: EndpointState,
  now: Date,
): {
  behind: Record<string, Streak>;
  findings: Finding[];
  results: ChainResult[];
} {
  const behind: Record<string, Streak> = {};
  const findings: Finding[] = [];
  const results: ChainResult[] = [];
  for (const { chainId, name } of config.chains) {
    const lag = quoterLag(probes, chainId);
    results.push({ chainId, name, quoterLagSeconds: lag });
    const previous = state.behind?.[chainId];
    // Without both readings there is nothing to compare: keep the streak as is.
    if (lag === null) {
      if (previous) behind[chainId] = previous;
      continue;
    }
    const streak = advance(lag > config.quoterLagSeconds, previous);
    behind[chainId] = streak;
    if (lag > config.quoterLagSeconds && raises(streak, config, now)) {
      findings.push({
        kind: "quoter_behind",
        chainId,
        name,
        lagSeconds: lag,
        thresholdSeconds: config.quoterLagSeconds,
        breaches: streak.count,
      });
    }
  }
  return { behind, findings, results };
}

export function evaluate(
  probes: Probe[],
  controlOk: boolean | null,
  config: EndpointConfig,
  state: EndpointState,
  now: Date,
): {
  offline: boolean;
  findings: Finding[];
  next: EndpointState;
  results: ChainResult[];
} {
  const lagged = checkQuoterLag(probes, config, state, now);
  if (isOffline(probes, controlOk)) {
    return {
      offline: true,
      findings: [],
      next: state,
      results: lagged.results,
    };
  }
  const endpoints = checkEndpoints(probes, config, state, now);
  return {
    offline: false,
    findings: [...endpoints.findings, ...lagged.findings],
    next: { down: endpoints.down, behind: lagged.behind },
    results: lagged.results,
  };
}

export function markAlerted(
  state: EndpointState,
  findings: Finding[],
  now: Date,
): EndpointState {
  const next: EndpointState = {
    down: { ...state.down },
    behind: { ...state.behind },
  };
  const at = now.toISOString();
  for (const finding of findings) {
    const [streaks, key] =
      finding.kind === "endpoint_down"
        ? [next.down!, endpointKey(finding.service, finding.chainId)]
        : [next.behind!, finding.chainId];
    const streak = streaks[key];
    if (streak) streaks[key] = { ...streak, alertedAt: at };
  }
  return next;
}

export function describe(finding: Finding): string {
  const where = `${finding.kind === "endpoint_down" ? finding.service : "quoter"} ${finding.name} (${finding.chainId})`;
  if (finding.kind === "endpoint_down") {
    return `${where} failing ${finding.failures} checks in a row: ${finding.error.slice(0, 160)}`;
  }
  return `${where} is ${Math.round(finding.lagSeconds)}s behind the API's latest block, threshold ${finding.thresholdSeconds}s, ${finding.breaches} checks in a row`;
}

export function headline(findings: Finding[]): string {
  return findings.some((f) => f.kind === "endpoint_down")
    ? "Public endpoint down"
    : "Quoter behind the indexed head";
}
