/**
 * Alert rules for `monitorCoinGeckoQuota.ts`, kept free of I/O so they can be
 * replayed against saved log captures in tests.
 *
 *   quota_exhausted  A `COINGECKO_QUOTA_EXHAUSTED` trip line or, from a worker
 *                    that predates it, a `Price sync job … failed:` line with
 *                    `"error_code":10006`. Alerts on the first one, then again
 *                    only once REALERT_MS has passed or the trip follows a
 *                    recovery seen since the last alert: the worker re-trips
 *                    every six hours while the limit holds, and a Paperclip
 *                    issue per trip is noise during a known outage. A trip the
 *                    recovery came after belongs to the outage that just ended.
 *   credits_low      The latest `COINGECKO_CREDITS` reading has remaining_pct
 *                    below `lowPct`. Re-alerts at most once a day unless it
 *                    falls below a quarter of that.
 *   credits_stale    No `COINGECKO_CREDITS` line for `staleMs` since the last
 *                    one seen, or the last two checks failed. Armed by the first
 *                    reading ever seen. Suppressed while the newest check failed
 *                    with 10006: CoinGecko refuses `GET /key` too once credits
 *                    are spent, and quota_exhausted covers it.
 *
 * `check_failed` (the log read itself failing) and delivery live in the
 * script, since they concern I/O rather than log content.
 */

export interface LogLine {
  // Millisecond ISO timestamp, so string comparison orders correctly.
  at: string;
  text: string;
}

export interface QuotaMonitorState {
  lastQuotaAlertAt?: string; // log timestamp of the last exhausted line alerted on
  lastRecoveryAt?: string; // log timestamp of the newest sign credits were back
  lastCreditsAt?: string; // log timestamp of the newest COINGECKO_CREDITS line
  lastCreditsLine?: string;
  lastLowAlertAt?: string; // wall clock of the last credits_low alert
  lastLowAlertPct?: number;
  lastStaleAlertAt?: string;
  consecutiveCheckFailures?: number;
  firstRunAt?: string;
}

export interface Finding {
  kind: "quota_exhausted" | "credits_low" | "credits_stale" | "check_failed" | "test";
  detail: string;
}

export interface RuleOptions {
  lowPct: number;
  staleMs: number;
}

export const REALERT_MS = 24 * 3_600_000;
const STALE_REALERT_MS = 6 * 3_600_000;
const LOW_REALERT_MS = 24 * 3_600_000;

