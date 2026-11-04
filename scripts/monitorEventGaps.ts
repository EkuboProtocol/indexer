import { createHmac } from "node:crypto";
import {
  SUMMARY_ERROR_MAX_LENGTH,
  checkError,
  createRedactor,
  elide,
} from "./eventGapRules";

type Summary = {
  kind: "summary";
  chainId: string;
  from: number;
  to: number;
  missing: number;
  hash: number;
  missingEvents: number;
  [k: string]: unknown;
};
type Result =
  | { network: string; ok: true; summary: Summary }
  | {
      network: string;
      ok: false;
      gap: true;
      summary: Summary;
      findings: unknown[];
    }
  | { network: string; ok: false; gap: false; error: string };

const chains = (process.env.GAP_MONITOR_CHAINS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry, index) => {
    const at = entry.indexOf("=");
    // Not echoed: the entry may be a bare RPC URL with a key in it.
    if (at <= 0)
      throw new Error(
        `GAP_MONITOR_CHAINS entry ${index + 1} must be network=rpcUrl`,
      );
    const name = entry.slice(0, at);
    const [networkType, network] = name.startsWith("starknet/")
      ? ["starknet", name.slice(9)]
      : ["evm", name];
    const [rpcUrl, maxRange] = entry.slice(at + 1).split("|");
    if (
      maxRange !== undefined &&
      !(Number.isSafeInteger(Number(maxRange)) && Number(maxRange) > 0)
    ) {
      throw new Error(
        `GAP_MONITOR_CHAINS maxRange must be a positive integer, got ${maxRange} in ${name}`,
      );
    }
    return { network, networkType, rpcUrl: rpcUrl!, maxRange };
  });
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

async function auditOnce(
  network: string,
  networkType: string,
  rpcUrl: string,
  maxRange?: string,
): Promise<Result> {
  const deadline = AbortSignal.timeout(10 * 60_000);
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
    signal: deadline,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const lines = stdout.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed.kind === "string" ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const summary = lines.find((line) => line.kind === "summary") as
    | Summary
    | undefined;
  if (!summary) {
    const outcome = deadline.aborted
      ? "timed out after 10 minutes"
      : `exit ${code}`;
    return {
      network,
      ok: false,
      gap: false,
      error: checkError(outcome, stdout, stderr, redact),
    };
  }
  if (summary.missing + summary.hash > 0) {
    const findings = lines
      .filter((line) => line.kind === "missing" || line.kind === "hash")
      .slice(0, 20);
    return { network, ok: false, gap: true, summary, findings };
  }
  return { network, ok: true, summary };
}

const results: Result[] = [];
for (const { network, networkType, rpcUrl, maxRange } of chains) {
  const label = networkType === "evm" ? network : `${networkType}/${network}`;
  let result = await auditOnce(network, networkType, rpcUrl, maxRange);
  if (!result.ok && !result.gap) {
    await Bun.sleep(retrySeconds * 1_000);
    result = await auditOnce(network, networkType, rpcUrl, maxRange);
  }
  results.push({ ...result, network: label });
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
