import type { ChainAdapter, ChainHead, StreamBlock } from "./blockStream";
import { requireBlockInRange } from "./rpcRecords";

export function requireHeader(block: ChainHead | null, number: number): ChainHead {
  if (!block || block.number !== number || !Number.isFinite(block.timestamp.getTime())) {
    throw new Error(`Could not read valid block ${number}; refusing to advance the cursor`);
  }
  return block;
}

export function sameHash(a: string, b: string): boolean {
  return BigInt(a) === BigInt(b);
}

/** All calls use one provider. Fence a range, including pagination, with its end hash. */
export async function readSnapshot<T>(
  adapter: ChainAdapter<T>,
  plan: { from: number; to: number; head: ChainHead },
  cursor: { number: number; hash: string | null },
): Promise<{ blocks: StreamBlock<T>[]; fresh: StreamBlock<T>[]; anchor: ChainHead; cursorChanged: boolean }> {
  const anchor = requireHeader(
    plan.to === plan.head.number ? plan.head : await adapter.fetchBlock(plan.to),
    plan.to,
  );
  const blocks = await adapter.readRange(plan.from, plan.to, anchor.hash);
  validateRangeBlocks(blocks, plan.from, anchor);
  const fresh = blocks.filter(block => Number(block.header.blockNumber) > cursor.number);
  await adapter.completeFresh(fresh, anchor);

  // Resolve the cursor first and the end last. A reorg between these checks
  // also changes the end hash, so it cannot be committed as a single snapshot.
  const cursorBlock = cursor.hash === null ? null : requireHeader(
    await adapter.fetchBlock(cursor.number), cursor.number,
  );
  const end = requireHeader(await adapter.fetchBlock(anchor.number), anchor.number);
  if (!sameHash(anchor.hash, end.hash)) {
    throw new Error(`Block ${anchor.number} changed hash during the range read; retry the snapshot`);
  }
  return {
    blocks, fresh, anchor,
    cursorChanged: cursorBlock !== null && !sameHash(cursor.hash!, cursorBlock.hash),
  };
}

function validateRangeBlocks<T>(blocks: StreamBlock<T>[], from: number, anchor: ChainHead): void {
  let previous = from - 1;
  for (const block of blocks) {
    const number = Number(block.header.blockNumber);
    requireBlockInRange(number, from, anchor.number);
    if (number <= previous || block.logs.length === 0) {
      throw new Error("RPC range must contain ordered, distinct event-bearing blocks");
    }
    if (number === anchor.number && !sameHash(block.header.blockHash, anchor.hash)) {
      throw new Error(`Range events disagree with end block ${anchor.number}`);
    }
    previous = number;
  }
}
