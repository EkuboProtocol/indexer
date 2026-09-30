/**
 * Head-freshness monitor (EKU-502): reads `indexer_cursor` and alerts when a
 * chain's indexed head has fallen behind wall-clock time, or when the check
 * itself keeps failing. The rules are in `headLagRules.ts`.
 *
 *   PG_CONNECTION_STRING=<read-only url, e.g. the indexer_gap_monitor role> \
 *   HEAD_LAG_CHAINS="1=eth,4663=rhc:600,..." \
 *   ALERT_WEBHOOK_URL=<paperclip routine webhook> ALERT_WEBHOOK_HMAC_SECRET=<secret> \
 *     bun scripts/monitorHeadLag.ts [--test-alert]
 *
 * Run it every minute or two. The indexer writes its head on every poll, so a
 * live chain's lag is its block time plus at most MAX_POLL_INTERVAL_MS (30 s);
 * the default threshold of five minutes, sustained over two checks, is far
 * above that and well inside the ten minutes after which the interface shows
 * its "API Performance Degraded" banner. HEAD_LAG_CHAINS names the chains that
 * must be present and may set a per-chain threshold (`:seconds`) or turn one
 * off (`:off`); a chain in `indexer_cursor` but not listed is checked at the
 * default.
 *
 * Streaks and dedupe markers live in HEAD_LAG_STATE (a JSON file) and advance
 * only once an alert is delivered, so a failed POST re-raises the finding next
 * run. Alerts are POSTed signed with Paperclip's routine webhook scheme, exactly
 * as `monitorEventGaps.ts` does. `--test-alert` adds a synthetic finding to
 * prove delivery end to end, without touching the stored state.
 *
 * Only `SELECT`s one small table, in a read-only transaction.
 */
import { SQL } from "bun";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  describe,
  evaluate,
  evaluateFailure,
  markAlerted,
  parseChains,
  type CursorRow,
  type Finding,
  type HeadLagConfig,
  type HeadLagState,
} from "./headLagRules";

const positive = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${raw}`);
  return value;
};

const config: HeadLagConfig = {
  chains: parseChains(process.env.HEAD_LAG_CHAINS ?? ""),
  defaultThresholdSeconds: positive("HEAD_LAG_THRESHOLD_SECONDS", 300),
  sustainChecks: positive("HEAD_LAG_SUSTAIN_CHECKS", 2),
  realertMs: positive("HEAD_LAG_REALERT_MINUTES", 60) * 60_000,
};
const statePath =
  process.env.HEAD_LAG_STATE ?? `${process.env.HOME}/.local/state/indexer-head-lag-monitor/state.json`;
const testAlert = process.argv.includes("--test-alert");

function loadState(): HeadLagState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as HeadLagState;
  } catch {
    return {};
  }
}

function saveState(state: HeadLagState) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function readCursors(): Promise<CursorRow[]> {
  const url = process.env.PG_CONNECTION_STRING;
  if (!url) throw new Error("PG_CONNECTION_STRING is required");
  const sql = new SQL(url, { max: 1, connectionTimeout: 10, idleTimeout: 5 });
  try {
    const rows = await sql.begin("read only", async (tx) => {
      await tx`SET LOCAL statement_timeout = '15s'`;
      return tx`
        SELECT chain_id::text                                        AS "chainId",
               head_block_number::text                               AS "headBlockNumber",
               EXTRACT(EPOCH FROM now() - head_block_time)::float8   AS "lagSeconds",
               EXTRACT(EPOCH FROM now() - last_updated)::float8      AS "updatedSecondsAgo"
        FROM indexer_cursor`;
    });
    return rows as CursorRow[];
  } finally {
    await sql.close({ timeout: 5 });
  }
}

async function deliver(findings: Finding[], report: unknown): Promise<boolean> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return false;
  const headline = findings.some((f) => f.kind === "head_lag") ? "Indexer head lag" : "Indexer head-lag check failing";
  const body = JSON.stringify({
    payload: { summary: `${testAlert ? "[TEST] " : ""}${headline}: ${findings.map(describe).join("; ")}`, report },
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
              "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"),
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
let findings: Finding[];
let next: HeadLagState;
let report: Record<string, unknown>;

try {
  const rows = await readCursors();
  const evaluated = evaluate(rows, config, state, now);
  findings = evaluated.findings;
  next = evaluated.next;
  report = {
    checkedAt: now.toISOString(),
    ok: evaluated.results.every((r) => !r.over),
    maxLagSeconds: Math.max(...evaluated.results.map((r) => r.lagSeconds ?? Infinity)),
    results: evaluated.results,
  };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const evaluated = evaluateFailure(message, config, state, now);
  findings = evaluated.findings;
  next = evaluated.next;
  report = { checkedAt: now.toISOString(), ok: false, error: message.slice(0, 500), checkFailures: next.checkFailures };
}

if (testAlert) {
  findings = [...findings, { kind: "check_failed", failures: 0, error: "synthetic test alert" }];
}
report = { ...report, test: testAlert, findings };
console.log(JSON.stringify(report));

if (findings.length > 0) {
  process.exitCode = 1;
  // A POST that throws (DNS, timeout) is an undelivered alert like any other:
  // exit 2 and still save state below, so streaks survive and it is re-raised.
  const delivered = await deliver(findings, report).catch((error: unknown) => {
    console.error(`alert delivery failed: ${error instanceof Error ? error.name : "error"}`);
    return false;
  });
  if (!delivered) process.exitCode = 2;
  // A test alert proves delivery; it must not suppress a real re-alert.
  else if (!testAlert) next = markAlerted(next, findings, now);
}
saveState(next);
