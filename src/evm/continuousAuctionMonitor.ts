/**
 * The parts of the ContinuousAuction monitor that need a chain: whether a
 * tenure had a block to execute in, and how much rent is claimable right now.
 * scripts/continuousAuctionMonitor.ts writes their results next to the
 * indexed events, where continuous_auction_pool_metrics reads them.
 */

export interface FoundBlock {
  number: bigint;
  time: bigint;
}

/**
 * The first block after `after` whose timestamp is at least `target`, or null
 * if even `head` is earlier. Block timestamps never decrease, so this probes
 * forward with a doubling step and then bisects: a few header reads whether
 * the chain makes one block every 12 seconds or ten every second.
 */
export async function findFirstBlockAtOrAfter(
  getTime: (block: bigint) => Promise<bigint>,
  after: bigint,
  head: bigint,
  target: bigint,
): Promise<FoundBlock | null> {
  if (head <= after) return null;
  const headTime = await getTime(head);
  if (headTime < target) return null;

  // Invariant: time(lo) < target <= time(hi), treating `after` as below target
  // (the tenure starts after the block that placed it).
  let lo = after;
  let hi = head;
  let hiTime = headTime;
  for (let step = 1n; lo + step < hi; step *= 2n) {
    const probe = lo + step;
    const time = await getTime(probe);
    if (time >= target) {
      hi = probe;
      hiTime = time;
      break;
    }
    lo = probe;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const time = await getTime(mid);
    if (time >= target) {
      hi = mid;
      hiTime = time;
    } else {
      lo = mid;
    }
  }
  return { number: hi, time: hiTime };
}

/** PositionId from its parts, as createPositionId in the contracts. */
export function createPositionId(salt: bigint, lower: number, upper: number) {
  const id =
    (BigInt.asUintN(192, salt) << 64n) |
    (BigInt.asUintN(32, BigInt(lower)) << 32n) |
    BigInt.asUintN(32, BigInt(upper));
  return `0x${id.toString(16).padStart(64, "0")}` as `0x${string}`;
}

export function toBytes32(value: bigint) {
  return `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;
}

export function toAddress(value: bigint) {
  return `0x${value.toString(16).padStart(40, "0")}` as `0x${string}`;
}

export type AlertSeverity = "page" | "warn";

/** 0 when nothing fires, 2 when only warnings do, 3 when anything pages. */
export function exitCodeFor(alerts: { severity: AlertSeverity }[]) {
  if (alerts.some((a) => a.severity === "page")) return 3;
  return alerts.length > 0 ? 2 : 0;
}
