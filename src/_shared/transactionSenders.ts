import type { Hex } from "viem";

export interface BlockTransaction {
  transactionIndex: number;
  transactionHash: Hex;
}

/**
 * The transactions behind a block's events, once each, in index order.
 *
 * Two events naming one index with different hashes mean the events did not
 * come from one block, and are refused rather than attributed to either.
 */
export function distinctTransactions(
  events: readonly BlockTransaction[],
): BlockTransaction[] {
  const byIndex = new Map<number, BlockTransaction>();
  for (const { transactionIndex, transactionHash } of events) {
    const seen = byIndex.get(transactionIndex);
    if (!seen) {
      byIndex.set(transactionIndex, { transactionIndex, transactionHash });
    } else if (BigInt(seen.transactionHash) !== BigInt(transactionHash)) {
      throw new Error(
        `Transaction ${transactionIndex} is named by two hashes, ${seen.transactionHash} and ${transactionHash}`,
      );
    }
  }
  return [...byIndex.values()].sort(
    (a, b) => a.transactionIndex - b.transactionIndex,
  );
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
