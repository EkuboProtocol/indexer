/**
 * Runs `auditEventGaps.ts` for one chain and classifies its outcome. Shared by
 * the workstation-era `monitorEventGaps.ts` and the in-network
 * `productionMonitor.ts`, so both apply the same audit and the same semantics:
 * a gap is a finalized event-bearing block missing from `blocks` or stored
 * under another hash; anything without a summary is a failed check, never a
 * pass.
 */
import { checkError, type createRedactor } from "./eventGapRules";

export type Summary = {
  kind: "summary";
  chainId: string;
  from: number;
  to: number;
  missing: number;
  hash: number;
  missingEvents: number;
  [k: string]: unknown;
};

export type Result =
  | { network: string; ok: true; summary: Summary }
  | {
      network: string;
      ok: false;
      gap: true;
      summary: Summary;
      findings: unknown[];
    }
  | { network: string; ok: false; gap: false; error: string };

export type GapChain = {
  /** `network`, or `starknet/network` for Starknet. */
  label: string;
  network: string;
  networkType: string;
  rpcUrl: string;
  maxRange?: string;
};

export function parseGapChains(raw: string): GapChain[] {
  return raw
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
      const label = entry.slice(0, at);
      const [networkType, network] = label.startsWith("starknet/")
        ? ["starknet", label.slice(9)]
        : ["evm", label];
      const [rpcUrl, maxRange] = entry.slice(at + 1).split("|");
      if (
        maxRange !== undefined &&
        !(Number.isSafeInteger(Number(maxRange)) && Number(maxRange) > 0)
      ) {
        throw new Error(
          `GAP_MONITOR_CHAINS maxRange must be a positive integer, got ${maxRange} in ${label}`,
        );
      }
      return { label, network, networkType, rpcUrl, maxRange };
    });
}

export type AuditOptions = {
  windowSeconds: string;
  pgConnectionString: string;
  redact: ReturnType<typeof createRedactor>;
  timeoutMs?: number;
};

function parseLines(stdout: string): { kind: string }[] {
  return stdout.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { kind?: unknown } | null;
      return parsed && typeof parsed.kind === "string"
        ? [parsed as { kind: string }]
        : [];
    } catch {
      return [];
    }
  });
}

export async function auditOnce(
  chain: GapChain,
  options: AuditOptions,
): Promise<Result> {
  const { network, networkType, rpcUrl, maxRange } = chain;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  const child = Bun.spawn(["bun", "scripts/auditEventGaps.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME ?? "/tmp",
      NETWORK: network,
      AUDIT_NETWORK_TYPE: networkType,
      ...(maxRange ? { AUDIT_MAX_RANGE: maxRange, AUDIT_RANGE: maxRange } : {}),
      AUDIT_RPC_URL: rpcUrl,
      AUDIT_LAST_SECONDS: options.windowSeconds,
      PG_CONNECTION_STRING: options.pgConnectionString,
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

  const lines = parseLines(stdout);
  const summary = lines.find((line) => line.kind === "summary") as
    | Summary
    | undefined;
  if (!summary) {
    const outcome = deadline.aborted
      ? `timed out after ${Math.round(timeoutMs / 60_000)} minutes`
      : `exit ${code}`;
    return {
      network,
      ok: false,
      gap: false,
      error: checkError(outcome, stdout, stderr, options.redact),
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

/** One audit, retried once after `retrySeconds` when it fails without a verdict. */
export async function auditChain(
  chain: GapChain,
  options: AuditOptions,
  retrySeconds: number,
): Promise<Result> {
  let result = await auditOnce(chain, options);
  if (!result.ok && !result.gap) {
    await Bun.sleep(retrySeconds * 1_000);
    result = await auditOnce(chain, options);
  }
  return { ...result, network: chain.label };
}
