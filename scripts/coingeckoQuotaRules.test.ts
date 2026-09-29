import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  evaluate,
  parseLines,
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
