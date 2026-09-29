/**
 * Periodic CoinGecko quota monitor (EKU-340): reads the `token-price-sync` run
 * logs through `doctl` and alerts when the account's monthly credits run out
 * or run low, or when the headroom reading itself goes missing.
 *
 *   DO_APP_ID=<app id> \
 *   ALERT_WEBHOOK_URL=<paperclip routine webhook> ALERT_WEBHOOK_HMAC_SECRET=<secret> \
 *     bun scripts/monitorCoinGeckoQuota.ts [--test-alert]
 *
 * Alert conditions, each evaluated on every run:
 *
 *   quota_exhausted  A `COINGECKO_QUOTA_EXHAUSTED` line (or, from a worker that
 *                    predates it, a raw `error_code":10006` failure) newer than
 *                    the last one alerted on. The worker re-trips every six
 *                    hours while the limit holds, so this re-alerts at that pace.
 *   credits_low      The latest `COINGECKO_CREDITS` reading has remaining_pct
 *                    below QUOTA_MONITOR_LOW_PCT (default 20). Re-alerts at most
 *                    once a day unless it falls below a quarter of that.
 *   credits_stale    No `COINGECKO_CREDITS` line for QUOTA_MONITOR_STALE_MINUTES
 *                    (default 150) since the last one seen, or the last two
 *                    readings were `COINGECKO_CREDITS_CHECK_FAILED`. Armed by
 *                    the first reading ever seen. Suppressed while the newest
 *                    check failed with 10006: CoinGecko refuses `GET /key`
 *                    too once credits are spent, and quota_exhausted covers it.
 *   check_failed     Reading the logs failed on two consecutive runs.
 *
 * App Platform keeps run logs only since the component's latest deploy, so the
 * last-seen timestamps live in QUOTA_MONITOR_STATE (a JSON file) rather than in
 * the logs; run this at least every 30 minutes so a line is never scrolled out
 * of the tail before it is seen.
 *
 * Alerts are POSTed signed with Paperclip's routine webhook scheme, exactly as
 * `monitorEventGaps.ts` does. `--test-alert` adds a synthetic finding to prove
 * delivery end to end. QUOTA_MONITOR_LOG_FILE replays a saved log capture
 * instead of calling doctl.
 */
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

interface State {
  lastQuotaAlertAt?: string; // log timestamp of the last exhausted line alerted on
  lastCreditsAt?: string; // log timestamp of the newest COINGECKO_CREDITS line
  lastCreditsLine?: string;
  lastLowAlertAt?: string; // wall clock of the last credits_low alert
  lastLowAlertPct?: number;
  lastStaleAlertAt?: string;
  consecutiveCheckFailures?: number;
  firstRunAt?: string;
}

interface Finding {
  kind: "quota_exhausted" | "credits_low" | "credits_stale" | "check_failed" | "test";
  detail: string;
}

function loadState(): State {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as State;
  } catch {
    return {};
  }
}

