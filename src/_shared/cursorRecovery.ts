import type { IndexerCursor } from "./dao";
import type { ChainAdapter } from "./blockStream";

/** Persisted blocks descending by height; a hashless final entry is the configured start boundary. */
export type LoadPreviousCursor = (before: number) => Promise<IndexerCursor | null>;

export async function commonStoredCursor<T>(
  adapter: ChainAdapter<T>,
  before: number,
  loadPrevious: LoadPreviousCursor = async () => null,
): Promise<IndexerCursor> {
  let candidate = await loadPrevious(before);
  while (candidate) {
    const number = Number(candidate.orderKey);
    if (!Number.isSafeInteger(number) || number < 0 || number >= before) {
      throw new Error("Recovery cursors must descend strictly");
    }
    const block = await adapter.fetchBlock(number);
    if (!block || block.number !== number) {
      throw new Error(`Could not verify recovery block ${number}`);
    }
    if (candidate.uniqueKey === undefined) return { orderKey: candidate.orderKey, uniqueKey: block.hash };
    if (BigInt(candidate.uniqueKey) === BigInt(block.hash)) {
      return candidate;
    }
    before = number;
    candidate = await loadPrevious(before);
  }
  // With no verified checkpoint, guessing a bounded rewind can retain an
  // arbitrarily old orphan. Rebuild from the beginning instead.
  return { orderKey: 0n };
}
