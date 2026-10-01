import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_LOW_PCT,
  evaluate,
  parseLines,
  projectMonthEnd,
  REALERT_MS,
  type LogLine,
  type QuotaMonitorState,
} from "./coingeckoQuotaRules";

// `gated` is trimmed from the real prod capture after the indexer#219 deploy
// (2026-09-29 15:12 UTC): a refused credit check, one trip line, cold starts.
// `legacy` is the pre-gate worker's per-job 10006 failure.
const fixture = (name: string) =>
  parseLines(readFileSync(`${import.meta.dir}/fixtures/coingecko-quota-${name}.log`, "utf8"));
const gated = fixture("gated");
const legacy = fixture("legacy");

const TRIP_AT = "2026-09-29T15:12:33.240Z";
const options = { lowPct: 20, staleMs: 150 * 60_000 };
const at = (iso: string) => new Date(iso);
const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const line = (iso: string, text: string): LogLine => ({ at: iso, text });

function kinds(lines: readonly LogLine[], state: QuotaMonitorState, now = at("2026-09-29T15:13:00Z")) {
  return evaluate(lines, state, now, options).findings.map((finding) => finding.kind);
}

test("the capture parses into timestamped lines", () => {
  expect(gated).toHaveLength(8);
  expect(gated.every(({ at }) => /Z$/.test(at))).toBe(true);
});

test("a first trip line alerts, even behind a quota-refused credit check", () => {
  const { findings, state } = evaluate(gated, {}, at("2026-09-29T15:13:00Z"), options);

  expect(findings.map((finding) => finding.kind)).toEqual(["quota_exhausted"]);
  expect(findings[0].detail).toContain("COINGECKO_QUOTA_EXHAUSTED");
  expect(state.lastQuotaAlertAt).toBe(TRIP_AT);
});

test("a trip line already alerted on stays quiet", () => {
  expect(kinds(gated, { lastQuotaAlertAt: TRIP_AT })).toEqual([]);
});

test("a re-trip during the same outage waits out the re-alert window", () => {
  const retrip = line(later(TRIP_AT, 6 * 3_600_000), "ERROR (#7): COINGECKO_QUOTA_EXHAUSTED …");
  const state = { lastQuotaAlertAt: TRIP_AT };

  expect(kinds([...gated, retrip], state)).toEqual([]);

  const dayLater = line(later(TRIP_AT, REALERT_MS), "ERROR (#7): COINGECKO_QUOTA_EXHAUSTED …");
  expect(kinds([...gated, dayLater], state)).toEqual(["quota_exhausted"]);
});

test("a trip after credits were seen back alerts at once", () => {
  const restored = line(later(TRIP_AT, 3_600_000), "INFO (#65): COINGECKO_QUOTA_RESTORED credits available: remaining=5000");
  const retrip = line(later(TRIP_AT, 2 * 3_600_000), "ERROR (#7): COINGECKO_QUOTA_EXHAUSTED …");

  expect(kinds([...gated, restored, retrip], { lastQuotaAlertAt: TRIP_AT })).toEqual([
    "quota_exhausted",
  ]);
});

test("a re-trip the recovery came after stays quiet", () => {
  // EKU-554: the last six-hourly re-trip before the monthly reset, read
  // together with the credit check that reopened the gate an hour later.
  const retrip = line(later(TRIP_AT, 6 * 3_600_000), "ERROR (#7): COINGECKO_QUOTA_EXHAUSTED …");
  const restored = line(later(TRIP_AT, 7 * 3_600_000), "INFO (#65): COINGECKO_QUOTA_RESTORED credits available: remaining=100000");

  expect(kinds([...gated, retrip, restored], { lastQuotaAlertAt: TRIP_AT })).toEqual([]);
});

test("legacy job failures alert, then respect the re-alert window", () => {
  expect(kinds(legacy, {})).toEqual(["quota_exhausted"]);
  expect(kinds(legacy, { lastQuotaAlertAt: "2026-09-29T14:40:00.000Z" })).toEqual([]);
  expect(kinds(legacy, { lastQuotaAlertAt: later("2026-09-29T14:44:30.353Z", -REALERT_MS) })).toEqual([
    "quota_exhausted",
  ]);
});

test("a quota-refused credit check is not reported as stale", () => {
  const state = { lastQuotaAlertAt: TRIP_AT, lastCreditsAt: "2026-09-29T10:00:00.000Z" };

  expect(kinds(gated, state)).toEqual([]);
});

test("two non-quota credit check failures are reported as stale", () => {
  const failed = (iso: string) =>
    line(iso, "ERROR (#65): COINGECKO_CREDITS_CHECK_FAILED cgk: read API key usage: 500 Internal Server Error");

  expect(kinds([failed("2026-09-29T15:00:00.000Z"), failed("2026-09-29T16:00:00.000Z")], {})).toEqual([
    "credits_stale",
  ]);
});

