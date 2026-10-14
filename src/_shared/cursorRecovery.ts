import type { IndexerCursor } from "./dao";
import type { ChainAdapter, ChainHead } from "./blockStream";

/** Persisted blocks descending by height; a hashless final entry is the configured start boundary. */
export type LoadPreviousCursor = (
  before: number,
) => Promise<IndexerCursor | null>;

export async function commonStoredCursor<T>(
  adapter: ChainAdapter<T>,
  before: number,
  loadPrevious: LoadPreviousCursor = async () => null,
  finalized: ChainHead | null = null,
): Promise<IndexerCursor> {
  let candidate = await loadPrevious(before);
  let first = true;
  while (candidate) {
    const verified = await verifyCandidate(adapter, candidate, before);
    if (verified)
      return first
        ? await finalizedAbove(adapter, verified, before, finalized)
        : verified;
    first = false;
    before = Number(candidate.orderKey);
    candidate = await loadPrevious(before);
  }
  // With no verified checkpoint, guessing a bounded rewind can retain an
  // arbitrarily old orphan. Rebuild from the beginning instead.
  return { orderKey: 0n };
}

/** The candidate with its canonical hash, or null when it is no longer canonical. */
async function verifyCandidate<T>(
  adapter: ChainAdapter<T>,
  candidate: IndexerCursor,
  before: number,
): Promise<IndexerCursor | null> {
  const number = Number(candidate.orderKey);
  if (!Number.isSafeInteger(number) || number < 0 || number >= before) {
    throw new Error("Recovery cursors must descend strictly");
  }
  const block = await adapter.fetchBlock(number);
  if (!block || block.number !== number) {
    throw new Error(`Could not verify recovery block ${number}`);
  }
  if (candidate.uniqueKey === undefined)
    return { orderKey: candidate.orderKey, uniqueKey: block.hash };
  return BigInt(candidate.uniqueKey) === BigInt(block.hash) ? candidate : null;
}

/**
 * Lands on the finalized block instead of the newest stored one when nothing is
 * stored between them. On a chain whose last event is weeks old, the newest
 * stored block is weeks back, and rewinding to it replays every empty block
 * since: gnosis fell 33 days behind for a minute on 2026-10-12 (EKU-1622).
 * Only taken when the first stored candidate verified, so no orphaned row can
 * sit between the two; the finalized hash is re-read so a stale view cannot
 * land the cursor on a fork.
 */
async function finalizedAbove<T>(
  adapter: ChainAdapter<T>,
  verified: IndexerCursor,
  before: number,
  finalized: ChainHead | null,
): Promise<IndexerCursor> {
  if (
    !finalized ||
    finalized.number <= Number(verified.orderKey) ||
    finalized.number >= before
  ) {
    return verified;
  }
  const block = await adapter.fetchBlock(finalized.number);
  if (
    !block ||
    block.number !== finalized.number ||
    BigInt(block.hash) !== BigInt(finalized.hash)
  ) {
    return verified;
  }
  return { orderKey: BigInt(finalized.number), uniqueKey: finalized.hash };
}