function saveState(state: State) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// `token-price-sync 2026-09-29T14:44:30.353667580Z [..] ERROR (#56): ...`
const LINE = /^\S+ (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/;

function parseLines(stdout: string): { at: string; text: string }[] {
  return stdout.split("\n").flatMap((line) => {
    const match = LINE.exec(line);
    // Normalise to millisecond ISO so string comparison orders correctly.
    return match ? [{ at: new Date(match[1]).toISOString(), text: match[2] }] : [];
  });
}

async function readLogs(): Promise<{ at: string; text: string }[]> {
  // Replays a saved `doctl apps logs` capture instead, for testing the rules.
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

function parseCredits(text: string) {
  const field = (name: string) => new RegExp(`\\b${name}=(\\S+)`).exec(text)?.[1];
  const pct = Number(field("remaining_pct"));
  return {
    remaining: field("remaining"),
    limit: field("limit"),
    used: field("used"),
    remainingPct: Number.isFinite(pct) ? pct : undefined,
  };
}

const state = loadState();
// Dedupe markers only advance once an alert is actually delivered, so a failed
// POST (or a dry run without a webhook) re-raises the same finding next run.
const delivered = { ...state };
const now = new Date();
state.firstRunAt ??= now.toISOString();
const findings: Finding[] = [];
let lines: { at: string; text: string }[] | undefined;

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
  state.consecutiveCheckFailures = 0;

  const isQuotaRefusal = (text: string) => text.includes('"error_code":10006');
  // The gated worker's trip line: one per pause, so every new one alerts.
  const newestTrip = lines.filter(({ text }) => text.includes("COINGECKO_QUOTA_EXHAUSTED")).at(-1);
  // A worker that predates the gate logs one 10006 job failure per job per
  // cycle; alerting on those at most every six hours keeps the same cadence.
  // Only job failures count: a credit check refused with 10006 is expected
  // during a pause and must not hold back or stand in for a trip line.
  const newestLegacy = lines
    .filter(({ text }) => /Price sync job \S+ failed:/.test(text) && isQuotaRefusal(text))
    .at(-1);
  const sixHoursAfterLast = state.lastQuotaAlertAt
    ? new Date(Date.parse(state.lastQuotaAlertAt) + 6 * 3_600_000).toISOString()
    : "";
  const newestExhausted =
    newestTrip && (!state.lastQuotaAlertAt || newestTrip.at > state.lastQuotaAlertAt)
      ? newestTrip
      : newestLegacy && (!state.lastQuotaAlertAt || newestLegacy.at >= sixHoursAfterLast)
        ? newestLegacy
        : undefined;
  if (newestExhausted) {
    findings.push({
      kind: "quota_exhausted",
      detail: `${newestExhausted.at} ${newestExhausted.text.slice(0, 300)}`,
    });
    state.lastQuotaAlertAt = newestExhausted.at;
  }

  const creditLines = lines.filter(({ text }) => /\bCOINGECKO_CREDITS(_CHECK_FAILED)?\b/.test(text));
  const readings = creditLines.filter(({ text }) => /\bCOINGECKO_CREDITS\b(?!_)/.test(text));
  const latestReading = readings.at(-1);
  if (latestReading && (!state.lastCreditsAt || latestReading.at > state.lastCreditsAt)) {
    state.lastCreditsAt = latestReading.at;
    state.lastCreditsLine = latestReading.text.slice(0, 300);
  }

  if (latestReading) {
    const credits = parseCredits(latestReading.text);
    const pct = credits.remainingPct;
    const lastLow = state.lastLowAlertAt ? Date.parse(state.lastLowAlertAt) : 0;
    const dueAgain = now.getTime() - lastLow >= 24 * 3_600_000;
    const muchLower = pct !== undefined && pct < lowPct / 4 && (state.lastLowAlertPct ?? 100) >= lowPct / 4;
    if (pct !== undefined && pct < lowPct && (dueAgain || muchLower)) {
      findings.push({
        kind: "credits_low",
        detail: `remaining ${credits.remaining}/${credits.limit} (${pct}%) at ${latestReading.at}, below ${lowPct}%`,
      });
      state.lastLowAlertAt = now.toISOString();
      state.lastLowAlertPct = pct;
    }
  }

  // CoinGecko also refuses `GET /key` with 10006 once the credits are spent,
  // so while the quota explains the missing readings they are not "stale":
  // quota_exhausted already covers it.
  const newestCredit = creditLines.at(-1);
  const quotaExplains =
    newestCredit !== undefined &&
    newestCredit.text.includes("COINGECKO_CREDITS_CHECK_FAILED") &&
    isQuotaRefusal(newestCredit.text);
  const lastTwo = creditLines.slice(-2);
  const failingChecks =
    !quotaExplains &&
    lastTwo.length === 2 &&
    lastTwo.every(({ text }) => text.includes("COINGECKO_CREDITS_CHECK_FAILED"));
  // Armed by the first reading, so a worker that predates the credit check
  // does not read as a stale one.
  const stale =
    !quotaExplains &&
    state.lastCreditsAt !== undefined &&
    now.getTime() - Date.parse(state.lastCreditsAt) > staleMs;
  const lastStale = state.lastStaleAlertAt ? Date.parse(state.lastStaleAlertAt) : 0;
  if ((stale || failingChecks) && now.getTime() - lastStale >= 6 * 3_600_000) {
    findings.push({
      kind: "credits_stale",
      detail: failingChecks
        ? `last two credit checks failed: ${lastTwo.at(-1)!.text.slice(0, 200)}`
        : `no COINGECKO_CREDITS line since ${state.lastCreditsAt}`,
    });
    state.lastStaleAlertAt = now.toISOString();
  }
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
  state.lastQuotaAlertAt = delivered.lastQuotaAlertAt;
  state.lastLowAlertAt = delivered.lastLowAlertAt;
  state.lastLowAlertPct = delivered.lastLowAlertPct;
  state.lastStaleAlertAt = delivered.lastStaleAlertAt;
}
saveState(state);
