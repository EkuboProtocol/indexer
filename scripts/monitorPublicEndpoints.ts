/**
 * Public endpoint monitor: requests the public API and every chain's quoter
 * from outside the platform and alerts when one stops answering, or when a
 * quoter falls behind the head the API reports.
 *
 *   ALERT_WEBHOOK_URL=<routine webhook> ALERT_WEBHOOK_HMAC_SECRET=<secret> \
 *     bun scripts/monitorPublicEndpoints.ts [--test-alert]
 *
 * Run it every minute. The rules are in `publicEndpointRules.ts`. Streaks live
 * in ENDPOINT_MONITOR_STATE, a JSON file, and advance to "alerted" only once an
 * alert is delivered, so a failed POST raises the same finding next run.
 * Alerts are POSTed signed exactly as `monitorHeadLag.ts` signs them.
 * `--test-alert` adds a synthetic finding to prove delivery end to end.
 */
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  SERVICES,
  describe,
  endpointPath,
  evaluate,
  headline,
  markAlerted,
  parseChains,
  toProbe,
  type EndpointConfig,
  type EndpointState,
  type Finding,
  type Probe,
  type Service,
} from "./publicEndpointRules";

const DEFAULT_CHAINS =
  "1=eth,8453=base,42161=arb,4663=rhc,23448594291968334=starknet,4326=megaeth," +
  "143=monad,10=opt,56=bsc,100=gnosis,130=unichain,137=polygon,480=worldchain," +
  "57073=ink";
const USER_AGENT = "ekubo-public-endpoint-monitor/1";

const positive = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive number, got ${raw}`);
  return value;
};

const config: EndpointConfig = {
  chains: parseChains(process.env.ENDPOINT_MONITOR_CHAINS || DEFAULT_CHAINS),
  sustainChecks: positive("ENDPOINT_MONITOR_SUSTAIN_CHECKS", 2),
  realertMs: positive("ENDPOINT_MONITOR_REALERT_MINUTES", 60) * 60_000,
  quoterLagSeconds: positive("ENDPOINT_MONITOR_QUOTER_LAG_SECONDS", 300),
};
const baseUrls: Record<Service, string> = {
  api: process.env.ENDPOINT_MONITOR_API_URL || "https://prod-api.ekubo.org",
  quoter:
    process.env.ENDPOINT_MONITOR_QUOTER_URL ||
    "https://prod-api-quoter.ekubo.org",
};
const controlUrl =
  process.env.ENDPOINT_MONITOR_CONTROL_URL ||
  "https://www.google.com/generate_204";
const timeoutMs = positive("ENDPOINT_MONITOR_TIMEOUT_MS", 10_000);
const statePath =
  process.env.ENDPOINT_MONITOR_STATE ??
  `${process.env.HOME}/.local/state/public-endpoint-monitor/state.json`;
const testAlert = process.argv.includes("--test-alert");

function loadState(): EndpointState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as EndpointState;
  } catch {
    return {};
  }
}

function saveState(state: EndpointState) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function failureText(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError")
    return `timeout after ${timeoutMs} ms`;
  return error instanceof Error
    ? `${error.name}: ${error.message}`.slice(0, 300)
    : String(error).slice(0, 300);
}

async function probe(service: Service, chainId: string): Promise<Probe> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const response = await fetch(
      `${baseUrls[service]}${endpointPath(service, chainId)}`,
      {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const body = await response.text();
    return toProbe(service, chainId, response.status, body, elapsed());
  } catch (error) {
    return {
      service,
      chainId,
      ok: false,
      status: null,
      ms: elapsed(),
      error: failureText(error),
    };
  }
}

/** Any HTTP answer from a third party shows this host can reach the internet. */
async function controlAnswers(): Promise<boolean> {
  try {
    const response = await fetch(controlUrl, {
      headers: { "user-agent": USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function deliver(findings: Finding[], report: unknown): Promise<boolean> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return false;
  const body = JSON.stringify({
    payload: {
      summary: `${testAlert ? "[TEST] " : ""}${headline(findings)}: ${findings.map(describe).join("; ")}`,
      report,
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = process.env.ALERT_WEBHOOK_HMAC_SECRET;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret
        ? {
            "x-paperclip-timestamp": timestamp,
            "x-paperclip-signature":
              "sha256=" +
              createHmac("sha256", secret)
                .update(`${timestamp}.${body}`)
                .digest("hex"),
          }
        : {}),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  // Never echo the webhook response: it may include internal identifiers.
  console.error(`alert delivery: HTTP ${response.status}`);
  return response.ok;
}

const now = new Date();
const state = loadState();
const probes = await Promise.all(
  config.chains.flatMap(({ chainId }) =>
    SERVICES.map((service) => probe(service, chainId)),
  ),
);
const controlOk = probes.every((p) => p.ok) ? null : await controlAnswers();
const evaluated = evaluate(probes, controlOk, config, state, now);
let next = evaluated.next;
const findings: Finding[] = testAlert
  ? [
      ...evaluated.findings,
      {
        kind: "endpoint_down",
        service: "api",
        chainId: "0",
        name: "test",
        failures: 0,
        status: null,
        error: "synthetic test alert",
      },
    ]
  : evaluated.findings;

const overLag = evaluated.results.some(
  (r) =>
    r.quoterLagSeconds !== null && r.quoterLagSeconds > config.quoterLagSeconds,
);
const report = {
  checkedAt: now.toISOString(),
  ok: probes.every((p) => p.ok) && !overLag,
  offline: evaluated.offline,
  controlOk,
  test: testAlert,
  probes: probes.map((p) => ({
    endpoint: `${p.service}:${p.chainId}`,
    ok: p.ok,
    status: p.status,
    ms: p.ms,
    ...(p.ok
      ? { blockAgeSeconds: Math.round(now.getTime() / 1000 - p.blockTime) }
      : { error: p.error }),
  })),
  chains: evaluated.results,
  findings,
};
console.log(JSON.stringify(report));

if (findings.length > 0) {
  process.exitCode = 1;
  const delivered = await deliver(findings, report).catch((error: unknown) => {
    console.error(
      `alert delivery failed: ${error instanceof Error ? error.name : "error"}`,
    );
    return false;
  });
  if (!delivered) process.exitCode = 2;
  // A test alert proves delivery; it must not suppress a real re-alert.
  else if (!testAlert) next = markAlerted(next, findings, now);
}
saveState(next);
