/**
 * Periodic event-gap monitor: runs `auditEventGaps.ts` over each chain's most
 * recent finalized history and alerts when a block the chain has events for is
 * missing from `blocks`, or stored under another hash (EKU-272).
 *
 *   GAP_MONITOR_CHAINS="mainnet=https://...,starknet/mainnet=https://..." \
 *   PG_CONNECTION_STRING=<read-only url> \
 *   ALERT_WEBHOOK_URL=<paperclip routine webhook> ALERT_WEBHOOK_HMAC_SECRET=<secret> \
 *     bun scripts/monitorEventGaps.ts [--test-alert]
 *
 * A bare network name is EVM; prefix `starknet/` for Starknet, whose RPC must
 * speak JSON-RPC v0.10. Append `|<blocks>` to a URL to cap its read span.
 *
 * GAP_MONITOR_WINDOW_SECONDS (default 10800) is how much finalized history each
 * run re-checks; run it several times per window so a gap is seen more than
 * once before it scrolls out. Each chain runs in its own process because the
 * indexer's config loader writes the network's settings into the environment.
 *
 * A chain whose check itself fails (the RPC refused, the database was
 * unreachable) is retried once and then reported as a failed check, distinct
 * from a gap, so a monitoring outage is not mistaken for a clean bill.
 *
 * Alerts are POSTed signed with Paperclip's routine webhook scheme:
 * HMAC-SHA256 of `${timestamp}.${body}` in X-Paperclip-Signature and
 * X-Paperclip-Timestamp. `--test-alert` adds a synthetic failure to prove
 * delivery end to end.
 */
import { createHmac } from "node:crypto";

type Summary = { kind: "summary"; chainId: string; from: number; to: number; missing: number; hash: number; missingEvents: number; [k: string]: unknown };
type Result =
  | { network: string; ok: true; summary: Summary }
  | { network: string; ok: false; gap: true; summary: Summary; findings: unknown[] }
  | { network: string; ok: false; gap: false; error: string };

const chains = (process.env.GAP_MONITOR_CHAINS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const at = entry.indexOf("=");
    if (at <= 0) throw new Error(`GAP_MONITOR_CHAINS entry must be network=rpcUrl, got ${entry}`);
    const name = entry.slice(0, at);
    // "starknet/mainnet" names a Starknet network; a bare name is EVM.
    const [networkType, network] = name.startsWith("starknet/") ? ["starknet", name.slice(9)] : ["evm", name];
    // An optional "|maxRange" caps the eth_getLogs span for an endpoint that
    // refuses wide ones, instead of paying a refusal and a backoff per read.
    const [rpcUrl, maxRange] = entry.slice(at + 1).split("|");
    if (maxRange !== undefined && !(Number.isSafeInteger(Number(maxRange)) && Number(maxRange) > 0)) {
      throw new Error(`GAP_MONITOR_CHAINS maxRange must be a positive integer, got ${maxRange} in ${name}`);
    }
    return { network, networkType, rpcUrl: rpcUrl!, maxRange };
  });
if (chains.length === 0) throw new Error("Set GAP_MONITOR_CHAINS");

const windowSeconds = process.env.GAP_MONITOR_WINDOW_SECONDS ?? "10800";
const testAlert = process.argv.includes("--test-alert");

async function auditOnce(network: string, networkType: string, rpcUrl: string, maxRange?: string): Promise<Result> {
  const child = Bun.spawn(["bun", "scripts/auditEventGaps.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      NETWORK: network,
      AUDIT_NETWORK_TYPE: networkType,
      ...(maxRange ? { AUDIT_MAX_RANGE: maxRange, AUDIT_RANGE: maxRange } : {}),
      AUDIT_RPC_URL: rpcUrl,
      AUDIT_LAST_SECONDS: windowSeconds,
      PG_CONNECTION_STRING: process.env.PG_CONNECTION_STRING!,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10 * 60_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);

  const lines = stdout.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed.kind === "string" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const summary = lines.find((line) => line.kind === "summary") as Summary | undefined;
  if (!summary) {
    const tail = (stderr + stdout).trim().split("\n").slice(-3).join(" | ").slice(0, 500);
    return { network, ok: false, gap: false, error: `exit ${code}, no summary: ${tail}` };
  }
  if (summary.missing + summary.hash > 0) {
    const findings = lines.filter((line) => line.kind === "missing" || line.kind === "hash").slice(0, 20);
    return { network, ok: false, gap: true, summary, findings };
  }
  return { network, ok: true, summary };
}

const results: Result[] = [];
for (const { network, networkType, rpcUrl, maxRange } of chains) {
  const label = networkType === "evm" ? network : `${networkType}/${network}`;
  let result = await auditOnce(network, networkType, rpcUrl, maxRange);
  if (!result.ok && !result.gap) {
    await Bun.sleep(30_000);
    result = await auditOnce(network, networkType, rpcUrl, maxRange);
  }
  results.push({ ...result, network: label });
}
if (testAlert) {
  results.push({ network: "test", ok: false, gap: false, error: "synthetic test alert" });
}

const failures = results.filter((r) => !r.ok);
const report = { checkedAt: new Date().toISOString(), ok: failures.length === 0, test: testAlert, windowSeconds: Number(windowSeconds), results };
console.log(JSON.stringify(report));

if (failures.length > 0) {
  process.exitCode = 1;
  const gaps = failures.filter((r) => !r.ok && r.gap);
  const describe = (r: Result) =>
    r.ok ? "" : r.gap
      ? `${r.network}: ${r.summary.missing} missing / ${r.summary.hash} wrong-hash block(s) in ${r.summary.from}..${r.summary.to}`
      : `${r.network}: check failed (${r.error.slice(0, 160)})`;
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
  }
}
