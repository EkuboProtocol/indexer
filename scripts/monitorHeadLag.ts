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
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive number, got ${raw}`);
  return value;
};

const config: HeadLagConfig = {
  chains: parseChains(process.env.HEAD_LAG_CHAINS ?? ""),
  defaultThresholdSeconds: positive("HEAD_LAG_THRESHOLD_SECONDS", 300),
  sustainChecks: positive("HEAD_LAG_SUSTAIN_CHECKS", 2),
  realertMs: positive("HEAD_LAG_REALERT_MINUTES", 60) * 60_000,
};
const statePath =
  process.env.HEAD_LAG_STATE ??
  `${process.env.HOME}/.local/state/indexer-head-lag-monitor/state.json`;
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
  const headline = findings.some((f) => f.kind === "head_lag")
    ? "Indexer head lag"
    : "Indexer head-lag check failing";
  const body = JSON.stringify({
    payload: {
      summary: `${testAlert ? "[TEST] " : ""}${headline}: ${findings.map(describe).join("; ")}`,
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
    maxLagSeconds: Math.max(
      ...evaluated.results.map((r) => r.lagSeconds ?? Infinity),
    ),
    results: evaluated.results,
  };
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const evaluated = evaluateFailure(message, config, state, now);
  findings = evaluated.findings;
  next = evaluated.next;
  report = {
    checkedAt: now.toISOString(),
    ok: false,
    error: message.slice(0, 500),
    checkFailures: next.checkFailures,
  };
}

if (testAlert) {
  findings = [
    ...findings,
    { kind: "check_failed", failures: 0, error: "synthetic test alert" },
  ];
}
report = { ...report, test: testAlert, findings };
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