// `token-price-sync 2026-09-29T14:44:30.353667580Z [..] ERROR (#56): ...`
const LINE = /^\S+ (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/;

/** Parses `doctl apps logs` output, dropping lines without a timestamp. */
export function parseLines(output: string): LogLine[] {
  return output.split("\n").flatMap((line) => {
    const match = LINE.exec(line);
    return match ? [{ at: new Date(match[1]).toISOString(), text: match[2] }] : [];
  });
}

function parseCredits(text: string) {
  const field = (name: string) => new RegExp(`\\b${name}=(\\S+)`).exec(text)?.[1];
  const pct = Number(field("remaining_pct"));
  const remaining = Number(field("remaining"));
  return {
    remaining: field("remaining"),
    remainingCount: Number.isFinite(remaining) ? remaining : undefined,
    limit: field("limit"),
    remainingPct: Number.isFinite(pct) ? pct : undefined,
  };
}

const isQuotaRefusal = (text: string) => text.includes('"error_code":10006');
const isTrip = (text: string) => text.includes("COINGECKO_QUOTA_EXHAUSTED");
const isLegacyRefusal = (text: string) =>
  /Price sync job \S+ failed:/.test(text) && isQuotaRefusal(text);
const isCreditLine = (text: string) => /\bCOINGECKO_CREDITS(_CHECK_FAILED)?\b/.test(text);
const isReading = (text: string) => /\bCOINGECKO_CREDITS\b(?!_)/.test(text);

function isRecovery(text: string): boolean {
  if (text.includes("COINGECKO_QUOTA_RESTORED")) return true;
  if (!isReading(text)) return false;
  const { remainingCount } = parseCredits(text);
  return remainingCount !== undefined && remainingCount > 0;
}

const newest = (lines: LogLine[], match: (text: string) => boolean) =>
  lines.filter(({ text }) => match(text)).at(-1);

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

const isAfter = (at: string | undefined, than: string) => at !== undefined && at > than;

// Newest sign the credits were back: a restored gate or a positive reading.
function trackRecovery(lines: LogLine[], state: QuotaMonitorState) {
  const recovery = newest(lines, isRecovery);
  if (recovery && !isAfter(state.lastRecoveryAt, recovery.at)) {
    state.lastRecoveryAt = recovery.at;
  }
}

function quotaFinding(lines: LogLine[], state: QuotaMonitorState): Finding | undefined {
  // Trip lines take precedence: a credit check refused with 10006 is expected
  // during a pause and must neither stand in for nor hold back a trip line.
  const exhausted = newest(lines, isTrip) ?? newest(lines, isLegacyRefusal);
  if (!exhausted) return undefined;

  const lastAlert = state.lastQuotaAlertAt;
  const recovery = state.lastRecoveryAt;
  const newOutage =
    lastAlert !== undefined && isAfter(recovery, lastAlert) && !isAfter(recovery, exhausted.at);
  const due =
    lastAlert === undefined ||
    (exhausted.at > lastAlert && (exhausted.at >= plus(lastAlert, REALERT_MS) || newOutage));
  if (!due) return undefined;

  state.lastQuotaAlertAt = exhausted.at;
  return { kind: "quota_exhausted", detail: `${exhausted.at} ${exhausted.text.slice(0, 300)}` };
}

function lowFinding(
  latestReading: LogLine | undefined,
  state: QuotaMonitorState,
  now: Date,
  lowPct: number,
): Finding | undefined {
  if (!latestReading) return undefined;
  const credits = parseCredits(latestReading.text);
  const pct = credits.remainingPct;
  if (pct === undefined || pct >= lowPct) return undefined;

  const lastLow = state.lastLowAlertAt ? Date.parse(state.lastLowAlertAt) : 0;
  const dueAgain = now.getTime() - lastLow >= LOW_REALERT_MS;
  const muchLower = pct < lowPct / 4 && (state.lastLowAlertPct ?? 100) >= lowPct / 4;
  if (!dueAgain && !muchLower) return undefined;

  state.lastLowAlertAt = now.toISOString();
  state.lastLowAlertPct = pct;
  return {
    kind: "credits_low",
    detail: `remaining ${credits.remaining}/${credits.limit} (${pct}%) at ${latestReading.at}, below ${lowPct}%`,
  };
}

// CoinGecko refuses `GET /key` with 10006 too once credits are spent, so a
// quota-refused newest check is not "stale": quota_exhausted covers it.
function quotaExplainsMissingReadings(creditLines: LogLine[]): boolean {
  const newestCredit = creditLines.at(-1);
  return (
    newestCredit !== undefined &&
    newestCredit.text.includes("COINGECKO_CREDITS_CHECK_FAILED") &&
    isQuotaRefusal(newestCredit.text)
  );
}

function staleFinding(
  creditLines: LogLine[],
  state: QuotaMonitorState,
  now: Date,
  staleMs: number,
): Finding | undefined {
  if (quotaExplainsMissingReadings(creditLines)) return undefined;

  const lastTwo = creditLines.slice(-2);
  const failingChecks =
    lastTwo.length === 2 &&
    lastTwo.every(({ text }) => text.includes("COINGECKO_CREDITS_CHECK_FAILED"));
  // Armed by the first reading, so a worker that predates the credit check
  // does not read as a stale one.
  const stale =
    state.lastCreditsAt !== undefined &&
    now.getTime() - Date.parse(state.lastCreditsAt) > staleMs;
  const lastStale = state.lastStaleAlertAt ? Date.parse(state.lastStaleAlertAt) : 0;
  if (!(stale || failingChecks) || now.getTime() - lastStale < STALE_REALERT_MS) {
    return undefined;
  }

  state.lastStaleAlertAt = now.toISOString();
  return {
    kind: "credits_stale",
    detail: failingChecks
      ? `last two credit checks failed: ${lastTwo.at(-1)!.text.slice(0, 200)}`
      : `no COINGECKO_CREDITS line since ${state.lastCreditsAt}`,
  };
}

/**
 * Evaluates one run's log lines against the carried-over state. Returns the
 * findings and the state to persist if they are delivered.
 */
export function evaluate(
  lines: readonly LogLine[],
  previous: QuotaMonitorState,
  now: Date,
  { lowPct, staleMs }: RuleOptions,
): { findings: Finding[]; state: QuotaMonitorState } {
  const state: QuotaMonitorState = { ...previous, consecutiveCheckFailures: 0 };
  const all = [...lines];

  trackRecovery(all, state);
  const quota = quotaFinding(all, state);

  const creditLines = all.filter(({ text }) => isCreditLine(text));
  const latestReading = newest(creditLines, isReading);
  if (latestReading && !isAfter(state.lastCreditsAt, latestReading.at)) {
    state.lastCreditsAt = latestReading.at;
    state.lastCreditsLine = latestReading.text.slice(0, 300);
  }

  const findings = [
    quota,
    lowFinding(latestReading, state, now, lowPct),
    staleFinding(creditLines, state, now, staleMs),
  ].filter((finding): finding is Finding => finding !== undefined);

  return { findings, state };
}
