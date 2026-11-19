/**
 * In-network indexer monitor (docs/INDEXER-MONITOR.md). Runs as the
 * `indexer-monitor` App Platform worker, inside the production VPC, with the
 * read-only monitor database role. Every minute it reads head lag; about every
 * 30 minutes it audits the last three hours of finalized history on every
 * chain. After each it posts a minimal verdict to the off-host receiver, whose
 * Health Checks email the owner. Database access and RPC keys never leave the
 * worker.
 */
import { auditChain, parseGapChains } from "./eventGapAudit";
import { createRedactor } from "./eventGapRules";
import { readCursors } from "./headLagRead";
import { evaluate, parseChains, type HeadLagState } from "./headLagRules";
import {
  delayUntilNext,
  gapReport,
  headLagReport,
  type GapReport,
  type HeadLagReport,
} from "./productionMonitorRules";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive number, got ${raw}`);
  return value;
}

const pgConnectionString = required("MONITOR_PG_CONNECTION_STRING");
const reportUrl = required("MONITOR_REPORT_URL");
const reportToken = required("MONITOR_REPORT_TOKEN");
const headConfig = {
  chains: parseChains(required("HEAD_LAG_CHAINS")),
  defaultThresholdSeconds: positive("HEAD_LAG_THRESHOLD_SECONDS", 300),
  sustainChecks: positive("HEAD_LAG_SUSTAIN_CHECKS", 2),
  realertMs: Infinity,
};
const gapChains = parseGapChains(required("GAP_MONITOR_CHAINS"));
const windowSeconds = process.env.GAP_MONITOR_WINDOW_SECONDS ?? "10800";
const retrySeconds = positive("GAP_MONITOR_RETRY_SECONDS", 30);
const headIntervalMs = positive("HEAD_LAG_INTERVAL_SECONDS", 60) * 1_000;
const gapIntervalMs = positive("GAP_MONITOR_INTERVAL_MINUTES", 30) * 60_000;
const redact = createRedactor({
  rpcUrls: gapChains.map((chain) => chain.rpcUrl),
  pgConnectionString,
});

function log(line: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
}

async function send(report: HeadLagReport | GapReport): Promise<void> {
  try {
    const response = await fetch(reportUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${reportToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(report),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    log({ kind: "delivery", report: report.kind, status: response.status });
  } catch (error) {
    // The receiver's freshness check turns stale if this keeps failing.
    log({
      kind: "delivery",
      report: report.kind,
      error: error instanceof Error ? error.name : "error",
    });
  }
}

let headState: HeadLagState = {};

async function checkHead(): Promise<void> {
  let report: HeadLagReport;
  try {
    const rows = await readCursors(pgConnectionString);
    const evaluated = evaluate(rows, headConfig, headState, new Date());
    headState = evaluated.next;
    report = headLagReport(evaluated.results, headConfig.sustainChecks);
    log({ kind: "head-lag", results: evaluated.results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report = { kind: "head-lag", ok: false, error: "read_failed" };
    log({ kind: "head-lag", error: redact(message).slice(0, 500) });
  }
  await send(report);
}

async function checkGaps(): Promise<void> {
  const results = [];
  for (const chain of gapChains) {
    const result = await auditChain(
      chain,
      { windowSeconds, pgConnectionString, redact },
      retrySeconds,
    );
    log({ kind: "event-gap", result });
    results.push(result);
  }
  await send(gapReport(results));
}

async function every(intervalMs: number, task: () => Promise<void>) {
  for (;;) {
    const startedAt = Date.now();
    await task();
    await Bun.sleep(delayUntilNext(startedAt, Date.now(), intervalMs));
  }
}

log({
  kind: "start",
  headChains: [...headConfig.chains.values()].map((chain) => chain.name),
  gapChains: gapChains.map((chain) => chain.label),
});
await Promise.all([
  every(headIntervalMs, checkHead),
  every(gapIntervalMs, checkGaps),
]);