test("a low credit reading alerts once a day unless it drops much further", () => {
  const reading = (pct: number) =>
    line(
      "2026-09-29T15:00:00.000Z",
      `INFO (#65): COINGECKO_CREDITS plan=Analyst limit=500000 used=1 remaining=${pct * 5000} remaining_pct=${pct}`,
    );
  const first = evaluate([reading(15)], {}, at("2026-09-29T15:05:00Z"), options);

  expect(first.findings.map((finding) => finding.kind)).toEqual(["credits_low"]);
  expect(kinds([reading(12)], first.state, at("2026-09-29T16:05:00Z"))).toEqual([]);
  expect(kinds([reading(3)], first.state, at("2026-09-29T16:05:00Z"))).toEqual(["credits_low"]);
});

// Replays of a whole month, one monitor run five minutes after each reading.
// Both start from the real first reading after the October reset (02:51:56Z,
// used=186) and read every three hours, in the worker's line format:
// `on-pace` reaches 89,000 used by the last reading (the top of the 80-89k
// October estimate); `over-pace` burns 3,300/day and runs dry on the 31st.
const onPace = fixture("on-pace");
const overPace = fixture("over-pace");
const monitorDefaults = { lowPct: DEFAULT_LOW_PCT, staleMs: options.staleMs };

function replayMonth(readings: readonly LogLine[]) {
  let state: QuotaMonitorState = {};
  const alerts: { at: string; kind: string; detail: string }[] = [];
  for (const reading of readings) {
    const now = new Date(Date.parse(reading.at) + 5 * 60_000);
    const result = evaluate([reading], state, now, monitorDefaults);
    state = result.state;
    alerts.push(...result.findings.map(({ kind, detail }) => ({ at: reading.at, kind, detail })));
  }
  return alerts;
}

test("a month on pace to end at 89k used raises nothing", () => {
  expect(onPace.at(-1)!.text).toContain("used=89000");
  expect(replayMonth(onPace)).toEqual([]);
});

test("an over-pace month alerts from day three, once a day, then low near the end", () => {
  const alerts = replayMonth(overPace);
  const pace = alerts.filter(({ kind }) => kind === "credits_pace");

  // 50.9h in: the first reading past the 48h grace window.
  expect(pace[0].at).toBe("2026-10-03T02:51:56.746Z");
  expect(pace[0].detail).toContain("projecting 99257 (99.3%)");
  expect(pace.map(({ at }) => at.slice(0, 10))).toEqual(
    [...new Set(overPace.map(({ at }) => at.slice(0, 10)))].filter((day) => day >= "2026-10-03"),
  );
  // Below 5%, a day later, then below a quarter of that.
  expect(alerts.filter(({ kind }) => kind === "credits_low").map(({ at }) => at)).toEqual([
    "2026-10-29T20:51:56.746Z",
    "2026-10-30T20:51:56.746Z",
    "2026-10-30T23:51:56.746Z",
  ]);
});

test("pace ignores the month's first 48h, then alerts on the same rate", () => {
  // 6,000 used 36h in projects 124k, but `used` may still be September's
  // total or a restart burst this early.
  const early = line("2026-10-02T12:00:00.000Z", "INFO (#65): COINGECKO_CREDITS plan=Basic limit=100000 used=6000 remaining=94000 remaining_pct=94.0");
  expect(kinds([early], {}, at("2026-10-02T12:05:00Z"))).toEqual([]);

  const past = line("2026-10-03T00:00:00.000Z", "INFO (#65): COINGECKO_CREDITS plan=Basic limit=100000 used=8000 remaining=92000 remaining_pct=92.0");
  expect(kinds([past], {}, at("2026-10-03T00:05:00Z"))).toEqual(["credits_pace"]);
});

test("pace projects from the 1st, 00:00 UTC to the next 1st", () => {
  // 30-day September: 47,500 used at the half-way point is exactly 95,000.
  expect(projectMonthEnd(47_500, "2026-09-16T00:00:00.000Z").projected).toBe(95_000);
  const atLine = (used: number) =>
    line("2026-09-16T00:00:00.000Z", `INFO (#65): COINGECKO_CREDITS plan=Basic limit=100000 used=${used} remaining=${100_000 - used} remaining_pct=50.0`);
  expect(kinds([atLine(47_500)], {}, at("2026-09-16T00:05:00Z"))).toEqual([]);
  expect(kinds([atLine(47_501)], {}, at("2026-09-16T00:05:00Z"))).toEqual(["credits_pace"]);
});
