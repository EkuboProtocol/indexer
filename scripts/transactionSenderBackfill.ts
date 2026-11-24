import type { Hex } from "viem";
import type { TransactionSender } from "../src/_shared/dao";
import {
  mapWithConcurrency,
  type BlockTransaction,
} from "../src/_shared/transactionSenders";

/** A transaction of a stored swap or position update with no sender yet. */
export interface MissingSenderRow {
  block_number: string;
  block_hash: string;
  transaction_index: number;
  transaction_hash: string;
}

export interface MissingSenderBlock {
  blockNumber: number;
  blockHash: Hex;
  transactions: BlockTransaction[];
}

export type FetchSenders = (
  blockHash: Hex,
  transactions: readonly BlockTransaction[],
) => Promise<TransactionSender[]>;

export interface BlockSenders {
  blockNumber: number;
  senders: TransactionSender[];
}

const hex32 = (value: string): Hex =>
  `0x${BigInt(value).toString(16).padStart(64, "0")}`;

/** Rows from the missing-senders query, one entry per block, newest first. */
export function groupByBlock(
  rows: readonly MissingSenderRow[],
): MissingSenderBlock[] {
  const blocks = new Map<number, MissingSenderBlock>();
  for (const row of rows) {
    const blockNumber = Number(row.block_number);
    let block = blocks.get(blockNumber);
    if (!block) {
      block = {
        blockNumber,
        blockHash: hex32(row.block_hash),
        transactions: [],
      };
      blocks.set(blockNumber, block);
    }
    block.transactions.push({
      transactionIndex: row.transaction_index,
      transactionHash: hex32(row.transaction_hash),
    });
  }
  return [...blocks.values()].sort((a, b) => b.blockNumber - a.blockNumber);
}

/** Reads the senders of every block, `concurrency` blocks at a time. */
export function fetchBlockSenders(
  blocks: readonly MissingSenderBlock[],
  fetchSenders: FetchSenders,
  concurrency: number,
): Promise<BlockSenders[]> {
  return mapWithConcurrency(blocks, concurrency, async (block) => ({
    blockNumber: block.blockNumber,
    senders: await fetchSenders(block.blockHash, block.transactions),
  }));
}

/** Column arrays for one `unnest` insert. */
export function toColumns(blocks: readonly BlockSenders[]): {
  blockNumbers: string[];
  transactionIndexes: number[];
  senders: string[];
} {
  const columns = {
    blockNumbers: [] as string[],
    transactionIndexes: [] as number[],
    senders: [] as string[],
  };
  for (const { blockNumber, senders } of blocks) {
    for (const { transactionIndex, sender } of senders) {
      columns.blockNumbers.push(String(blockNumber));
      columns.transactionIndexes.push(transactionIndex);
      columns.senders.push(BigInt(sender).toString());
    }
  }
  return columns;
}

/** Windows of `size` blocks from `to` down to `from`, both inclusive. */
export function* descendingWindows(
  from: number,
  to: number,
  size: number,
): Generator<{ from: number; to: number }> {
  for (let hi = to; hi >= from; hi -= size) {
    yield { from: Math.max(from, hi - size + 1), to: hi };
  }
}
