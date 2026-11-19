import { createHmac } from "node:crypto";
import { auditChain, parseGapChains, type Result } from "./eventGapAudit";
import {
  SUMMARY_ERROR_MAX_LENGTH,
  createRedactor,
  elide,
} from "./eventGapRules";

const chains = parseGapChains(process.env.GAP_MONITOR_CHAINS ?? "");
if (chains.length === 0) throw new Error("Set GAP_MONITOR_CHAINS");

const windowSeconds = process.env.GAP_MONITOR_WINDOW_SECONDS ?? "10800";
const retrySeconds = Number(process.env.GAP_MONITOR_RETRY_SECONDS ?? 30);
if (!(retrySeconds >= 0))
  throw new Error(
    `GAP_MONITOR_RETRY_SECONDS must be a non-negative number, got ${process.env.GAP_MONITOR_RETRY_SECONDS}`,
  );
const testAlert = process.argv.includes("--test-alert");
const redact = createRedactor({
  rpcUrls: chains.map((chain) => chain.rpcUrl),
  pgConnectionString: process.env.PG_CONNECTION_STRING,
});

const results: Result[] = [];
for (const chain of chains) {
  results.push(
    await auditChain(
      chain,
      {
        windowSeconds,
        pgConnectionString: process.env.PG_CONNECTION_STRING!,
        redact,
      },
      retrySeconds,
    ),
  );
}
if (testAlert) {
  results.push({
    network: "test",
    ok: false,
    gap: false,
    error: "synthetic test alert",
  });
}

const failures = results.filter((r) => !r.ok);
const report = {
  checkedAt: new Date().toISOString(),
  ok: failures.length === 0,
  test: testAlert,
  windowSeconds: Number(windowSeconds),
  results,
};
console.log(JSON.stringify(report));

if (failures.length > 0) {
  process.exitCode = 1;
  const gaps = failures.filter((r) => !r.ok && r.gap);
  const describe = (r: Result) =>
    r.ok
      ? ""
      : r.gap
        ? `${r.network}: ${r.summary.missing} missing / ${r.summary.hash} wrong-hash block(s) in ${r.summary.from}..${r.summary.to}`
        : `${r.network}: check failed (${elide(r.error, SUMMARY_ERROR_MAX_LENGTH)})`;
  if (process.env.ALERT_WEBHOOK_URL) {
    const body = JSON.stringify({
      payload: {
        summary: `${gaps.length > 0 ? "Indexer event gap" : "Indexer gap check failing"}: ${failures.map(describe).join("; ")}`,
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
    if (!response.ok) process.exitCode = 2;
  }
}
