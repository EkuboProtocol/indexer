/**
 * Periodic CoinGecko quota monitor (EKU-340): reads the `token-price-sync` run
 * logs through `doctl` and alerts when the account's monthly credits run out
 * or run low, or when the headroom reading itself goes missing.
 *
 *   DO_APP_ID=<app id> \
 *   ALERT_WEBHOOK_URL=<paperclip routine webhook> ALERT_WEBHOOK_HMAC_SECRET=<secret> \
 *     bun scripts/monitorCoinGeckoQuota.ts [--test-alert]
 *
 * The alert rules (quota_exhausted, credits_low, credits_stale) are in
 * `coingeckoQuotaRules.ts`. This script adds `check_failed`: reading the logs
 * failed on two consecutive runs.
 *
 * App Platform keeps run logs only since the component's latest deploy, so the
 * last-seen timestamps live in QUOTA_MONITOR_STATE (a JSON file) rather than in
 * the logs; run this at least every 30 minutes so a line is never scrolled out
 * of the tail before it is seen. Dedupe markers advance only once an alert is
 * delivered, so a failed POST (or a dry run without a webhook) re-raises the
 * same finding next run.
 *
 * Alerts are POSTed signed with Paperclip's routine webhook scheme, exactly as
 * `monitorEventGaps.ts` does. `--test-alert` adds a synthetic finding to prove
 * delivery end to end. QUOTA_MONITOR_LOG_FILE replays a saved log capture
 * instead of calling doctl.
 */
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  evaluate,
  parseLines,
  type Finding,
  type LogLine,
  type QuotaMonitorState,
} from "./coingeckoQuotaRules";

const appId = process.env.DO_APP_ID ?? "";
const component = process.env.QUOTA_MONITOR_COMPONENT ?? "token-price-sync";
const tailLines = Number(process.env.QUOTA_MONITOR_TAIL_LINES ?? 20_000);
const lowPct = Number(process.env.QUOTA_MONITOR_LOW_PCT ?? 20);
const staleMs = Number(process.env.QUOTA_MONITOR_STALE_MINUTES ?? 150) * 60_000;
const statePath =
  process.env.QUOTA_MONITOR_STATE ??
  `${process.env.HOME}/.local/state/coingecko-quota-monitor/state.json`;
const testAlert = process.argv.includes("--test-alert");

if (!appId) throw new Error("DO_APP_ID is required");

function loadState(): QuotaMonitorState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as QuotaMonitorState;
  } catch {
    return {};
  }
}

function saveState(state: QuotaMonitorState) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function readLogs(): Promise<LogLine[]> {
  const replay = process.env.QUOTA_MONITOR_LOG_FILE;
  if (replay) return parseLines(readFileSync(replay, "utf8"));

  const proc = Bun.spawn(
    ["doctl", "apps", "logs", appId, component, "--type", "run", "--tail", String(tailLines)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), 120_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`doctl exited ${code}: ${stderr.trim().slice(0, 200)}`);

  return parseLines(stdout);
}

const previous = loadState();
const now = new Date();
let state: QuotaMonitorState = { ...previous, firstRunAt: previous.firstRunAt ?? now.toISOString() };
const findings: Finding[] = [];
let lines: LogLine[] | undefined;

try {
  lines = await readLogs();
} catch {
  await Bun.sleep(30_000);
  try {
    lines = await readLogs();
  } catch (retryError) {
    state.consecutiveCheckFailures = (state.consecutiveCheckFailures ?? 0) + 1;
    if (state.consecutiveCheckFailures >= 2) {
      findings.push({
        kind: "check_failed",
        detail: `reading ${component} logs failed on ${state.consecutiveCheckFailures} consecutive runs: ${String(retryError).slice(0, 200)}`,
      });
    }
  }
}

if (lines) {
  const result = evaluate(lines, state, now, { lowPct, staleMs });
  state = result.state;
  findings.push(...result.findings);
}

if (testAlert) findings.push({ kind: "test", detail: "synthetic test alert" });

const report = {
  checkedAt: now.toISOString(),
  ok: findings.length === 0,
  test: testAlert,
  component,
  linesRead: lines?.length ?? 0,
  lastCredits: state.lastCreditsLine ?? null,
  lastCreditsAt: state.lastCreditsAt ?? null,
  findings,
};
console.log(JSON.stringify(report));

let alertDelivered = false;
if (findings.length > 0) {
  process.exitCode = 1;
  if (process.env.ALERT_WEBHOOK_URL) {
    const body = JSON.stringify({
      payload: {
        summary: `CoinGecko quota: ${findings.map((f) => `${f.kind}: ${f.detail.slice(0, 160)}`).join("; ")}`,
        report,
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const secret = process.env.ALERT_WEBHOOK_HMAC_SECRET;
    const response = await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret
          ? {
              "x-paperclip-timestamp": timestamp,
              "x-paperclip-signature": "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"),
            }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    // Never echo the webhook response: it may include internal identifiers.
    console.error(`alert delivery: HTTP ${response.status}`);
    if (!response.ok) process.exitCode = 2;
    alertDelivered = response.ok;
  }
}

if (findings.length > 0 && !alertDelivered) {
  state.lastQuotaAlertAt = previous.lastQuotaAlertAt;
  state.lastLowAlertAt = previous.lastLowAlertAt;
  state.lastLowAlertPct = previous.lastLowAlertPct;
  state.lastStaleAlertAt = previous.lastStaleAlertAt;
}
saveState(state);
